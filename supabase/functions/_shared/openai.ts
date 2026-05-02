import OpenAI from "openai";
import { marked } from "marked";
import { enrichEntities } from "./wikidata.ts";

export const openai = new OpenAI({ apiKey: Deno.env.get("OPEN_API_KEY")! });

export interface AnalysisResult {
  resposta: string;
  fontes: { arquivo: string }[];
  wikidata: Awaited<ReturnType<typeof enrichEntities>>;
}

function normalizeEstado(nome: string): string {
  return nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "_");
}

export async function getMostRecentFileId(
  estadoNome: string,
): Promise<{ id: string; date: string } | null> {
  const vectorStoreId = Deno.env.get("VECTOR_STORE_ID")!;

  const vsFiles = await openai.vectorStores.files.list(vectorStoreId, { limit: 100 });
  if (vsFiles.data.length === 0) return null;

  const fileDetails = await Promise.all(vsFiles.data.map((f) => openai.files.retrieve(f.id)));
  const prefix = normalizeEstado(estadoNome);

  const matched = fileDetails
    .filter((f) => f.filename.startsWith(prefix + "_"))
    .map((f) => {
      const dateMatch = f.filename.match(/_(\d{8})/);
      const date = dateMatch ? dateMatch[1] : "";
      return { id: f.id, date };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  return matched.length > 0 ? matched[0] : null;
}

export async function searchVectorStore(
  pergunta: string,
  instructions: string,
): Promise<{ resposta: string; fontes: { arquivo: string }[]; model: string }> {
  const vectorStoreId = Deno.env.get("VECTOR_STORE_ID")!;
  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";

  const response = await openai.responses.create({
    model,
    instructions,
    input: pergunta,
    tools: [{ type: "file_search", vector_store_ids: [vectorStoreId] } as Parameters<typeof openai.responses.create>[0]["tools"][0]],
    include: ["file_search_call.results"] as string[],
  } as Parameters<typeof openai.responses.create>[0]);

  let resposta = "";
  const fontes: { arquivo: string }[] = [];
  const seenFiles = new Set<string>();

  for (const item of response.output) {
    // file_search_call results contain the actual retrieved files
    if ((item as { type: string }).type === "file_search_call") {
      const call = item as { type: string; results?: { filename?: string; file_id?: string }[] };
      for (const result of call.results ?? []) {
        const filename = result.filename ?? result.file_id ?? "";
        if (filename && !seenFiles.has(filename)) {
          seenFiles.add(filename);
          fontes.push({ arquivo: filename });
        }
      }
    }
    if (item.type === "message") {
      for (const content of item.content) {
        if (content.type === "output_text") {
          resposta = content.text;
        }
      }
    }
  }

  const respostaHtml = marked(resposta) as string;
  return { resposta: respostaHtml, fontes, model };
}

export async function queryVectorStore(
  pergunta: string,
  instructions: string,
): Promise<AnalysisResult> {
  const { resposta, fontes } = await searchVectorStore(pergunta, instructions);
  const wikidata = resposta ? await enrichWikidata(resposta) : [];
  return { resposta, fontes, wikidata };
}


export async function generateResumo(resposta: string): Promise<string> {
  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{
      role: "user",
      content: `Resuma o seguinte texto em 2 a 3 frases curtas e diretas:\n\n${resposta.slice(0, 3000)}`,
    }],
    max_tokens: 150,
    temperature: 0,
  });
  return result.choices[0].message.content?.trim() ?? "";
}

async function enrichWikidata(texto: string) {
  try {
    const extraction = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{
        role: "user",
        content:
          "Liste apenas os nomes de pessoas, empresas e organizações mencionadas neste texto. " +
          "Máximo 5 itens, separados por vírgula, sem explicações adicionais. " +
          `Se não houver nenhum, responda com uma string vazia.\n\n${texto.slice(0, 1500)}`,
      }],
      max_tokens: 80,
      temperature: 0,
    });
    const raw = extraction.choices[0].message.content?.trim() ?? "";
    if (!raw) return [];
    const names = raw.split(",").map((n) => n.trim()).filter(Boolean);
    return enrichEntities(names);
  } catch {
    return [];
  }
}
