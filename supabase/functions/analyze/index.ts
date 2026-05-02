import { createClient } from "@supabase/supabase-js";
import { buildInstructions } from "../_shared/instructions.ts";
import { generateResumo, getMostRecentFileId, searchVectorStore } from "../_shared/openai.ts";

const MONITOR_SUPABASE_URL = Deno.env.get("MONITOR_SUPABASE_URL");
const MONITOR_SUPABASE_KEY = Deno.env.get("MONITOR_SUPABASE_KEY");
const SCRAPER_SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SCRAPER_SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY");

const ESTADO_NOMES: Record<string, string> = {
  AL: "Alagoas", BA: "Bahia", CE: "Ceará", MA: "Maranhão",
  PB: "Paraíba", PE: "Pernambuco", PI: "Piauí", RN: "Rio Grande do Norte",
  SE: "Sergipe",
};

const UF_TO_ESTADO: Record<string, string> = {
  AL: "alagoas", BA: "bahia", CE: "ceara", MA: "maranhao",
  PB: "paraiba", PE: "pernambuco", PI: "piaui",
  RN: "rio_grande_do_norte", SE: "sergipe",
};

function addDiarioLinks(html: string, urlDiario: string): string {
  // Match "Página X — Conferir trecho do Diário" or "Página X a Y — Conferir trecho do Diário"
  // PDF #page=N fragment opens the PDF at that page in most browsers/viewers
  return html.replace(
    /Página (\d+)(?: a \d+)? — Conferir trecho do Diário/g,
    (match, pagina) => {
      const href = `${urlDiario}#page=${pagina}`;
      return match.replace(
        "Conferir trecho do Diário",
        `<a href="${href}" target="_blank" rel="noopener noreferrer">Conferir trecho do Diário</a>`,
      );
    },
  );
}

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
  if (!MONITOR_SUPABASE_URL || !MONITOR_SUPABASE_KEY) {
    return new Response(JSON.stringify({ erro: "MONITOR_SUPABASE_URL/KEY não configurados" }), { status: 503 });
  }
  if (!SCRAPER_SUPABASE_URL || !SCRAPER_SUPABASE_KEY) {
    return new Response(JSON.stringify({ erro: "SUPABASE_URL/KEY não configurados" }), { status: 503 });
  }

  const monitorSupabase = createClient(MONITOR_SUPABASE_URL, MONITOR_SUPABASE_KEY);
  const scraperSupabase = createClient(SCRAPER_SUPABASE_URL, SCRAPER_SUPABASE_KEY);

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

    const dataFormatada = `${recentFile.date.slice(6, 8)}/${recentFile.date.slice(4, 6)}/${recentFile.date.slice(0, 4)}`;

    const pergunta =
      `Analise o PDF do Diário Oficial de ${estadoNome} (${uf}), do dia ${dataFormatada}, ` +
      `e identifique SOMENTE informações realmente relevantes relacionadas ao tema e palavras-chave definidos nas instruções.`;

    const { resposta, fontes, model } = await searchVectorStore(pergunta, instructions);

    // Keep only sources from the most recent date
    const recentFontes = fontes.filter((f) => f.arquivo.includes(recentFile.date));
    const fontesParaSalvar = recentFontes.length > 0 ? recentFontes : fontes.slice(0, 1);
    console.log(`[analyze] fontes filtradas: ${JSON.stringify(fontesParaSalvar)}, resposta length=${resposta.length}`);

    if (fontesParaSalvar.length === 0) {
      return new Response(
        JSON.stringify({ ignorado: "Nenhuma fonte encontrada no diário mais recente; análise não salva." }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    const resumo = await generateResumo(resposta);

    const estadoKey = UF_TO_ESTADO[uf] ?? uf.toLowerCase();
    const dataPub = `${recentFile.date.slice(0, 4)}-${recentFile.date.slice(4, 6)}-${recentFile.date.slice(6, 8)}`;
    const { data: diarioData, error: diarioError } = await scraperSupabase
      .from("diarios")
      .select("storage_url")
      .eq("estado", estadoKey)
      .eq("data_publicacao", dataPub)
      .order("criado_em", { ascending: false })
      .limit(1)
      .single();
    if (diarioError) console.warn(`[analyze] url_diario lookup failed:`, JSON.stringify(diarioError));
    const url_diario: string | null = diarioData?.storage_url ?? null;
    console.log(`[analyze] url_diario para ${estadoKey}/${dataPub}:`, url_diario);

    const respostaComLinks = url_diario ? addDiarioLinks(resposta, url_diario) : resposta;

    const { error: insertError } = await monitorSupabase.from("analises").insert({
      monitor_id: record.id ?? null,
      uf,
      resposta: respostaComLinks,
      fontes: fontesParaSalvar,
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
    return new Response(JSON.stringify({ resposta: respostaComLinks, resumo, fontes, wikidata: [], url_diario }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(`[analyze] erro inesperado:`, e);
    return new Response(JSON.stringify({ erro: `Erro: ${e}` }), { status: 502 });
  }
});
