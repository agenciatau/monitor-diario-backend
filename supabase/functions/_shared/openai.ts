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
): Promise<{ id: string; date: string; filename: string } | null> {
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
      return { id: f.id, date, filename: f.filename };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  return matched.length > 0 ? matched[0] : null;
}

export async function searchVectorStore(
  pergunta: string,
  instructions: string,
  filters?: Record<string, unknown>,
): Promise<{ resposta: string; fontes: { arquivo: string }[]; model: string }> {
  const vectorStoreId = Deno.env.get("VECTOR_STORE_ID")!;
  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";

  // deno-lint-ignore no-explicit-any
  const fileSearchTool: any = {
    type: "file_search",
    vector_store_ids: [vectorStoreId],
    ...(filters ? { filters } : {}),
  };

  const response = await openai.responses.create({
    model,
    instructions,
    input: pergunta,
    tools: [fileSearchTool],
    include: ["file_search_call.results"] as string[],
  } as Parameters<typeof openai.responses.create>[0]);

  let resposta = "";
  const fontes: { arquivo: string }[] = [];
  const seenFiles = new Set<string>();

  const output = "output" in response ? response.output : [];

  for (const item of output) {
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
  const result = await openai.responses.create({
    model: "gpt-4o-mini",
    input: `Resuma o seguinte texto em 2 a 3 frases curtas e diretas:\n\n${resposta.slice(0, 3000)}`,
    max_output_tokens: 150,
    temperature: 0,
  });
  const text = result.output?.find((o: { type: string }) => o.type === "message")
    ?.content?.find((c: { type: string }) => c.type === "output_text")?.text ?? "";
  return text.trim();
}

export async function enrichWikidata(texto: string) {
  try {
    const extraction = await openai.responses.create({
      model: "gpt-4o-mini",
      input:
        "Liste apenas os nomes de pessoas, empresas e organizações mencionadas neste texto. " +
        "Máximo 5 itens, separados por vírgula, sem explicações adicionais. " +
        `Se não houver nenhum, responda com uma string vazia.\n\n${texto.slice(0, 1500)}`,
      max_output_tokens: 80,
      temperature: 0,
    });
    const raw = extraction.output?.find((o: { type: string }) => o.type === "message")
      ?.content?.find((c: { type: string }) => c.type === "output_text")?.text?.trim() ?? "";
    if (!raw) return [];
    const names = raw.split(",").map((n) => n.trim()).filter(Boolean);
    return enrichEntities(names);
  } catch {
    return [];
  }
}
