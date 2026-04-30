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

  try {
    const recentFile = await getMostRecentFileId(estadoNome);
    console.log(`[analyze] getMostRecentFileId(${estadoNome}):`, JSON.stringify(recentFile));

    if (!recentFile) {
      return new Response(
        JSON.stringify({ ignorado: `Nenhum arquivo encontrado no vector store para ${estadoNome}.` }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    const fileId = recentFile.id;
    const dataFormatada = `${recentFile.date.slice(6, 8)}/${recentFile.date.slice(4, 6)}/${recentFile.date.slice(0, 4)}`;

    const pergunta =
      `Analise o PDF do Diário Oficial de ${estadoNome} (${uf}), do dia ${dataFormatada}, ` +
      `e identifique SOMENTE informações realmente relevantes relacionadas ao tema e palavras-chave definidos nas instruções.`;

    const { resposta, fontes, model } = await searchVectorStore(pergunta, instructions, fileId);
    console.log(`[analyze] searchVectorStore: fontes=${JSON.stringify(fontes)}, resposta length=${resposta.length}`);

    if (fontes.length === 0) {
      return new Response(
        JSON.stringify({ ignorado: "Nenhuma fonte encontrada no diário mais recente; análise não salva." }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    const resumo = await generateResumo(resposta);

    let url_diario: string | null = null;
    const { data: diarioData } = await scraperSupabase
      .from("diarios")
      .select("storage_url")
      .eq("arquivo_nome", fontes[0].arquivo)
      .single();
    url_diario = diarioData?.storage_url ?? null;

    const { error: insertError } = await monitorSupabase.from("analises").insert({
      monitor_id: record.id ?? null,
      uf,
      resposta,
      fontes,
      wikidata: [],
      resumo,
      url_diario,
      model,
    });

    if (insertError) {
      console.error(`[analyze] insert error:`, JSON.stringify(insertError));
      return new Response(JSON.stringify({ erro: `Erro ao salvar análise: ${insertError.message}` }), { status: 500 });
    }

    console.log(`[analyze] analise salva com sucesso para monitor ${record.id} (${uf})`);
    return new Response(JSON.stringify({ resposta, resumo, fontes, wikidata: [], url_diario }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(`[analyze] erro inesperado:`, e);
    return new Response(JSON.stringify({ erro: `Erro: ${e}` }), { status: 502 });
  }
});
