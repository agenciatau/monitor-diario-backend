import { createClient } from "@supabase/supabase-js";
import { verifyUnsubscribeToken } from "../_shared/unsubscribe.ts";

const MONITOR_SUPABASE_URL = Deno.env.get("MONITOR_SUPABASE_URL");
const MONITOR_SUPABASE_KEY = Deno.env.get("MONITOR_SUPABASE_KEY");

function page(title: string, message: string): Response {
  return new Response(
    `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>${title} | Monitor Diário</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial, Helvetica, sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:60px 0;">
<tr><td align="center">
<table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 4px 10px rgba(0,0,0,0.05);">
<tr><td align="center" style="padding:30px 20px;border-bottom:1px solid #eeeeee;">
<img src="https://monitordiario.com.br/imagens/logo-monitor-diario.png" alt="Monitor Diário" style="max-width:180px;">
</td></tr>
<tr><td style="padding:36px 40px;color:#333333;font-size:16px;line-height:1.6;text-align:center;">
<h2 style="margin:0 0 16px 0;color:#222;font-size:20px;">${title}</h2>
<p style="margin:0;color:#555;">${message}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const email = url.searchParams.get("email");
  const token = url.searchParams.get("token");

  if (!email || !token || !(await verifyUnsubscribeToken(email, token))) {
    return page("Link inválido", "Este link de cancelamento é inválido ou expirou.");
  }

  if (!MONITOR_SUPABASE_URL || !MONITOR_SUPABASE_KEY) {
    return page("Erro", "Não foi possível processar sua solicitação. Tente novamente mais tarde.");
  }

  const supabase = createClient(MONITOR_SUPABASE_URL, MONITOR_SUPABASE_KEY);
  const { error } = await supabase
    .from("email_unsubscribes")
    .upsert({ email: email.toLowerCase() }, { onConflict: "email" });

  if (error) {
    console.error("[unsubscribe] failed to record unsubscribe:", JSON.stringify(error));
    return page("Erro", "Não foi possível processar sua solicitação. Tente novamente mais tarde.");
  }

  return page(
    "Assinatura cancelada",
    "Você não receberá mais o resumo diário do Monitor Diário. Você pode reativar o envio a qualquer momento reabrindo seus monitores na plataforma.",
  );
});
