import { Router } from "express";
import { SetConfigValue } from "@bizsuite/contracts";
import { requireAuth, actorId } from "./middleware.js";
import { requirePermission } from "./rbac.js";
import { AppError } from "../shared/errors.js";
import { businessToday, isRealDate } from "../shared/clock.js";
import { configHistory, isConfigKey, listConfig, setConfig } from "./config.js";

/** Configuration (C-14). Anyone signed in may read it; writing is `core.write`,
 *  which only admin holds (owner reads, D-140). */
export const configRouter = Router();

configRouter.get("/", requireAuth, requirePermission("core", "read"), async (req, res, next) => {
  try {
    const asOf = typeof req.query.asOf === "string" ? req.query.asOf : businessToday();
    if (!isRealDate(asOf)) throw new AppError("INVALID_DATE", `${asOf} is not a date`, 422);
    res.json({ asOf, entries: await listConfig(asOf) });
  } catch (e) { next(e); }
});

configRouter.get("/:key/history", requireAuth, requirePermission("core", "read"), async (req, res, next) => {
  try {
    const key = req.params.key!;
    if (!isConfigKey(key)) throw new AppError("UNKNOWN_CONFIG_KEY", `No configuration key '${key}'`, 404);
    res.json(await configHistory(key));
  } catch (e) { next(e); }
});

configRouter.post("/:key", requireAuth, requirePermission("core", "write"), async (req, res, next) => {
  try {
    const body = SetConfigValue.parse(req.body);
    res.status(201).json(await setConfig(req.params.key!, body.value, body.effectiveFrom, body.note, actorId(req)));
  } catch (e) { next(e); }
});
