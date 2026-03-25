import { createClient } from "npm:@supabase/supabase-js";
import { buildInstructions } from "../_shared/instructions.ts";
import { queryVectorStore } from "../_shared/openai.ts";

const monitorSupabase = createClient(
  Deno.env.get("MONITOR_SUPABASE_URL")!,
  Deno.env.get("MONITOR_SUPABASE_KEY")!,
);

const ESTADO_NOMES: Record<string, string> = {
  AL: "Alagoas", BA: "Bahia", CE: "Ceará", MA: "Maranhão",
  PB: "Paraíba", PE: "Pernambuco", PI: "Piauí", RN: "Rio Grande do Norte",
  SE: "Sergipe",
};

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ erro: "Method not allowed" }), { status: 405 });
  }

  const payload = await req.json();
  // Supabase webhook sends { type, table, record, schema, old_record }
  const record = payload.record ?? payload;

  const uf = (record.uf ?? "").toUpperCase().trim();
  if (!uf) {
    return new Response(JSON.stringify({ erro: "Campo 'uf' ausente" }), { status: 400 });
  }

  if (!Deno.env.get("VECTOR_STORE_ID")) {
    return new Response(JSON.stringify({ erro: "VECTOR_STORE_ID não configurado" }), { status: 503 });
  }

  const config = {
    descricao: record.description ?? null,
    palavras_chave: record.keywords ?? null,
  };
  const instructions = buildInstructions(config);

  const estadoNome = ESTADO_NOMES[uf] ?? uf;
  const keywords = Array.isArray(config.palavras_chave)
    ? config.palavras_chave.join(", ")
    : (config.palavras_chave ?? "");
  const pergunta =
    `Com base nos diários oficiais mais recentes de ${estadoNome}, ` +
    `faça uma análise completa identificando informações relevantes` +
    (keywords ? ` sobre: ${keywords}.` : ".");

  try {
    const result = await queryVectorStore(pergunta, instructions);

    await monitorSupabase.from("analises").insert({
      monitor_id: record.id ?? null,
      uf,
      resposta: result.resposta,
      fontes: result.fontes,
      wikidata: result.wikidata,
    });

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ erro: `Erro: ${e}` }), { status: 502 });
  }
});
