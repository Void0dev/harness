import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "oc_session";

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

export function credentialsMatch(username, password, expectedUsername, expectedPassword) {
  const actual = digest(`${username}\0${password}`);
  const expected = digest(`${expectedUsername}\0${expectedPassword}`);
  return timingSafeEqual(actual, expected);
}

export function createSessionCookie({ username, secret, now = Math.floor(Date.now() / 1000), ttlSeconds, secure }) {
  const payload = Buffer.from(JSON.stringify({
    u: username,
    iat: now,
    exp: now + ttlSeconds,
    n: randomBytes(12).toString("base64url"),
  }), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  const value = `${payload}.${signature}`;
  return {
    value,
    header: `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttlSeconds}${secure ? "; Secure" : ""}`,
  };
}

export function parseSessionCookie(value, { secret, now = Math.floor(Date.now() / 1000) }) {
  if (!value || value.length > 2048) return undefined;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) return undefined;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let actual;
  try { actual = Buffer.from(signature, "base64url"); } catch { return undefined; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof parsed.u !== "string" || !Number.isSafeInteger(parsed.exp) || parsed.exp < now) return undefined;
    return { username: parsed.u };
  } catch {
    return undefined;
  }
}

export function safeNextPath(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export function cookieValue(cookieHeader, name = SESSION_COOKIE) {
  if (!cookieHeader) return undefined;
  for (const item of cookieHeader.split(";")) {
    const separator = item.indexOf("=");
    if (separator === -1) continue;
    if (item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim();
  }
  return undefined;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function loginPage({ next = "/", invalid = false, limited = false } = {}) {
  const message = limited
    ? "Слишком много попыток. Подождите несколько минут."
    : invalid ? "Неверный логин или пароль." : "";
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Вход · OpenCode</title><style>
:root{color-scheme:dark;--bg:#111;--panel:#171717;--line:#2a2a2a;--text:#ededed;--muted:#8b8b8b;--accent:#d8ff3e;--danger:#ff7a7a}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 50% 30%,#1c1c1c 0,#111 42%,#0d0d0d 100%);color:var(--text);font-family:"IBM Plex Mono","Cascadia Code",monospace;display:grid;place-items:center;padding:24px}.shell{width:min(420px,100%)}.mark{display:flex;align-items:center;gap:12px;margin:0 0 28px;color:#bbb;font-size:12px;letter-spacing:.12em;text-transform:uppercase}.glyph{width:30px;height:30px;border:1px solid #414141;border-radius:7px;display:grid;place-items:center;color:var(--accent);box-shadow:inset 0 0 0 1px #171717}.card{position:relative;background:rgba(23,23,23,.92);border:1px solid var(--line);border-radius:12px;padding:30px;box-shadow:0 24px 80px #0008;overflow:hidden}.card:before{content:"";position:absolute;inset:0 0 auto;height:1px;background:linear-gradient(90deg,transparent,var(--accent),transparent);opacity:.5}h1{font-size:20px;letter-spacing:-.03em;margin:0 0 8px}p{font:13px/1.6 system-ui,sans-serif;color:var(--muted);margin:0 0 24px}.field{display:block;margin:0 0 16px}.field span{display:block;color:#aaa;font-size:11px;margin:0 0 7px;text-transform:uppercase;letter-spacing:.08em}input{width:100%;height:44px;border:1px solid #333;border-radius:7px;background:#101010;color:var(--text);padding:0 13px;font:14px inherit;outline:none;transition:.18s border,.18s box-shadow}input:focus{border-color:#66751f;box-shadow:0 0 0 3px #d8ff3e12}.error{color:var(--danger);font:12px/1.5 system-ui,sans-serif;margin:-3px 0 16px;min-height:18px}button{width:100%;height:44px;border:0;border-radius:7px;background:var(--accent);color:#111;font:600 13px inherit;cursor:pointer;transition:.16s transform,.16s filter}button:hover{filter:brightness(1.06)}button:active{transform:translateY(1px)}.foot{text-align:center;margin-top:18px;color:#555;font-size:10px;letter-spacing:.05em}@media(max-width:480px){.card{padding:24px}}
</style></head><body><main class="shell"><div class="mark"><span class="glyph">›_</span> OpenCode Harness</div><section class="card"><h1>Доступ к проекту</h1><p>Войдите, чтобы открыть защищённую рабочую сессию OpenCode.</p><form method="post" action="/login"><input type="hidden" name="next" value="${escapeHtml(safeNextPath(next))}"><label class="field"><span>Логин</span><input name="username" autocomplete="username" required autofocus></label><label class="field"><span>Пароль</span><input name="password" type="password" autocomplete="current-password" required></label><div class="error" role="alert">${message}</div><button type="submit">Открыть OpenCode</button></form></section><div class="foot">SESSION PROTECTED · 24H</div></main></body></html>`;
}
