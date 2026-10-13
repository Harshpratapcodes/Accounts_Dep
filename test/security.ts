/**
 * HTTP hardening (D-143, T0-09): security headers, cross-site request
 * refusal (CSRF), login rate limits, login timing, malformed bodies.
 *
 * Client IPs are simulated with X-Forwarded-For, which `trust proxy` (one
 * hop) turns into req.ip exactly as Render's proxy does, so each limit is
 * exercised from its own address.
 */
import "./support/local-db-only.js"; // first: refuses a non-local database
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { app } from "../src/server.js";
import { createUser } from "../src/core/auth.js";
import { pool } from "../src/shared/db.js";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}
function sidFrom(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const m = /(?:^|,\s*)sid=([^;]+)/.exec(setCookie);
  return m ? `sid=${m[1]}` : null;
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function main() {
  const stamp = Date.now();
  const email = `sec_${stamp}@test.com`;
  const password = "Correct-Horse-9";
  await createUser({ email, fullName: "Sec", password, roleName: "owner" });

  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const login = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const code = async (res: Response) => ((await res.json().catch(() => ({}))) as { error?: { code?: string } }).error?.code;

  try {
    console.log("== SECURITY HEADERS ==");
    const h = (await fetch(`${base}/healthz`)).headers;
    const csp = h.get("content-security-policy") ?? "";
    check("CSP: default-src 'self'", csp.includes("default-src 'self'"), csp);
    check("CSP: scripts only from our origin", csp.includes("script-src 'self'") && csp.includes("script-src-attr 'none'"));
    check("CSP: no framing (clickjacking)", csp.includes("frame-ancestors 'none'"));
    check("CSP: no plugins", csp.includes("object-src 'none'"));
    check("CSP: fonts only from Google Fonts", csp.includes("font-src 'self' https://fonts.gstatic.com")
      && csp.includes("style-src 'self' https://fonts.googleapis.com"));
    check("CSP: no blanket https: source", !/\shttps:(;|\s|$)/.test(csp), csp);
    check("X-Frame-Options: DENY", h.get("x-frame-options") === "DENY", String(h.get("x-frame-options")));
    check("X-Content-Type-Options: nosniff", h.get("x-content-type-options") === "nosniff");
    check("Referrer-Policy: same-origin (keeps Origin on own POSTs)", h.get("referrer-policy") === "same-origin",
      String(h.get("referrer-policy")));
    check("no X-Powered-By", h.get("x-powered-by") === null, String(h.get("x-powered-by")));
    check("no HSTS outside production", h.get("strict-transport-security") === null);
    const api = (await fetch(`${base}/api/auth/me`)).headers;
    check("API responses carry the headers too", (api.get("content-security-policy") ?? "").includes("default-src 'self'"));
    if (fs.existsSync("frontend/dist/index.html")) {
      const spa = await fetch(`${base}/`);
      check("the SPA page carries the CSP", spa.status === 200
        && (spa.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"));
    } else {
      console.log("  - SPA header check skipped: frontend/dist not built");
    }

    console.log("== CROSS-SITE REQUESTS (CSRF) ==");
    const bad = { email, password: "wrong" };
    const r1 = await login(bad, { "sec-fetch-site": "cross-site" });
    check("POST marked Sec-Fetch-Site: cross-site -> 403", r1.status === 403 && await code(r1) === "CROSS_SITE_REQUEST", String(r1.status));
    const r2 = await login(bad, { "sec-fetch-site": "same-site" });
    check("POST from a sibling subdomain (same-site) -> 403", r2.status === 403, String(r2.status));
    const r3 = await login(bad, { origin: "https://evil.example" });
    check("POST with a foreign Origin -> 403", r3.status === 403, String(r3.status));
    const r4 = await login(bad, { origin: "null" });
    check("POST with Origin: null (sandboxed/opaque) -> 403", r4.status === 403, String(r4.status));
    const r5 = await login(bad, { "sec-fetch-site": "same-origin" });
    check("POST from our own pages (same-origin) passes the check", r5.status === 401, String(r5.status));
    const r6 = await login(bad, { origin: base });
    check("POST whose Origin matches the host passes", r6.status === 401, String(r6.status));
    const r7 = await login(bad);
    check("POST with neither header (not a browser) passes", r7.status === 401, String(r7.status));
    const g = await fetch(`${base}/api/auth/me`, { headers: { "sec-fetch-site": "cross-site" } });
    check("GET is never refused as cross-site (safe method)", g.status === 401, String(g.status));

    // A signed-in victim: a cross-site POST carrying their cookie changes nothing.
    const cookie = sidFrom((await login({ email, password }, { "x-forwarded-for": "198.51.100.1" })).headers.get("set-cookie"))!;
    const out = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie, "sec-fetch-site": "cross-site" } });
    check("cross-site logout with the victim's cookie -> 403", out.status === 403, String(out.status));
    const still = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    check("and the victim is still signed in", still.status === 200, String(still.status));
    const forged = await fetch(`${base}/api/sales/quotations`, {
      method: "POST", headers: { cookie, "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({}),
    });
    check("cross-site create with the victim's cookie -> 403 before validation", forged.status === 403, String(forged.status));

    console.log("== MALFORMED BODIES ==");
    const broken = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
    });
    check("malformed JSON -> 400 BAD_JSON (not 500)", broken.status === 400 && await code(broken) === "BAD_JSON",
      String(broken.status));

    console.log("== LOGIN RATE LIMITS ==");
    const ipA = { "x-forwarded-for": "203.0.113.10" };
    let lastFail = 0;
    for (let i = 0; i < 10; i++) lastFail = (await login(bad, ipA)).status;
    check("10 failed logins from one address are each answered 401", lastFail === 401, String(lastFail));
    const eleventh = await login(bad, ipA);
    check("the 11th within 15 minutes -> 429 RATE_LIMITED", eleventh.status === 429 && await code(eleventh) === "RATE_LIMITED",
      String(eleventh.status));
    check("with Retry-After", Number(eleventh.headers.get("retry-after")) > 0, String(eleventh.headers.get("retry-after")));
    const locked = await login({ email, password }, ipA);
    check("even the right password from that address waits", locked.status === 429, String(locked.status));
    const other = await login({ email, password }, { "x-forwarded-for": "203.0.113.11" });
    check("another address is unaffected", other.status === 200, String(other.status));
    check("responses advertise the limit (RateLimit headers)", other.headers.get("ratelimit-policy") !== null
      || other.headers.get("ratelimit") !== null);

    const ipC = { "x-forwarded-for": "203.0.113.12" };
    let okCount = 0;
    for (let i = 0; i < 12; i++) if ((await login({ email, password }, ipC)).status === 200) okCount++;
    check("successful logins do not count as failures (12 in a row succeed)", okCount === 12, String(okCount));

    const ipD = { "x-forwarded-for": "203.0.113.13" };
    let volumeOk = 0;
    for (let i = 0; i < 30; i++) if ((await login({ email, password }, ipD)).status === 200) volumeOk++;
    const thirtyFirst = await login({ email, password }, ipD);
    check("30 logins a minute from one address are served", volumeOk === 30, String(volumeOk));
    check("the 31st -> 429 (bounds argon2 work per client)", thirtyFirst.status === 429, String(thirtyFirst.status));

    console.log("== LOGIN TIMING DOES NOT REVEAL WHICH EMAILS EXIST ==");
    await login({ email: `nobody_${stamp}@test.com`, password: "x" }, { "x-forwarded-for": "203.0.113.20" }); // warm-up
    const timed = async (body: unknown, ip: string) => {
      const t = performance.now();
      await login(body, { "x-forwarded-for": ip });
      return performance.now() - t;
    };
    const known: number[] = [], unknown: number[] = [];
    for (let i = 0; i < 5; i++) {
      known.push(await timed({ email, password: "wrong" }, "203.0.113.21"));
      unknown.push(await timed({ email: `nobody_${stamp}_${i}@test.com`, password: "wrong" }, "203.0.113.20"));
    }
    const k = median(known), u = median(unknown);
    check("an unknown email takes as long as a wrong password (argon2 runs either way)", u >= k * 0.5,
      `known ${k.toFixed(1)} ms, unknown ${u.toFixed(1)} ms`);
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
