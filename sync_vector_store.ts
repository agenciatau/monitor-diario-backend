/**
 * sync_vector_store.ts
 * Uploads to OpenAI vector store any files that are in the diarios table
 * but missing from the vector store.
 *
 * Run:
 *   deno run --allow-net --allow-read --allow-env sync_vector_store.ts
 */

import "npm:dotenv/config";
import { createClient } from "npm:@supabase/supabase-js@2";
import OpenAI from "npm:openai@4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPEN_API_KEY")!;
const VECTOR_STORE_ID = Deno.env.get("VECTOR_STORE_ID")!;
const STORAGE_BUCKET = "diarios-oficiais";
const CONCURRENCY = 5;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function getVectorStoreFileNames(): Promise<Set<string>> {
  const names = new Set<string>();
  let hasMore = true;
  let after: string | undefined;

  while (hasMore) {
    const page = await openai.vectorStores.files.list(VECTOR_STORE_ID, {
      limit: 100,
      ...(after ? { after } : {}),
    });
    const details = await Promise.all(page.data.map((f) => openai.files.retrieve(f.id)));
    for (const f of details) names.add(f.filename);
    hasMore = page.has_more;
    after = page.data.at(-1)?.id;
  }

  console.log(`Vector store has ${names.size} files.`);
  return names;
}

async function getDbFileNames(): Promise<{ arquivo_nome: string; estado: string }[]> {
  const { data, error } = await supabase.from("diarios").select("arquivo_nome, estado");
  if (error) throw new Error(`DB error: ${error.message}`);
  return data ?? [];
}

async function uploadFileToOpenAI(estado: string, fileName: string): Promise<string | null> {
  const storagePath = `${estado}/${fileName}`;
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(storagePath);

  if (error || !data) {
    console.error(`  x Failed to download ${storagePath}: ${error?.message}`);
    return null;
  }

  const file = new File([data], fileName, { type: "application/pdf" });
  const uploaded = await openai.files.create({ file, purpose: "assistants" });

  // Add to vector store with attributes for filtered search
  const dateMatch = fileName.match(/_(\d{8})/);
  const date = dateMatch ? dateMatch[1] : "";
  // deno-lint-ignore no-explicit-any
  await (openai.vectorStores.files as any).create(VECTOR_STORE_ID, {
    file_id: uploaded.id,
    attributes: { estado, date },
  });
  console.log(`  ^ Uploaded to OpenAI: ${fileName} (${uploaded.id}, estado=${estado})`);
  return uploaded.id;
}

async function pLimit<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

async function main() {
  const vsNames = await getVectorStoreFileNames();
  const dbFiles = await getDbFileNames();

  const missing = dbFiles.filter((f) => !vsNames.has(f.arquivo_nome));
  console.log(`\nMissing from vector store: ${missing.length} file(s)`);
  if (missing.length === 0) { console.log("Nothing to sync."); return; }

  console.log(`\nUploading ${missing.length} files to OpenAI (${CONCURRENCY} parallel)...`);
  const tasks = missing.map(({ arquivo_nome, estado }) =>
    () => uploadFileToOpenAI(estado, arquivo_nome)
  );
  const fileIds = (await pLimit(tasks, CONCURRENCY)).filter((id): id is string => id !== null);

  console.log(`\n${fileIds.length}/${missing.length} uploaded and added to vector store with attributes.`);
  console.log("\nSync complete.");
}

await main();
