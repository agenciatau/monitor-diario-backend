import { createClient } from "@supabase/supabase-js";
import { buildInstructions } from "../_shared/instructions.ts";
import { queryVectorStore } from "../_shared/openai.ts";

const MONITOR_SUPABASE_URL = Deno.env.get("MONITOR_SUPABASE_URL");
const MONITOR_SUPABASE_KEY = Deno.env.get("MONITOR_SUPABASE_KEY");

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

  let config = null;
  if (estado && MONITOR_SUPABASE_URL && MONITOR_SUPABASE_KEY) {
    const monitorSupabase = createClient(MONITOR_SUPABASE_URL, MONITOR_SUPABASE_KEY);
    const { data } = await monitorSupabase
      .from("monitores")
      .select("uf, description, keywords")
      .eq("uf", estado.toUpperCase().trim())
      .eq("is_active", true)
      .limit(1);
    if (data?.length) {
      config = { descricao: data[0].description, palavras_chave: data[0].keywords };
    }
  }
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
