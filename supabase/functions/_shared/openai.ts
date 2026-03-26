import OpenAI from "npm:openai@4";
import { enrichEntities } from "./wikidata.ts";

export const openai = new OpenAI({ apiKey: Deno.env.get("OPEN_API_KEY")! });

export interface AnalysisResult {
  resposta: string;
  fontes: { arquivo: string }[];
  wikidata: Awaited<ReturnType<typeof enrichEntities>>;
}

export async function queryVectorStore(
  pergunta: string,
  instructions: string,
): Promise<AnalysisResult> {
  const vectorStoreId = Deno.env.get("VECTOR_STORE_ID")!;

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    instructions,
    input: pergunta,
    tools: [{ type: "file_search", vector_store_ids: [vectorStoreId] }],
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

  const wikidata = resposta ? await enrichWikidata(resposta) : [];

  return { resposta, fontes, wikidata };
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
