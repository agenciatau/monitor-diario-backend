/**
 * pdfs_scraper.ts — Deno TypeScript port of pdfs_scraper.py
 *
 * Run:
 *   deno run --allow-net --allow-read --allow-write --allow-env pdfs_scraper.ts
 *
 * Strategies:
 *   'date_pattern'    – generates URLs based on recent business days
 *   'date_pattern_pt' – date_pattern with Portuguese month names (Paraíba)
 *   'json_api'        – POST to DataTables JSON endpoint
 *   'json_api_get'    – GET JSON endpoint returning editions array (Alagoas)
 *   'dool'            – DOOL platform: public JSON edition list + legacy-hash download
 *   'scrape'          – scrape HTML listing page for PDF/download links
 *
 * Active states (Northeast Brazil):
 *   AL  json_api_get  https://diario.imprensaoficial.al.gov.br/apinova/api/editions/published
 *   BA  dool          https://dool.egba.ba.gov.br  (needs --unsafely-ignore-certificate-errors)
 *   CE  date_pattern  http://imagens.seplag.ce.gov.br/PDF/{date}/do{date}p01.pdf
 *   MA  date_pattern  https://diariooficial.ma.gov.br/download.php?arqv=1&arq=EX{date}
 *   PB  date_pt       https://auniao.pb.gov.br/servicos/doe/…
 *   PE  (unavailable) CEPE portal is login-gated; former public S3 bucket now private
 *   PI  json_api      https://www.diario.pi.gov.br/doe/Api/listardiarios.json
 *   RN  date_pattern  https://webdisk.diariooficial.rn.gov.br/Jornal/1{year}-{month}-{day}.pdf
 *   SE  dool          https://iose.se.gov.br  (valid TLS, no bypass)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { load as cheerio } from "cheerio";
import { join } from "@std/path";

// ── Environment ────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPEN_API_KEY");
const VECTOR_STORE_ID = Deno.env.get("VECTOR_STORE_ID");
const MONITOR_SUPABASE_URL = Deno.env.get("MONITOR_SUPABASE_URL");
const MONITOR_SUPABASE_KEY = Deno.env.get("MONITOR_SUPABASE_KEY");
const STORAGE_BUCKET = "diarios-oficiais";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const monitorSupabase = (MONITOR_SUPABASE_URL && MONITOR_SUPABASE_KEY)
  ? createClient(MONITOR_SUPABASE_URL, MONITOR_SUPABASE_KEY)
  : null;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; DiarioBot/1.0)" };

const ESTADO_TO_UF: Record<string, string> = {
  alagoas: "AL", bahia: "BA", ceara: "CE", maranhao: "MA",
  paraiba: "PB", pernambuco: "PE", piaui: "PI",
  rio_grande_do_norte: "RN", sergipe: "SE",
};

// ── Types ──────────────────────────────────────────────────────────────────

type Strategy = "scrape" | "date_pattern" | "date_pattern_pt" | "id_range" | "json_api" | "json_api_get" | "dool";

interface SiteConfig {
  strategy: Strategy;
  url_lista?: string;
  selector?: string;
  url_pattern?: string;
  days_back?: number;
  id_start?: number;
  id_count?: number;
  api_url?: string;
  api_base_url?: string;
  base_url?: string;
}

// ── Sites ──────────────────────────────────────────────────────────────────

const sites: Record<string, SiteConfig> = {
  alagoas: {
    strategy: "json_api_get",
    api_url: "https://diario.imprensaoficial.al.gov.br/apinova/api/editions/published?page=1",
    api_base_url: "https://diario.imprensaoficial.al.gov.br/apinova/api/editions/downloadPdf/",
  },
  bahia: {
    // DOOL platform — public JSON edition list + legacy-hash download endpoint.
    // Note: SSL cert is bypassed via --unsafely-ignore-certificate-errors=dool.egba.ba.gov.br
    strategy: "dool",
    base_url: "https://dool.egba.ba.gov.br",
  },
  ceara: {
    // Direct date-based URL — imagens.seplag.ce.gov.br serves PDFs by date
    strategy: "date_pattern",
    url_pattern: "http://imagens.seplag.ce.gov.br/PDF/{date}/do{date}p01.pdf",
    days_back: 15,
  },
  maranhao: {
    // DOEMA direct download by date — EX = Executivo caderno, arqv=1 = volume 1
    strategy: "date_pattern",
    url_pattern: "https://diariooficial.ma.gov.br/download.php?arqv=1&arq=EX{date}",
    days_back: 15,
  },
  paraiba: {
    // Direct date-based URLs — no scraping needed
    strategy: "date_pattern_pt",
    days_back: 10,
  },
  pernambuco: {
    // Public S3 bucket — direct date-based access
    strategy: "date_pattern",
    url_pattern:
      "https://cepebr-prod.s3.amazonaws.com/1/cadernos/{year}/{date}/1-PoderExecutivo/PoderExecutivo({date}).pdf",
    days_back: 15,
  },
  piaui: {
    // DataTables JSON API — POST to /doe/Api/listardiarios.json
    strategy: "json_api",
    api_url: "https://www.diario.pi.gov.br/doe/Api/listardiarios.json",
    api_base_url: "https://www.diario.pi.gov.br/doe/",
  },
  rio_grande_do_norte: {
    // Direct date-based URL — prefix "1" + 4-digit year + "-MM-DD"
    strategy: "date_pattern",
    url_pattern: "https://webdisk.diariooficial.rn.gov.br/Jornal/1{year}-{month}-{day}.pdf",
    days_back: 15,
  },
  sergipe: {
    // IOSE (Imprensa Oficial de Sergipe) — same DOOL platform as Bahia:
    // public JSON edition list + legacy-hash download endpoint. Valid TLS, no bypass needed.
    strategy: "dool",
    base_url: "https://iose.se.gov.br",
  },
};

// ── Date helpers ───────────────────────────────────────────────────────────

function yyyymmdd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}

function hhmmss(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}${m}${s}`;
}

function* recentBusinessDays(n: number): Generator<Date> {
  const d = new Date();
  let yielded = 0;
  let attempts = 0;
  // Include today first if it's a weekday
  if (d.getDay() !== 0 && d.getDay() !== 6) {
    yield new Date(d);
    yielded++;
  }
  while (yielded < n && attempts < n * 3) {
    attempts++;
    d.setDate(d.getDate() - 1);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    yield new Date(d);
    yielded++;
  }
}

function extractDateFromUrl(url: string): string | null {
  if (!url) return null;
  // Direct 8-digit date (YYYYMMDD)
  for (const pat of [
    /[/_-](\d{8})[/_.-]/,
    /(\d{8})\.pdf/i,
    /[=(](\d{8})[).]/,
  ]) {
    const m = url.match(pat);
    if (m) {
      const s = m[1];
      const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
      if (!isNaN(d.getTime())) return s;
    }
  }
  // YYYY/MM/DD or YYYY-MM-DD
  const iso = url.match(/\b(\d{4})[/_-](\d{2})[/_-](\d{2})\b/);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}`);
    if (!isNaN(d.getTime())) return yyyymmdd(d);
  }
  // DD-MM-YYYY or DD/MM/YYYY (Brazilian)
  const br = url.match(/\b(\d{2})[-/](\d{2})[-/](\d{4})\b/);
  if (br) {
    const d = new Date(`${br[3]}-${br[2]}-${br[1]}`);
    if (!isNaN(d.getTime())) return yyyymmdd(d);
  }
  return null;
}

function extractDateFromHeaders(headers: Headers): string | null {
  const cd = headers.get("Content-Disposition") ?? "";
  if (cd) {
    const m8 = cd.match(/(\d{8})/);
    if (m8) {
      const d = new Date(
        `${m8[1].slice(0, 4)}-${m8[1].slice(4, 6)}-${m8[1].slice(6, 8)}`,
      );
      if (!isNaN(d.getTime())) return m8[1];
    }
    const mbr = cd.match(/(\d{2})[._-](\d{2})[._-](\d{4})/);
    if (mbr) {
      const d = new Date(`${mbr[3]}-${mbr[2]}-${mbr[1]}`);
      if (!isNaN(d.getTime())) return yyyymmdd(d);
    }
  }
  const lm = headers.get("Last-Modified") ?? "";
  if (lm) {
    const d = new Date(lm);
    if (!isNaN(d.getTime())) return yyyymmdd(d);
  }
  return null;
}

/**
 * Lightweight PDF text detection using raw bytes.
 *
 * PDF content streams are typically FlateDecode-compressed, so BT/ET operators
 * are not visible in raw bytes. Instead we check for /Font resource references
 * in the uncompressed object header section — any text-layer PDF must declare
 * at least one font. Image-only (scanned) PDFs have no /Font entries.
 *
 * We scan the full file because large gazettes (e.g. Pernambuco ~6 MB) can
 * have font declarations well past the first few hundred kilobytes.
 */
