/**
 * migrate_vector_store_attributes.ts
 * One-time script: adds estado/date attributes to existing vector store files.
 *
 * Run:
 *   deno run --allow-net --allow-read --allow-env migrate_vector_store_attributes.ts
 */

import "npm:dotenv/config";
import OpenAI from "npm:openai@4";

const OPENAI_API_KEY = Deno.env.get("OPEN_API_KEY")!;
const VECTOR_STORE_ID = Deno.env.get("VECTOR_STORE_ID")!;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function main() {
  console.log("Listing vector store files...");

  const allFiles: { id: string; filename: string }[] = [];
  let hasMore = true;
  let after: string | undefined;

  while (hasMore) {
    const page = await openai.vectorStores.files.list(VECTOR_STORE_ID, {
      limit: 100,
      ...(after ? { after } : {}),
    });
    const details = await Promise.all(
      page.data.map(async (f) => {
        const file = await openai.files.retrieve(f.id);
        return { id: f.id, filename: file.filename };
      }),
    );
    allFiles.push(...details);
    hasMore = page.has_more;
    after = page.data.at(-1)?.id;
  }

  console.log(`Found ${allFiles.length} files in vector store.`);

  let updated = 0;
  let skipped = 0;

  for (const file of allFiles) {
    // Filename format: estado_YYYYMMDD_HHMMSS.pdf
    const match = file.filename.match(/^([a-z_]+)_(\d{8})/);
    if (!match) {
      console.log(`  ? Skipping (no estado/date pattern): ${file.filename}`);
      skipped++;
      continue;
    }

    const estado = match[1];
    const date = match[2];

    try {
      // deno-lint-ignore no-explicit-any
      await (openai.vectorStores.files as any).update(VECTOR_STORE_ID, file.id, {
        attributes: { estado, date },
      });
      console.log(`  + ${file.filename} → estado=${estado}, date=${date}`);
      updated++;
    } catch (e) {
      console.error(`  x Failed to update ${file.filename}: ${e}`);
    }
  }

  console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}`);
}

await main();
