import { createClient } from "@supabase/supabase-js";
import { buildInstructions } from "../_shared/instructions.ts";
import { generateResumo, getMostRecentFileId, searchVectorStore } from "../_shared/openai.ts";

const monitorSupabase = createClient(
  Deno.env.get("MONITOR_SUPABASE_URL")!,
  Deno.env.get("MONITOR_SUPABASE_KEY")!,
);

const scraperSupabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_KEY")!,
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
    const fileId = await getMostRecentFileId(estadoNome) ?? undefined;
    const { resposta, fontes, model } = await searchVectorStore(pergunta, instructions, fileId);

    const resumo = await generateResumo(resposta);

    let url_diario: string | null = null;
    if (fontes.length > 0) {
      const { data } = await scraperSupabase
        .from("diarios")
        .select("storage_url")
        .eq("arquivo_nome", fontes[0].arquivo)
        .single();
      url_diario = data?.storage_url ?? null;
    }

    await monitorSupabase.from("analises").insert({
      monitor_id: record.id ?? null,
      uf,
      resposta,
      fontes,
      wikidata: [],
      resumo,
      url_diario,
      model,
    });

    return new Response(JSON.stringify({ resposta, resumo, fontes, wikidata: [], url_diario }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ erro: `Erro: ${e}` }), { status: 502 });
  }
});
