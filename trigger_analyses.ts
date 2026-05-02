/**
 * trigger_analyses.ts
 * Triggers scheduled analyses for all active monitors based on their frequency:
 *   - "daily"  → runs every time this script is called
 *   - "weekly" → runs only on Mondays
 *
 * Run:
 *   deno run --allow-net --allow-read --allow-env trigger_analyses.ts
 */

import "npm:dotenv/config";
import { createClient } from "npm:@supabase/supabase-js@2";

const MONITOR_SUPABASE_URL = Deno.env.get("MONITOR_SUPABASE_URL")!;
const MONITOR_SUPABASE_KEY = Deno.env.get("MONITOR_SUPABASE_KEY")!;

const monitorSupabase = createClient(MONITOR_SUPABASE_URL, MONITOR_SUPABASE_KEY);

const isMonday = new Date().getDay() === 1;
const frequenciesToRun = ["daily", ...(isMonday ? ["weekly"] : [])];

console.log(`Date: ${new Date().toISOString()}`);
console.log(`Running frequencies: ${frequenciesToRun.join(", ")}`);

const { data: monitors, error } = await monitorSupabase
  .from("monitores")
  .select("*")
  .eq("is_active", true)
  .in("frequency", frequenciesToRun);

if (error) throw new Error(`Failed to fetch monitors: ${error.message}`);

console.log(`Found ${monitors?.length ?? 0} monitor(s) to analyze.\n`);

const analyzeUrl = `${MONITOR_SUPABASE_URL}/functions/v1/analyze`;

for (const monitor of monitors ?? []) {
  console.log(`  [${monitor.uf}] ${monitor.title} (${monitor.frequency}) ...`);
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
    const body = await resp.json();
    if (resp.ok && !body.erro && !body.ignorado) {
      console.log(`    OK — ${body.resumo?.slice(0, 100) ?? "sem resumo"}`);
    } else if (body.ignorado) {
      console.log(`    Ignorado: ${body.ignorado}`);
    } else {
      console.error(`    Erro ${resp.status}: ${JSON.stringify(body)}`);
    }
  } catch (e) {
    console.error(`    Falhou: ${e}`);
  }
}

console.log("\nDone.");
