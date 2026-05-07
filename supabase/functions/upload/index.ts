import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: Deno.env.get("OPEN_API_KEY")! });

const STORAGE_BUCKET = "diarios-oficiais";

const VALID_ESTADOS = new Set([
  "alagoas", "bahia", "ceara", "maranhao", "paraiba",
  "pernambuco", "piaui", "rio_grande_do_norte", "sergipe",
]);

function hhmmss(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}${m}${s}`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ erro: "Method not allowed" }), { status: 405 });
  }

  const vectorStoreId = Deno.env.get("VECTOR_STORE_ID");
  const scraperUrl = Deno.env.get("SCRAPER_SUPABASE_URL")?.replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
  const scraperKey = Deno.env.get("SCRAPER_SUPABASE_KEY");

  if (!vectorStoreId) {
    return new Response(JSON.stringify({ erro: "VECTOR_STORE_ID não configurado" }), { status: 503 });
  }
  if (!scraperUrl || !scraperKey) {
    return new Response(JSON.stringify({ erro: "SCRAPER_SUPABASE_URL/KEY não configurados" }), { status: 503 });
  }

  const formData = await req.formData();
  const arquivo = formData.get("arquivo") as File | null;
  const estado = (formData.get("estado") as string | null)?.toLowerCase().trim();
  const date = (formData.get("date") as string | null)?.trim(); // expects YYYYMMDD

  if (!arquivo) {
    return new Response(JSON.stringify({ erro: "Campo 'arquivo' ausente" }), { status: 400 });
  }
  if (!estado || !VALID_ESTADOS.has(estado)) {
    return new Response(
      JSON.stringify({ erro: `Campo 'estado' ausente ou inválido. Valores aceitos: ${[...VALID_ESTADOS].join(", ")}` }),
      { status: 400 },
    );
  }
  if (!date || !/^\d{8}$/.test(date)) {
    return new Response(JSON.stringify({ erro: "Campo 'date' ausente ou inválido (esperado: YYYYMMDD)" }), { status: 400 });
  }

  const fileName = `${estado}_${date}_${hhmmss(new Date())}.pdf`;
  const storagePath = `${estado}/${fileName}`;
  const datePub = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;

  const supabase = createClient(scraperUrl, scraperKey);

  try {
    // 1. Upload to Supabase Storage
    const bytes = await arquivo.arrayBuffer();
    const { error: storageError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, bytes, { contentType: "application/pdf", upsert: false });
    if (storageError) {
      return new Response(JSON.stringify({ erro: `Erro no storage: ${storageError.message}` }), { status: 502 });
    }

    const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);

    // 2. Insert into diarios table
    const { error: dbError } = await supabase.from("diarios").insert({
      estado,
      data_publicacao: datePub,
      arquivo_nome: fileName,
      storage_url: urlData.publicUrl,
    });
    if (dbError) {
      return new Response(JSON.stringify({ erro: `Erro ao inserir no banco: ${dbError.message}` }), { status: 502 });
    }

    // 3. Upload to OpenAI with the canonical filename
    const file = new File([bytes], fileName, { type: "application/pdf" });
    const uploaded = await openai.files.create({ file, purpose: "assistants" });

    // 4. Add to vector store with state/date attributes
    // deno-lint-ignore no-explicit-any
    await (openai.vectorStores.files as any).create(vectorStoreId, {
      file_id: uploaded.id,
      attributes: { estado, date },
    });

    return new Response(
      JSON.stringify({
        mensagem: "Arquivo indexado com sucesso",
        arquivo_nome: fileName,
        storage_url: urlData.publicUrl,
        file_id: uploaded.id,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ erro: `Erro ao indexar arquivo: ${e}` }), { status: 502 });
  }
});
