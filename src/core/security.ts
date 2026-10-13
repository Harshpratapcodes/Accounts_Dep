import type { NextFunction, Request, RequestHandler, Response } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { AppError } from "../shared/errors.js";

/**
 * HTTP hardening (D-143): security headers, cross-site request refusal
 * (CSRF), and rate limits. Mounted by server.ts ahead of every route.
 */

/**
 * Security headers. The CSP allows our own origin plus Google Fonts, which
 * the SPA's index.html loads (IBM Plex, Bricolage). The SPA has no inline
 * scripts; React sets styles through the DOM, which style-src does not
 * restrict. e2e/security.spec.ts fails on any CSP violation in the SPA.
 *
 * Referrer-Policy is `same-origin`, not helmet's `no-referrer`: under
 * no-referrer a browser sends `Origin: null` on its own same-origin POSTs,
 * which the cross-site check below would have to refuse.
 */
export function securityHeaders(): RequestHandler {
  const production = process.env.NODE_ENV === "production";
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        ...(production ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    frameguard: { action: "deny" },
    referrerPolicy: { policy: "same-origin" },
    // HSTS only means something over HTTPS; locally it would be noise.
    strictTransportSecurity: production,
  });
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF: refuse state-changing requests that a browser marks as coming from
 * another site. Fetch Metadata first (`Sec-Fetch-Site`, sent by every current
 * browser), else the `Origin` header, which browsers send on every POST. A
 * request with neither did not come from a browser (curl, scripts, tests)
 * and carries no victim's cookies, so it is not a CSRF vector. This sits on
 * top of the session cookie's SameSite=Lax; neither needs a token in the SPA.
 */
export function rejectCrossSite(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();
  const site = req.get("sec-fetch-site");
  if (site !== undefined) {
    return site === "same-origin" ? next() : next(crossSite());
  }
  const origin = req.get("origin");
  if (origin !== undefined) {
    return origin === `${req.protocol}://${req.get("host")}` ? next() : next(crossSite());
  }
  next();
}

function crossSite(): AppError {
  return new AppError("CROSS_SITE_REQUEST", "Requests from other sites are not accepted", 403);
}

/**
 * A per-client-IP limiter answering in the API's error envelope (429
 * RATE_LIMITED, with Retry-After). In-memory: one container (D-06), so one
 * store; a restart forgets counts, which only ever favours the user.
 * Client IP comes from `trust proxy` (server.ts): one hop, Render's proxy.
 */
export function limiter(opts: {
  windowMs: number; limit: number; message: string; skipSuccessfulRequests?: boolean;
}): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    skipSuccessfulRequests: opts.skipSuccessfulRequests ?? false,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError("RATE_LIMITED", opts.message, 429)),
  });
}

/** Every login runs argon2id (19 MiB, t=2): bound the work one client can ask for. */
export const loginAttempts = limiter({
  windowMs: 60_000, limit: 30,
  message: "Too many sign-in attempts. Wait a minute and try again.",
});

/** Password guessing: failed logins only (a success does not count). */
export const loginFailures = limiter({
  windowMs: 15 * 60_000, limit: 10, skipSuccessfulRequests: true,
  message: "Too many failed sign-ins. Wait 15 minutes and try again.",
});
