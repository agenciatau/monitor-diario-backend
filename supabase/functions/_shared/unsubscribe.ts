const UNSUBSCRIBE_SECRET = Deno.env.get("UNSUBSCRIBE_SECRET") ?? "";

async function hmac(email: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(UNSUBSCRIBE_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(email.toLowerCase()));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Signs an email so it can be verified later without a login, for one-click unsubscribe links.
export async function signUnsubscribeToken(email: string): Promise<string> {
  return await hmac(email);
}

export async function verifyUnsubscribeToken(email: string, token: string): Promise<boolean> {
  if (!token) return false;
  const expected = await hmac(email);
  if (expected.length !== token.length) return false;
  // Constant-time compare to avoid leaking the valid token via response timing.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}
