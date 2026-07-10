const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
// Format: "v1,whsec_<base64>" — set in Supabase hook config and here
const HOOK_SECRET = Deno.env.get("SEND_EMAIL_HOOK_SECRET") ?? "";
const FROM_EMAIL = Deno.env.get("EMAIL_FROM") ?? "Monitor Diário <noreply@monitordiario.com.br>";
const ANON_KEY = Deno.env.get("ANON_KEY") ?? "";

// Standard Webhooks signature verification
// https://www.standardwebhooks.com/
async function verifySignature(req: Request, rawBody: string): Promise<boolean> {
  const msgId = req.headers.get("webhook-id");
  const msgTimestamp = req.headers.get("webhook-timestamp");
  const msgSignature = req.headers.get("webhook-signature");
  if (!msgId || !msgTimestamp || !msgSignature) return false;

  // Parse secret: strip "v1,whsec_" prefix, base64-decode
  const secretB64 = HOOK_SECRET.replace(/^v1,whsec_/, "");
  const secretBytes = Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0));

  const signedContent = `${msgId}.${msgTimestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
  const computedSig = `v1,${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;

  // webhook-signature may contain multiple space-separated sigs
  return msgSignature.split(" ").some((s) => s === computedSig);
}

type EmailActionType = "signup" | "recovery" | "invite" | "magiclink" | "email_change";

interface HookPayload {
  user: { id: string; email: string };
  email_data: {
    token: string;
    token_hash: string;
    redirect_to: string;
    email_action_type: EmailActionType;
    site_url: string;
    token_new?: string;
    token_hash_new?: string;
  };
}

function buildConfirmUrl(emailData: HookPayload["email_data"]): string {
  const siteUrl =
    emailData.site_url.replace(/\/auth\/v1\/?$/,
      "");
  const url = new
    URL(`${siteUrl}/auth/v1/verify`);
  url.searchParams.set("token",
    emailData.token_hash);
  url.searchParams.set("type",
    emailData.email_action_type);
  url.searchParams.set("redirect_to",
    emailData.redirect_to);
  return url.toString();
}


function signupTemplate(confirmUrl: string): { subject: string; html: string } {
  return {
    subject: "Confirme seu E-mail | Monitor Diário",
    html: `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Confirme seu cadastro</title>
</head>
<body style="margin:0; padding:0; background:#f4f6f8; font-family: Arial, Helvetica, sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
<tr>
<td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 4px 10px rgba(0,0,0,0.05);">
<!-- HEADER -->
<tr>
<td align="center" style="padding:30px 20px;background:#ffffff;border-bottom:1px solid #eeeeee;">
<img src="https://monitordiario.com.br/imagens/logo-monitor-diario.png" alt="Monitor Diário" style="max-width:180px;">
</td>
</tr>
<!-- CONTENT -->
<tr>
<td style="padding:40px 40px 30px 40px;color:#333333;font-size:16px;line-height:1.6;">
<h2 style="margin-top:0;color:#222;font-size:22px;">
Confirme seu cadastro no Monitor Diário
</h2>
<p>Olá! 👋</p>
<p>
Recebemos uma solicitação para criar uma conta na plataforma
<strong>Monitor Diário</strong>.
</p>
<p style="text-align:center;margin:35px 0;">
<a href="${confirmUrl}"
style="
background:#00b871;
color:#ffffff;
padding:14px 28px;
text-decoration:none;
border-radius:6px;
font-weight:bold;
display:inline-block;
font-size:16px;
">
Confirmar meu cadastro
</a>
</p>
<p style="font-size:14px;color:#666;">
Se o botão não funcionar, copie e cole o link abaixo no seu navegador:
</p>
<p style="font-size:14px;word-break:break-all;color:#00b871;">
${confirmUrl}
</p>
<p style="margin-top:30px;">
Caso você não solicitou esse cadastro, pode ignorar este email com segurança.
</p>
</td>
</tr>
<!-- FOOTER -->
<tr>
<td style="background:#f7f7f7;padding:20px 30px;font-size:13px;color:#777;text-align:center;">
<p style="margin:0 0 8px 0;">Monitor Diário</p>
<p style="margin:0;">Ferramenta para monitoramento de Diários Oficiais</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`,
  };
}

function recoveryTemplate(confirmUrl: string): { subject: string; html: string } {
  return {
    subject: "Redefinir senha | Monitor Diário",
    html: `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Redefinir senha</title>
</head>
<body style="margin:0; padding:0; background:#f4f6f8; font-family: Arial, Helvetica, sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
<tr>
<td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 4px 10px rgba(0,0,0,0.05);">
<tr>
<td align="center" style="padding:30px 20px;background:#ffffff;border-bottom:1px solid #eeeeee;">
<img src="https://monitordiario.com.br/imagens/logo-monitor-diario.png" alt="Monitor Diário" style="max-width:180px;">
</td>
</tr>
<tr>
<td style="padding:40px 40px 30px 40px;color:#333333;font-size:16px;line-height:1.6;">
<h2 style="margin-top:0;color:#222;font-size:22px;">
Redefinir sua senha
</h2>
<p>Olá! 👋</p>
<p>
Recebemos uma solicitação para redefinir a senha da sua conta no
<strong>Monitor Diário</strong>.
</p>
<p style="text-align:center;margin:35px 0;">
<a href="${confirmUrl}"
style="
background:#00b871;
color:#ffffff;
padding:14px 28px;
text-decoration:none;
border-radius:6px;
font-weight:bold;
display:inline-block;
font-size:16px;
">
Redefinir minha senha
</a>
</p>
<p style="font-size:14px;color:#666;">
Se o botão não funcionar, copie e cole o link abaixo no seu navegador:
</p>
<p style="font-size:14px;word-break:break-all;color:#00b871;">
${confirmUrl}
</p>
<p style="margin-top:30px;">
Caso você não solicitou a redefinição de senha, pode ignorar este email com segurança.
</p>
</td>
</tr>
<tr>
<td style="background:#f7f7f7;padding:20px 30px;font-size:13px;color:#777;text-align:center;">
<p style="margin:0 0 8px 0;">Monitor Diário</p>
<p style="margin:0;">Ferramenta para monitoramento de Diários Oficiais</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`,
  };
}

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend error ${res.status}: ${body}`);
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" };

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: JSON_HEADERS });
  }

  if (!RESEND_API_KEY) {
    return new Response(JSON.stringify({ error: "RESEND_API_KEY not set" }), { status: 503, headers: JSON_HEADERS });
  }

  const rawBody = await req.text();

  // Verify Standard Webhooks signature
  const valid = await verifySignature(req, rawBody);
  if (!valid) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
  }

  let payload: HookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: JSON_HEADERS });
  }

  const { user, email_data } = payload;
  const confirmUrl = buildConfirmUrl(email_data);

  let email: { subject: string; html: string };
  if (email_data.email_action_type === "signup") {
    email = signupTemplate(confirmUrl);
  } else if (email_data.email_action_type === "recovery") {
    email = recoveryTemplate(confirmUrl);
  } else {
    // For other types (invite, magiclink, email_change) fall through with no-op
    return new Response(JSON.stringify({ message: "Email type not handled" }), { status: 200, headers: JSON_HEADERS });
  }

  try {
    await sendEmail(user.email, email.subject, email.html);
    return new Response(JSON.stringify({ message: "Email sent" }), { status: 200, headers: JSON_HEADERS });
  } catch (e) {
    console.error("Failed to send email:", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: JSON_HEADERS });
  }
});
