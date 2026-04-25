import OpenAI from "npm:openai@4";
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

export async function getMostRecentFileId(estadoNome: string): Promise<string | null> {
  const vectorStoreId = Deno.env.get("VECTOR_STORE_ID")!;

  const vsFiles = await openai.beta.vectorStores.files.list(vectorStoreId, { limit: 100 });
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

  return matched.length > 0 ? matched[0].id : null;
}

export async function searchVectorStore(
  pergunta: string,
  instructions: string,
  fileId?: string,
): Promise<{ resposta: string; fontes: { arquivo: string }[] }> {
  const vectorStoreId = Deno.env.get("VECTOR_STORE_ID")!;

  const fileSearchTool: Record<string, unknown> = {
    type: "file_search",
    vector_store_ids: [vectorStoreId],
  };
  if (fileId) {
    fileSearchTool.filters = { type: "eq", key: "file_id", value: fileId };
  }

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    instructions,
    input: pergunta,
    tools: [fileSearchTool as Parameters<typeof openai.responses.create>[0]["tools"][0]],
  });

  let resposta = "";
  const fontes: { arquivo: string }[] = [];
  const seenFiles = new Set<string>();

  for (const item of response.output) {
    if (item.type === "message") {
      for (const content of item.content) {
        if (content.type === "output_text") {
          resposta = content.text;
          for (const annotation of (content as { annotations?: { type: string; filename: string }[] }).annotations ?? []) {
            if (annotation.type === "file_citation" && !seenFiles.has(annotation.filename)) {
              seenFiles.add(annotation.filename);
              fontes.push({ arquivo: annotation.filename });
            }
          }
        }
      }
    }
  }

  return { resposta, fontes };
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
