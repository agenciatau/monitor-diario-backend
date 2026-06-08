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


function signupTemplate(email: string, confirmUrl: string): { subject: string; html: string } {
  return {
    subject: "Confirme seu cadastro no Monitor Diário",
    html: `
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
        <tr><td style="background:#1a1a2e;padding:28px 40px">
          <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Monitor Diário</h1>
        </td></tr>
        <tr><td style="padding:40px">
          <h2 style="margin:0 0 16px;font-size:20px;color:#111">Bem-vindo(a)!</h2>
          <p style="margin:0 0 24px;color:#555;line-height:1.6">
            Recebemos seu cadastro com o e-mail <strong>${email}</strong>.<br>
            Clique no botão abaixo para confirmar sua conta e começar a monitorar os Diários Oficiais.
          </p>
          <a href="${confirmUrl}" style="display:inline-block;background:#1a1a2e;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:700;font-size:15px">
            Confirmar cadastro
          </a>
          <p style="margin:24px 0 0;color:#888;font-size:13px;line-height:1.5">
            Se você não criou uma conta, ignore este e-mail.<br>
            O link expira em 24 horas.
          </p>
        </td></tr>
        <tr><td style="padding:20px 40px;border-top:1px solid #eee;text-align:center">
          <p style="margin:0;color:#aaa;font-size:12px">Monitor Diário &mdash; monitordiario.com.br</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  };
}

function recoveryTemplate(email: string, confirmUrl: string): { subject: string; html: string } {
  return {
    subject: "Redefina sua senha no Monitor Diário",
    html: `
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
        <tr><td style="background:#1a1a2e;padding:28px 40px">
          <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Monitor Diário</h1>
        </td></tr>
        <tr><td style="padding:40px">
          <h2 style="margin:0 0 16px;font-size:20px;color:#111">Redefinição de senha</h2>
          <p style="margin:0 0 24px;color:#555;line-height:1.6">
            Recebemos uma solicitação para redefinir a senha da conta <strong>${email}</strong>.<br>
            Clique no botão abaixo para criar uma nova senha.
          </p>
          <a href="${confirmUrl}" style="display:inline-block;background:#1a1a2e;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:700;font-size:15px">
            Redefinir senha
          </a>
          <p style="margin:24px 0 0;color:#888;font-size:13px;line-height:1.5">
            Se você não solicitou a redefinição de senha, ignore este e-mail — sua conta continua segura.<br>
            O link expira em 1 hora.
          </p>
        </td></tr>
        <tr><td style="padding:20px 40px;border-top:1px solid #eee;text-align:center">
          <p style="margin:0;color:#aaa;font-size:12px">Monitor Diário &mdash; monitordiario.com.br</p>
        </td></tr>
      </table>
    </td></tr>
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
    email = signupTemplate(user.email, confirmUrl);
  } else if (email_data.email_action_type === "recovery") {
    email = recoveryTemplate(user.email, confirmUrl);
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