function pdfHasText(data: Uint8Array): boolean {
  const text = new TextDecoder("latin1").decode(data);
  return /\/Font\b/.test(text);
}

/**
 * Attempts to extract a date from raw PDF bytes (metadata or first-page text).
 * Returns YYYYMMDD string or null.
 */
function extractDateFromPdfBytes(data: Uint8Array): string | null {
  const chunk = data.slice(0, 20000);
  const text = new TextDecoder("latin1").decode(chunk);
  // PDF metadata: D:YYYYMMDD
  const meta = text.match(/D:(\d{8})/);
  if (meta) {
    const d = new Date(
      `${meta[1].slice(0, 4)}-${meta[1].slice(4, 6)}-${meta[1].slice(6, 8)}`,
    );
    if (!isNaN(d.getTime())) return meta[1];
  }
  // Brazilian date DD/MM/YYYY in first page text
  const br = text.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if (br) {
    const d = new Date(`${br[3]}-${br[2]}-${br[1]}`);
    if (!isNaN(d.getTime())) return yyyymmdd(d);
  }
  return null;
}

// ── URL generators ─────────────────────────────────────────────────────────

/** Replaces {date}, {year}, {month}, {day} tokens in a URL pattern. */
function applyDateTokens(pattern: string, d: Date): string {
  return pattern
    .replaceAll("{date}", yyyymmdd(d))
    .replaceAll("{year}", String(d.getFullYear()))
    .replaceAll("{month}", String(d.getMonth() + 1).padStart(2, "0"))
    .replaceAll("{day}", String(d.getDate()).padStart(2, "0"));
}

