import { createClient } from "@supabase/supabase-js";
import { buildInstructions } from "../_shared/instructions.ts";
import { enrichWikidata, generateResumo, getMostRecentFileId, searchVectorStore } from "../_shared/openai.ts";

const MONITOR_SUPABASE_URL = Deno.env.get("MONITOR_SUPABASE_URL");
const MONITOR_SUPABASE_KEY = Deno.env.get("MONITOR_SUPABASE_KEY");
const SCRAPER_SUPABASE_URL = Deno.env.get("SCRAPER_SUPABASE_URL")?.replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
const SCRAPER_SUPABASE_KEY = Deno.env.get("SCRAPER_SUPABASE_KEY");

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
    return new Response(JSON.stringify({ erro: "SCRAPER_SUPABASE_URL/KEY não configurados" }), { status: 503 });
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

    // Only generate analysis for today's diário (Brazil timezone)
    const now = new Date();
    const brDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const todayStr = brDate.replace(/-/g, "");
    if (recentFile.date !== todayStr) {
      console.log(`[analyze] Diário mais recente para ${estadoNome} é de ${recentFile.date}, mas hoje é ${todayStr}. Ignorando.`);
      return new Response(
        JSON.stringify({ ignorado: `Não há diário de ${estadoNome} disponível para a data de hoje (${todayStr}). O mais recente é de ${recentFile.date}.` }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    const dataFormatada = `${recentFile.date.slice(6, 8)}/${recentFile.date.slice(4, 6)}/${recentFile.date.slice(0, 4)}`;
    const estadoKey = UF_TO_ESTADO[uf] ?? uf.toLowerCase();

    const pergunta =
      `Analise o PDF do Diário Oficial de ${estadoNome} (${uf}), do dia ${dataFormatada}, ` +
      `arquivo "${recentFile.filename}", ` +
      `e identifique SOMENTE informações realmente relevantes relacionadas ao tema e palavras-chave definidos nas instruções.`;

    // Filter vector store search to only this state's file for this specific date
    const filters = {
      type: "and",
      filters: [
        { type: "eq", key: "estado", value: estadoKey },
        { type: "eq", key: "date", value: recentFile.date },
      ],
    };

    const { resposta, fontes, model } = await searchVectorStore(pergunta, instructions, filters);
    console.log(`[analyze] fontes brutas: ${JSON.stringify(fontes)}`);

    // Keep only sources from the correct state (safety net)
    const fontesParaSalvar = fontes.filter(
      (f) => f.arquivo.startsWith(estadoKey + "_"),
    );
    console.log(`[analyze] fontes filtradas: ${JSON.stringify(fontesParaSalvar)}, resposta length=${resposta.length}`);

    if (fontesParaSalvar.length === 0) {
      return new Response(
        JSON.stringify({ ignorado: "Nenhuma fonte encontrada no diário mais recente; análise não salva." }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    const resumo = await generateResumo(resposta);

    // Strategy 1: match by exact arquivo_nome (most precise)
    let url_diario: string | null = null;
    const { data: d1, error: e1 } = await scraperSupabase
      .from("diarios")
      .select("storage_url")
      .eq("arquivo_nome", fontesParaSalvar[0].arquivo)
      .single();
    if (e1) console.warn(`[analyze] url_diario by arquivo_nome failed:`, JSON.stringify(e1));
    url_diario = d1?.storage_url ?? null;

    // Strategy 2: fallback — match by estado + date range (handles DATE and TIMESTAMP columns)
    if (!url_diario) {
      const datePub = recentFile.date;
      const dateStart = `${datePub.slice(0, 4)}-${datePub.slice(4, 6)}-${datePub.slice(6, 8)}`;
      const nextDay = new Date(`${dateStart}T00:00:00Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      const dateEnd = nextDay.toISOString().slice(0, 10);
      const { data: d2, error: e2 } = await scraperSupabase
        .from("diarios")
        .select("storage_url")
        .eq("estado", estadoKey)
        .gte("data_publicacao", dateStart)
        .lt("data_publicacao", dateEnd)
        .order("criado_em", { ascending: false })
        .limit(1)
        .single();
      if (e2) console.warn(`[analyze] url_diario by estado+date failed:`, JSON.stringify(e2));
      url_diario = d2?.storage_url ?? null;
    }
    console.log(`[analyze] url_diario:`, url_diario);

    const respostaComLinks = url_diario ? addDiarioLinks(resposta, url_diario) : resposta;
    const wikidata = await enrichWikidata(resposta);

    const { error: insertError } = await monitorSupabase.from("analises").insert({
      monitor_id: record.id ?? null,
      uf,
      resposta: respostaComLinks,
      fontes: fontesParaSalvar,
      wikidata,
      resumo,
      url_diario,
      model,
    });

    if (insertError) {
      console.error(`[analyze] insert error:`, JSON.stringify(insertError));
      return new Response(JSON.stringify({ erro: `Erro ao salvar análise: ${insertError.message}` }), { status: 500 });
    }

    console.log(`[analyze] analise salva com sucesso para monitor ${record.id} (${uf})`);
    return new Response(JSON.stringify({ resposta: respostaComLinks, resumo, fontes, wikidata, url_diario }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(`[analyze] erro inesperado:`, e);
    return new Response(JSON.stringify({ erro: `Erro: ${e}` }), { status: 502 });
  }
});
