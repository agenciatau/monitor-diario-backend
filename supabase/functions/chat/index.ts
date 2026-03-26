import { createClient } from "npm:@supabase/supabase-js@2";
import { buildInstructions } from "../_shared/instructions.ts";
import { queryVectorStore } from "../_shared/openai.ts";

const monitorSupabase = createClient(
  Deno.env.get("MONITOR_SUPABASE_URL")!,
  Deno.env.get("MONITOR_SUPABASE_KEY")!,
);

async function getMonitorConfig(estado: string) {
  if (!estado) return null;
  const { data } = await monitorSupabase
    .from("monitores")
    .select("uf, description, keywords")
    .eq("uf", estado.toUpperCase().trim())
    .eq("is_active", true)
    .limit(1);
  if (!data?.length) return null;
  return { descricao: data[0].description, palavras_chave: data[0].keywords };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ erro: "Method not allowed" }), { status: 405 });
  }

  const { pergunta, estado } = await req.json();
  if (!pergunta) {
    return new Response(JSON.stringify({ erro: "Pergunta não fornecida" }), { status: 400 });
  }

  if (!Deno.env.get("VECTOR_STORE_ID")) {
    return new Response(JSON.stringify({ erro: "VECTOR_STORE_ID não configurado" }), { status: 503 });
  }

  const config = await getMonitorConfig(estado ?? "");
  const instructions = buildInstructions(config);

  try {
    const result = await queryVectorStore(pergunta, instructions);
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ erro: `Erro ao consultar a API: ${e}` }), { status: 502 });
  }
});