function generateDatePatternUrls(
  pattern: string,
  daysBack: number,
): [string, string][] {
  const results: [string, string][] = [];
  for (const d of recentBusinessDays(daysBack)) {
    results.push([applyDateTokens(pattern, d), yyyymmdd(d)]);
  }
  return results;
}

const PT_MONTHS = [
  "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/**
 * Paraíba — direct PDF URL constructed from date.
 * Pattern: https://auniao.pb.gov.br/servicos/doe/{yearFolder}/{monthPt}/diario-oficial-{DD-MM-YYYY}-portal.pdf
 *
 * Note: 2025 used "2025-1" as the year folder. We try the plain year first
 * and fall back to "{year}-1" if needed (handled in the download stage).
 */
function generateParaibaUrls(daysBack: number): [string, string][] {
  const results: [string, string][] = [];
  for (const d of recentBusinessDays(daysBack)) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const monthPt = PT_MONTHS[d.getMonth()];
    const dateStr = yyyymmdd(d);
    const base = `https://auniao.pb.gov.br/servicos/doe/${year}/${monthPt}/diario-oficial-${day}-${month}-${year}-portal.pdf`;
    results.push([base, dateStr]);
    // Fallback variant with year folder suffix (e.g., "2025-1")
    const fallback = `https://auniao.pb.gov.br/servicos/doe/${year}-1/${monthPt}/diario-oficial-${day}-${month}-${year}-portal.pdf`;
    results.push([fallback, dateStr]);
  }
  return results;
}

function generateIdRangeUrls(
  pattern: string,
  idStart: number,
  idCount: number,
): [string, null][] {
  const results: [string, null][] = [];
  for (let i = idStart + idCount - 1; i >= idStart; i--) {
    results.push([pattern.replace("{id}", String(i)), null]);
  }
  return results;
}

// ── Link collection ────────────────────────────────────────────────────────

