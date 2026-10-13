import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Login } from "@bizsuite/contracts";
import { AppError } from "./shared/errors.js";
import { pool } from "./shared/db.js";
import { login, logout } from "./core/auth.js";
import { requireAuth, readCookie, sessionCookieOptions, clearCookieOptions, SESSION_COOKIE } from "./core/middleware.js";
import { assertDevBypassSafe } from "./core/dev-auth.js";
import { settingsRouter } from "./core/settings.routes.js";
import { configRouter } from "./core/config.routes.js";
import { runMigrations } from "./shared/migrate.js";
import { securityHeaders, rejectCrossSite, loginAttempts, loginFailures } from "./core/security.js";
import { itemsRouter } from "./modules/inventory/items.routes.js";
import { warehousesRouter } from "./modules/inventory/warehouses.routes.js";
import { companiesRouter } from "./modules/crm/companies.routes.js";
import { invoicingRouter } from "./modules/invoicing/invoicing.routes.js";
import { quotationsRouter } from "./modules/sales/quotations.routes.js";
import { salesOrdersRouter } from "./modules/sales/sales-orders.routes.js";
import { paymentsRouter } from "./modules/invoicing/payments.routes.js";
import { accountingRouter } from "./modules/accounting/accounting.routes.js";

/**
 * Mount-only composition root (eng review D6): auth endpoints + one router per
 * module. Business routes live in src/modules/<module>/<name>.routes.ts.
 */
// Refuses to boot if the dev login bypass is set in a production build.
assertDevBypassSafe();

const app = express();
// Behind Render/nginx TLS termination: trust the first proxy hop so req.ip is
// the client (audit logs, future rate limiting), not the proxy.
app.set("trust proxy", 1);
app.use(securityHeaders());
// CSRF: before body parsing, so a refused request is never parsed.
app.use("/api", rejectCrossSite);
app.use(express.json());

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
app.post("/api/auth/login", loginAttempts, loginFailures, async (req, res, next) => {
  try {
    const { email, password } = Login.parse(req.body);
    const result = await login(email, password, {
      ip: req.ip,
      userAgent: req.header("user-agent"),
    });
    if (!result) throw new AppError("INVALID_CREDENTIALS", "Invalid email or password", 401);
    res.cookie(SESSION_COOKIE, result.token, sessionCookieOptions());
    res.json({ user: result.user });
  } catch (e) { next(e); }
});

app.post("/api/auth/logout", async (req, res, next) => {
  try {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await logout(token);
    res.clearCookie(SESSION_COOKIE, clearCookieOptions());
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ---------------------------------------------------------------------------
// Module routers
// ---------------------------------------------------------------------------
app.use("/api/settings", settingsRouter);
app.use("/api/config", configRouter);
app.use("/api/inventory/items", itemsRouter);
app.use("/api/inventory/warehouses", warehousesRouter);
app.use("/api/crm/companies", companiesRouter);
app.use("/api/invoicing/invoices", invoicingRouter);
app.use("/api/sales/quotations", quotationsRouter);
app.use("/api/sales/sales-orders", salesOrdersRouter);
app.use("/api/invoicing/payments", paymentsRouter);
app.use("/api/accounting", accountingRouter);

// Health check (Render polls this). Must never throw: an uncaught async
// rejection would take the process down on a transient DB blip — answer 503
// and let the platform decide.
app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// ---------------------------------------------------------------------------
// SPA: serve frontend/dist when it exists (vite build output). Dev uses the
// Vite server on :5173 with an /api proxy instead. GET fallback -> index.html
// so client-side routes deep-link; /api and /healthz never fall through here.
// ---------------------------------------------------------------------------
const spaDist = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../frontend/dist");
if (fs.existsSync(spaDist)) {
  app.use(express.static(spaDist));
  app.get(/^\/(?!api\/|healthz).*/, (_req, res) => {
    res.sendFile(path.join(spaDist, "index.html"));
  });
}

app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof z.ZodError) {
    return res.status(422).json({ error: { code: "VALIDATION", details: err.flatten() } });
  }
  // body-parser's client errors (malformed JSON, oversize body) are the
  // caller's fault: answer 4xx, not INTERNAL, and keep them out of the error log.
  const bodyErr = err as { type?: string; status?: number; expose?: boolean };
  if (bodyErr.expose && bodyErr.status && bodyErr.status >= 400 && bodyErr.status < 500) {
    const code = bodyErr.type === "entity.parse.failed" ? "BAD_JSON"
      : bodyErr.type === "entity.too.large" ? "BODY_TOO_LARGE" : "BAD_REQUEST";
    return res.status(bodyErr.status).json({ error: { code, message: "The request body could not be read" } });
  }
  const e = err instanceof AppError ? err : new AppError("INTERNAL", "Internal error", 500);
  // Unexpected errors must reach the server log (Render Logs tab) with their
  // stack — the client only ever sees the generic INTERNAL envelope.
  if (e.code === "INTERNAL") {
    console.error(`[internal] ${req.method} ${req.path}:`, err);
  }
  res.status(e.status).json({ error: { code: e.code, message: e.message } });
});

export { app };

// Start the HTTP listener only when run as the entry point (not when imported
// by tests, which start their own ephemeral listener). Pending migrations run
// first: new code never serves requests against an old schema, and a failed
// migration stops the boot, so the platform keeps the previous instance.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  runMigrations()
    .then(({ applied }) => {
      for (const name of applied) console.log(`migration applied: ${name}`);
      app.listen(port, () => console.log(`bizsuite listening on :${port}`));
    })
    .catch((err: unknown) => {
      console.error("migrations failed; not starting:", err);
      process.exit(1);
    });
}
