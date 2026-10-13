/**
 * The Content-Security-Policy (D-143, T0-09) must not break the SPA. A real
 * browser walks every screen and records each CSP violation: a blocked
 * script, style, font or request fails the spec, naming the directive.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Seed { admin: { email: string; password: string } }
const seed: Seed = JSON.parse(fs.readFileSync(
  path.resolve(fileURLToPath(new URL(".", import.meta.url)), ".seed.json"), "utf8"));

const SCREENS = [
  "/", "/khata", "/payments/new", "/invoices", "/invoices/new", "/customers",
  "/quotations", "/quotations/new", "/sales-orders", "/sales-orders/new",
  "/accounting", "/accounting/trial-balance", "/accounting/journals",
  "/accounting/journals/new", "/accounting/periods", "/opening-balances",
];

async function violations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
}

test("every screen renders under the CSP with no violations", async ({ page }) => {
  // Recorded from the first byte of every page, before the SPA's own scripts run.
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || "inline"}`);
    });
  });
  const consoleCsp: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) consoleCsp.push(m.text());
  });

  const res = await page.goto("/");
  expect(res?.headers()["content-security-policy"]).toContain("default-src 'self'");
  await page.getByLabel("Email").fill(seed.admin.email);
  await page.getByLabel("Password").fill(seed.admin.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("link", { name: "Khata", exact: true })).toBeVisible();

  const found: string[] = [];
  for (const screen of SCREENS) {
    await page.goto(screen);
    await page.waitForLoadState("networkidle");
    found.push(...(await violations(page)).map((v) => `${screen}: ${v}`));
  }
  expect(found, found.join("\n")).toEqual([]);
  expect(consoleCsp, consoleCsp.join("\n")).toEqual([]);
});