async function collectJsonApiLinks(
  config: SiteConfig,
): Promise<[string, string | null][]> {
  const { api_url, api_base_url } = config;
  try {
    const resp = await fetch(api_url!, {
      method: "POST",
      headers: {
        ...HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": api_base_url!,
      },
      body: "filter_numero=&filter_data=&draw=1&start=0&length=20",
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const results: [string, string | null][] = [];
    for (const row of json.data ?? []) {
      const html: string = row[0] ?? "";
      const dateStr: string = row[2] ?? ""; // "DD/MM/YYYY"
      const hrefMatch = html.match(/href="([^"]+\.pdf[^"]*)"/i);
      if (!hrefMatch) continue;
      const absUrl = new URL(hrefMatch[1], api_base_url).href;
      const dateParts = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      const date = dateParts ? `${dateParts[3]}${dateParts[2]}${dateParts[1]}` : null;
      results.push([absUrl, date]);
    }
    return results;
  } catch (e) {
    console.error(`  Erro ao acessar API ${api_url}: ${e}`);
    return [];
  }
}

async function collectJsonApiGetLinks(
  config: SiteConfig,
): Promise<[string, string | null][]> {
  const { api_url, api_base_url } = config;
  try {
    const resp = await fetch(api_url!, {
      headers: HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const results: [string, string | null][] = [];
    for (const edition of json.editions ?? []) {
      const pubDateStr: string = edition.publication_date ?? "";
      if (!pubDateStr) continue;
      const pubDate = new Date(pubDateStr.replace("Z", "+00:00"));
      if (isNaN(pubDate.getTime())) continue;
      const date = yyyymmdd(pubDate);
      const pdfUrl = `${api_base_url}${edition.id}`;
      results.push([pdfUrl, date]);
    }
    return results;
  } catch (e) {
    console.error(`  Erro ao acessar API ${api_url}: ${e}`);
    return [];
  }
}

/**
 * DOOL platform (Bahia EGBA, Sergipe IOSE) — fetch recent editions via public
 * JSON API and build download URLs.
 *
 * The public endpoint /apifront/portal/edicoes/ultimas_edicoes.json returns
 * recent edition IDs and dates without authentication.
 *
 * The legacy /web_api/edicoes/download/{ID}?hash=...&hash_date=... endpoint
 * serves PDFs publicly; the hash parameter is no longer validated server-side
 * (legacy bypass — any fixed hash/date value works).
 *
 * Bahia (dool.egba.ba.gov.br) needs an external SSL bypass:
 *   --unsafely-ignore-certificate-errors=dool.egba.ba.gov.br
 * Sergipe (iose.se.gov.br) has a valid certificate and needs no bypass.
 */
async function collectDoolLinks(
  config: SiteConfig,
): Promise<[string, string | null][]> {
  const baseUrl = config.base_url!;
  // Legacy hash params — server no longer validates these
  const LEGACY_HASH = "5094ed62b9b84af21a14e8fc2353079934637ab6";
  const LEGACY_DATE = "2022-01-12T10:00:05-0300";

  try {
    const resp = await fetch(`${baseUrl}/apifront/portal/edicoes/ultimas_edicoes.json`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();

    const results: [string, string | null][] = [];
    for (const item of json.itens ?? []) {
      const id: string = item.id ?? "";
      const rawDate: string = item.data ?? ""; // "DD/MM/YYYY"
      if (!id) continue;

      const dateParts = rawDate.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      const date = dateParts ? `${dateParts[3]}${dateParts[2]}${dateParts[1]}` : null;

      const url = `${baseUrl}/web_api/edicoes/download/${id}?hash=${LEGACY_HASH}&hash_date=${encodeURIComponent(LEGACY_DATE)}`;
      results.push([url, date]);
    }
    return results;
  } catch (e) {
    console.error(`  DOOL (${baseUrl}): Erro ao acessar ultimas_edicoes.json: ${e}`);
    return [];
  }
}

async function collectLinks(
  config: SiteConfig,
): Promise<[string, string | null][]> {
  const { strategy } = config;

  if (strategy === "date_pattern") {
    return generateDatePatternUrls(config.url_pattern!, config.days_back!);
  }
  if (strategy === "date_pattern_pt") {
    return generateParaibaUrls(config.days_back!);
  }
  if (strategy === "json_api") {
    return collectJsonApiLinks(config);
  }
  if (strategy === "json_api_get") {
    return collectJsonApiGetLinks(config);
  }
  if (strategy === "dool") {
    return collectDoolLinks(config);
  }
  if (strategy === "id_range") {
    return generateIdRangeUrls(
      config.url_pattern!,
      config.id_start!,
      config.id_count!,
    );
  }

  // strategy === "scrape"
  const listUrl = config.url_lista!;
  const selector = config.selector!;
  try {
    const resp = await fetch(listUrl, {
      headers: HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();
    const $ = cheerio(html);
    const results: [string, string | null][] = [];
    $(selector).each((_, el) => {
      const href = $(el).attr("href") ?? "";
      if (!href) return;
      const absolute = new URL(href, listUrl).href;
      const isPdf = absolute.toLowerCase().endsWith(".pdf");
      const isDownload = absolute.includes("/download/");
      if (!isPdf && !isDownload) return;
      // Reject static assets (themes, tutorial images, etc.)
      if (/\/(theme|img|assets|template|static)\//i.test(absolute)) return;
      // Reject placeholder download IDs (e.g., /download/0)
      if (/\/download\/0(\/|$)/.test(absolute)) return;
      results.push([absolute, extractDateFromUrl(absolute)]);
    });
    return results;
  } catch (e) {
    console.error(`  Erro ao acessar ${listUrl}: ${e}`);
    return [];
  }
}

// ── Download ───────────────────────────────────────────────────────────────

async function downloadPdf(
  url: string,
  destPath: string,
): Promise<{ ok: boolean; headers: Headers; finalUrl: string; data: Uint8Array }> {
  try {
    const resp = await fetch(url, {
      headers: HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = new Uint8Array(await resp.arrayBuffer());
    await Deno.writeFile(destPath, data);
    return { ok: true, headers: resp.headers, finalUrl: resp.url, data };
  } catch (e) {
    console.error(`  Erro ao baixar ${url}: ${e}`);
    return { ok: false, headers: new Headers(), finalUrl: url, data: new Uint8Array() };
  }
}

// ── Supabase upload ────────────────────────────────────────────────────────

async function saveToSupabase(
  localPath: string,
  estado: string,
  datePub: string,
  fileName: string,
): Promise<boolean> {
  const storagePath = `${estado}/${fileName}`;
  try {
    const fileData = await Deno.readFile(localPath);
    await supabase.storage.from(STORAGE_BUCKET).upload(storagePath, fileData, {
      contentType: "application/pdf",
      upsert: true,
    });
    const { data: urlData } = supabase.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(storagePath);
    const { error } = await supabase.from("diarios").insert({
      estado,
      data_publicacao: `${datePub.slice(0, 4)}-${datePub.slice(4, 6)}-${datePub.slice(6, 8)}`,
      arquivo_nome: fileName,
      storage_url: urlData.publicUrl,
    });
    if (error) {
      console.error(`  Erro ao inserir no banco (${fileName}): ${error.message}`);
      return false;
    }
    console.log(`  ↑ Supabase: ${storagePath}`);
    return true;
  } catch (e) {
    console.error(`  Erro ao salvar no Supabase (${fileName}): ${e}`);
    return false;
  }
}

// ── OpenAI Vector Store upload ─────────────────────────────────────────────

async function sendToVectorStore(
  localPath: string,
  fileName: string,
  estado: string,
  datePub: string,
): Promise<void> {
  if (!openai || !VECTOR_STORE_ID) {
    console.log(
      "  ⚠ OPEN_API_KEY ou VECTOR_STORE_ID não configurados — upload OpenAI ignorado.",
    );
    return;
  }
  try {
    const fileData = await Deno.readFile(localPath);
    const blob = new Blob([fileData], { type: "application/pdf" });
    const file = new File([blob], fileName, { type: "application/pdf" });
    const uploaded = await openai.files.create({
      file,
      purpose: "assistants",
    });
    // Add file to vector store with estado/date attributes for filtered search
    // deno-lint-ignore no-explicit-any
    await (openai.vectorStores.files as any).create(VECTOR_STORE_ID, {
      file_id: uploaded.id,
      attributes: { estado, date: datePub },
    });
    console.log(
      `  ↑ OpenAI Vector Store: ${fileName} (file_id=${uploaded.id}, estado=${estado})`,
    );
  } catch (e) {
    console.error(`  Erro ao enviar para OpenAI (${fileName}): ${e}`);
  }
}

// ── Analysis trigger ───────────────────────────────────────────────────────

async function triggerAnalysisForStates(states: Set<string>): Promise<void> {
  if (!monitorSupabase) {
    console.log("\n⚠ MONITOR_SUPABASE não configurado — análises não serão disparadas.");
    return;
  }
  if (states.size === 0) return;

  const analyzeUrl = `${MONITOR_SUPABASE_URL}/functions/v1/analyze`;
  console.log(`\n=== DISPARANDO ANÁLISES para ${states.size} estado(s) ===`);

  for (const estado of states) {
    const uf = ESTADO_TO_UF[estado];
    if (!uf) continue;

    const { data: monitors, error } = await monitorSupabase
      .from("monitores")
      .select("*")
      .eq("uf", uf)
      .eq("is_active", true);

    if (error) {
      console.error(`  Erro ao buscar monitores para ${uf}: ${error.message}`);
      continue;
    }
    if (!monitors?.length) {
      console.log(`  ${uf}: nenhum monitor ativo`);
      continue;
    }

    console.log(`  ${uf}: ${monitors.length} monitor(es) ativo(s)`);
    for (const monitor of monitors) {
      console.log(`    → Monitor ${monitor.id}...`);
      try {
        const resp = await fetch(analyzeUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${MONITOR_SUPABASE_KEY}`,
          },
          body: JSON.stringify({ record: monitor }),
          signal: AbortSignal.timeout(180_000),
        });
        const result = await resp.json();
        if (result.ignorado) {
          console.log(`    ✗ ${result.ignorado}`);
        } else if (result.erro) {
          console.error(`    ✗ Erro: ${result.erro}`);
        } else {
          console.log(`    ✓ Análise salva (${String(result.resumo ?? "").slice(0, 80)})`);
        }
      } catch (e) {
        console.error(`    Erro ao chamar analyze para monitor ${monitor.id}: ${e}`);
      }
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const TARGET = 27; // ~3 PDFs per state × 9 states
  const MAX_PER_STATE = 3;
  const DOWNLOAD_DIR = "diarios_oficiais";

  await Deno.mkdir(DOWNLOAD_DIR, { recursive: true });

  let totalDownloaded = 0;
  const statesWithNewDiarios = new Set<string>();

  // Load already-saved filenames from DB so we skip re-processing across runs
  const { data: existingDiarios } = await supabase
    .from("diarios")
    .select("arquivo_nome");
  const usedNames = new Set<string>(
    (existingDiarios ?? []).map((d: { arquivo_nome: string }) => d.arquivo_nome),
  );


  // Shuffle states for variety
  const estados = Object.keys(sites).sort(() => Math.random() - 0.5);
  console.log(`Estados: ${estados.join(", ")}`);

  for (const estado of estados) {
    if (totalDownloaded >= TARGET) break;

    console.log(`\n=== ${estado.toUpperCase()} ===`);
    const links = await collectLinks(sites[estado]);

    if (links.length === 0) {
      console.log("  Nenhum link encontrado.");
      continue;
    }

    let stateCount = 0;
    // Track seen URLs to skip duplicates from Paraíba fallbacks
    const seenUrls = new Set<string>();

    for (const [url, knownDate] of links) {
      if (totalDownloaded >= TARGET || stateCount >= MAX_PER_STATE) break;
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);

      // Skip early if we already have a file for this state+date
      if (knownDate) {
        const prefix = `${estado}_${knownDate}`;
        const alreadySaved = [...usedNames].some((n) => n.startsWith(prefix));
        if (alreadySaved) {
          console.log(`  Já existe: ${prefix} — ignorado.`);
          continue;
        }
      }

      const tmpPath = join(DOWNLOAD_DIR, `_tmp_${estado}_${Date.now()}.pdf`);
      console.log(`  Baixando ${url} ...`);
      const { ok, headers, finalUrl, data } = await downloadPdf(url, tmpPath);

      if (!ok) {
        await sleep(1000);
        continue;
      }

      if (!pdfHasText(data)) {
        await Deno.remove(tmpPath);
        console.log("  Descartado (sem camada de texto).");
        await sleep(1000);
        continue;
      }

      // Resolve publication date — cascade through available sources
      const date =
        knownDate ??
        extractDateFromUrl(finalUrl) ??
        extractDateFromUrl(url) ??
        extractDateFromHeaders(headers) ??
        extractDateFromPdfBytes(data) ??
        yyyymmdd(new Date());

      // Timestamp-based filename: unique even when multiple diarios are published the same day
      const fileName = `${estado}_${date}_${hhmmss(new Date())}.pdf`;

      const finalPath = join(DOWNLOAD_DIR, fileName);
      await Deno.rename(tmpPath, finalPath);
      usedNames.add(fileName);

      const isNew = await saveToSupabase(finalPath, estado, date, fileName);
      if (!isNew) {
        await sleep(1000);
        continue;
      }

      await sendToVectorStore(finalPath, fileName, estado, date);

      totalDownloaded++;
      stateCount++;

      // Only trigger analysis for diários published today
      const today = yyyymmdd(new Date());
      if (date === today) {
        statesWithNewDiarios.add(estado);
        console.log(`  ✓ Salvo: ${fileName}  (${totalDownloaded}/${TARGET})`);
      } else {
        console.log(`  ✓ Salvo: ${fileName}  (${totalDownloaded}/${TARGET}) — análise não disparada (data ${date} ≠ hoje ${today})`);
      }

      await sleep(1000);
    }
  }

  console.log(
    `\nConcluído. ${totalDownloaded} PDFs textuais salvos em '${DOWNLOAD_DIR}'.`,
  );

  await triggerAnalysisForStates(statesWithNewDiarios);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.main) {
  await main();
}
