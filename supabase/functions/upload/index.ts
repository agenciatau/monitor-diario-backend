import OpenAI from "npm:openai@4";

const openai = new OpenAI({ apiKey: Deno.env.get("OPEN_API_KEY")! });

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ erro: "Method not allowed" }), { status: 405 });
  }

  const vectorStoreId = Deno.env.get("VECTOR_STORE_ID");
  if (!vectorStoreId) {
    return new Response(JSON.stringify({ erro: "VECTOR_STORE_ID não configurado" }), { status: 503 });
  }

  const formData = await req.formData();
  const arquivo = formData.get("arquivo") as File | null;
  if (!arquivo) {
    return new Response(JSON.stringify({ erro: "Nenhum arquivo enviado" }), { status: 400 });
  }

  try {
    const uploaded = await openai.files.create({
      file: arquivo,
      purpose: "assistants",
    });

    const batch = await openai.vectorStores.fileBatches.createAndPoll(vectorStoreId, {
      file_ids: [uploaded.id],
    });

    return new Response(
      JSON.stringify({ mensagem: "Arquivo indexado com sucesso", file_id: uploaded.id, status: batch.status }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ erro: `Erro ao indexar arquivo: ${e}` }), { status: 502 });
  }
});
