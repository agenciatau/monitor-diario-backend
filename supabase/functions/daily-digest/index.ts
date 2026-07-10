import { createClient } from "@supabase/supabase-js";

const MONITOR_SUPABASE_URL = Deno.env.get("MONITOR_SUPABASE_URL");
const MONITOR_SUPABASE_KEY = Deno.env.get("MONITOR_SUPABASE_KEY");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = Deno.env.get("EMAIL_FROM") ?? "Monitor Diário <noreply@monitordiario.com.br>";

const ESTADO_NOMES: Record<string, string> = {
  AL: "Alagoas", BA: "Bahia", CE: "Ceará", MA: "Maranhão",
  PB: "Paraíba", PE: "Pernambuco", PI: "Piauí", RN: "Rio Grande do Norte",
  SE: "Sergipe",
};

interface Monitor {
  id: string;
  uf: string;
  title: string | null;
  user_email: string | null;
}

interface Analise {
  monitor_id: string;
  uf: string;
  resumo: string | null;
  criado_em: string;
}

interface Finding {
  title: string;
  uf: string;
  resumo: string;
}

// Returns the [start, end) UTC bounds of "today" in America/Sao_Paulo, for filtering timestamptz columns.
function brazilDayRange(): { start: string; end: string; label: string } {
  const now = new Date();
  const brDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  const start = new Date(`${brDate}T00:00:00-03:00`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  const [year, month, day] = brDate.split("-");
  return { start: start.toISOString(), end: end.toISOString(), label: `${day}/${month}/${year}` };
}

const PLATFORM_URL = "https://www.monitordiario.com.br/app";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function findingCard(f: Finding, dateLabel: string): string {
  const estadoNome = ESTADO_NOMES[f.uf] ?? f.uf;
  return `
<!-- ACHADO -->
<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eeeeee;border-radius:8px;margin-bottom:18px;">
<tr>
<td style="padding:20px;">

<p style="margin:0 0 8px 0;font-size:15px;color:#777;">
Monitor:
</p>
<h3 style="margin:0 0 14px 0;font-size:18px;color:#222;">
${escapeHtml(f.title)}
</h3>

<p style="margin:0 0 6px 0;">
<strong>Data:</strong> ${dateLabel}
</p>

<p style="margin:0 0 6px 0;">
<strong>Diário:</strong> Diário Oficial de ${estadoNome}
</p>

<p style="margin:12px 0 18px 0;">
<strong>Resumo do achado:</strong><br>
${escapeHtml(f.resumo)}
</p>

<p style="margin:0;">
<a href="${PLATFORM_URL}" style="color:#00b871;font-weight:bold;text-decoration:none;">
Ver achado na plataforma →
</a>
</p>

</td>
</tr>
</table>`;
}

function digestTemplate(dateLabel: string, findings: Finding[]): { subject: string; html: string } {
  const cards = findings.map((f) => findingCard(f, dateLabel)).join("\n");

  return {
    subject: `Resumo do dia ${dateLabel} | Monitor Diário`,
    html: `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Resumo diário de achados</title>
</head>

<body style="margin:0; padding:0; background:#f4f6f8; font-family: Arial, Helvetica, sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
<tr>
<td align="center">

<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 4px 10px rgba(0,0,0,0.05);">

<tr>
<td align="center" style="padding:30px 20px;background:#ffffff;border-bottom:1px solid #eeeeee;">
<img src="https://monitordiario.com.br/imagens/logo-monitor-diario.png" alt="Monitor Diário" style="max-width:180px;">
</td>
</tr>

<tr>
<td style="padding:36px 40px 28px 40px;color:#333333;font-size:16px;line-height:1.6;">

<h2 style="margin:0 0 16px 0;color:#222;font-size:22px;">
Resumo diário de achados
</h2>

<p style="margin:0 0 24px 0;">
Temos <strong>${findings.length} achado${findings.length > 1 ? "s" : ""}</strong> para você hoje no
<strong>Monitor Diário</strong>.
</p>

<p style="margin:0 0 28px 0;color:#555;">
Confira os detalhes abaixo e acesse os links para ver mais informações na plataforma.
</p>

${cards}

<p style="text-align:center;margin:34px 0 10px 0;">
<a href="${PLATFORM_URL}"
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
Acessar Monitor Diário
</a>
</p>

</td>
</tr>

<tr>
<td style="background:#f7f7f7;padding:20px 30px;font-size:13px;color:#777;text-align:center;">

<p style="margin:0 0 8px 0;">
Monitor Diário
</p>

<p style="margin:0;">
Ferramenta para monitoramento de Diários Oficiais
</p>

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

  if (req.headers.get("Authorization") !== `Bearer ${MONITOR_SUPABASE_KEY}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
  }

  if (!RESEND_API_KEY) {
    return new Response(JSON.stringify({ error: "RESEND_API_KEY not set" }), { status: 503, headers: JSON_HEADERS });
  }
  if (!MONITOR_SUPABASE_URL || !MONITOR_SUPABASE_KEY) {
    return new Response(JSON.stringify({ error: "MONITOR_SUPABASE_URL/KEY not set" }), { status: 503, headers: JSON_HEADERS });
  }

  const supabase = createClient(MONITOR_SUPABASE_URL, MONITOR_SUPABASE_KEY);
  const { start, end, label } = brazilDayRange();

  const { data: monitors, error: monitorsError } = await supabase
    .from("monitores")
    .select("id, uf, title, user_email")
    .eq("is_active", true);

  if (monitorsError) {
    console.error("[daily-digest] failed to fetch monitores:", JSON.stringify(monitorsError));
    return new Response(JSON.stringify({ error: monitorsError.message }), { status: 500, headers: JSON_HEADERS });
  }

  const activeMonitors = ((monitors ?? []) as Monitor[]).filter((m) => m.user_email);
  if (activeMonitors.length === 0) {
    return new Response(JSON.stringify({ message: "No active monitors with email" }), { status: 200, headers: JSON_HEADERS });
  }

  const monitorById = new Map(activeMonitors.map((m) => [m.id, m]));

  const { data: analises, error: analisesError } = await supabase
    .from("analises")
    .select("monitor_id, uf, resumo, criado_em")
    .eq("hasAnalysis", true)
    .in("monitor_id", activeMonitors.map((m) => m.id))
    .gte("criado_em", start)
    .lt("criado_em", end);

  if (analisesError) {
    console.error("[daily-digest] failed to fetch analises:", JSON.stringify(analisesError));
    return new Response(JSON.stringify({ error: analisesError.message }), { status: 500, headers: JSON_HEADERS });
  }

  const findingsByEmail = new Map<string, Finding[]>();

  for (const analise of (analises ?? []) as Analise[]) {
    const monitor = monitorById.get(analise.monitor_id);
    if (!monitor || !monitor.user_email || !analise.resumo) continue;

    if (!findingsByEmail.has(monitor.user_email)) {
      findingsByEmail.set(monitor.user_email, []);
    }
    findingsByEmail.get(monitor.user_email)!.push({
      title: monitor.title ?? ESTADO_NOMES[monitor.uf] ?? monitor.uf,
      uf: analise.uf,
      resumo: analise.resumo,
    });
  }

  let usersNotified = 0;
  let totalFindings = 0;
  const errors: string[] = [];

  for (const [email, findings] of findingsByEmail) {
    const { subject, html } = digestTemplate(label, findings);
    try {
      await sendEmail(email, subject, html);
      usersNotified++;
      totalFindings += findings.length;
    } catch (e) {
      console.error(`[daily-digest] failed to send to ${email}:`, e);
      errors.push(`${email}: ${e}`);
    }
  }

  return new Response(
    JSON.stringify({ usersNotified, totalFindings, errors }),
    { status: 200, headers: JSON_HEADERS },
  );
});
