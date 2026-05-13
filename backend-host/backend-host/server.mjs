import express from "express";
import {
  GetAllSourceOverlapQueryParams,
  GetLevelsQueryParams,
  getCachedAllSourceOverlap,
  getCachedLevels,
  getCachedLevelsOverlay,
  prewarmAllSourceOverlap,
  sendCached,
  ALL_SOURCE_OVERLAP_CHECKED_METHODS,
} from "./exported-levels-engine/dist/index.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const corsOrigin = process.env.CORS_ORIGIN || "*";

app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, If-None-Match, Cache-Control");
  res.setHeader("Access-Control-Expose-Headers", "ETag, Cache-Control");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

function validationError(res, message) {
  res.status(400).json({ ok: false, error: message });
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function runtimeErrorStatus(err) {
  const msg = errorMessage(err);
  return msg.includes("symbol is required") || msg.includes("Unsupported interval") ? 400 : 502;
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "levels-engine-v1.4-backend-host",
    endpoints: [
      "/api/health",
      "/api/levels/all-source-overlap?symbol=BTC&interval=4h&minStrength=strong&limit=20&includeLive=true",
      "/api/levels/confluence-overlay?symbol=BTC&interval=4h&minStrength=strong&limit=20&includeLive=true",
      "/api/levels/prewarm?symbol=BTC&interval=4h&minStrength=strong&limit=20&includeLive=true",
      "/api/levels?symbol=BTC&interval=4h"
    ],
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    build: "v1.4-backend-host",
    checkedMethodsCount: ALL_SOURCE_OVERLAP_CHECKED_METHODS.length,
    checkedMethods: ALL_SOURCE_OVERLAP_CHECKED_METHODS,
    time: new Date().toISOString(),
  });
});

app.get("/api/levels", async (req, res) => {
  const parsed = GetLevelsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    validationError(res, parsed.error.issues.map((issue) => issue.message).join("; "));
    return;
  }
  try {
    const result = await getCachedLevels(parsed.data.symbol, parsed.data.interval);
    sendCached(res, req, result, 30);
  } catch (err) {
    const status = runtimeErrorStatus(err);
    res.status(status).json({ ok: false, error: status === 400 ? errorMessage(err) : "Failed to compute levels", detail: errorMessage(err) });
  }
});

async function serveAllSourceOverlap(req, res) {
  const parsed = GetAllSourceOverlapQueryParams.safeParse(req.query);
  if (!parsed.success) {
    validationError(res, parsed.error.issues.map((issue) => issue.message).join("; "));
    return;
  }
  try {
    const result = await getCachedAllSourceOverlap(parsed.data.symbol, parsed.data.interval, {
      minStrength: parsed.data.minStrength,
      limit: parsed.data.limit,
      includeLive: parsed.data.includeLive,
      liveBudgetMs: parsed.data.liveBudgetMs,
    });
    sendCached(res, req, result, 8);
  } catch (err) {
    const status = runtimeErrorStatus(err);
    res.status(status).json({
      ok: false,
      error: status === 400 ? errorMessage(err) : "Failed to compute all-source overlap levels",
      detail: errorMessage(err),
    });
  }
}

app.get("/api/levels/all-source-overlap", serveAllSourceOverlap);
app.get("/api/levels/confluence-overlay", serveAllSourceOverlap);

app.get("/api/levels/overlay", async (req, res) => {
  const parsed = GetLevelsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    validationError(res, parsed.error.issues.map((issue) => issue.message).join("; "));
    return;
  }
  try {
    const result = await getCachedLevelsOverlay(parsed.data.symbol, parsed.data.interval);
    sendCached(res, req, result, 15);
  } catch (err) {
    const status = runtimeErrorStatus(err);
    res.status(status).json({ ok: false, error: status === 400 ? errorMessage(err) : "Failed to compute levels overlay", detail: errorMessage(err) });
  }
});

app.get("/api/levels/prewarm", (req, res) => {
  const parsed = GetAllSourceOverlapQueryParams.safeParse(req.query);
  if (!parsed.success) {
    validationError(res, parsed.error.issues.map((issue) => issue.message).join("; "));
    return;
  }
  prewarmAllSourceOverlap(parsed.data.symbol, parsed.data.interval, {
    minStrength: parsed.data.minStrength,
    limit: parsed.data.limit,
    includeLive: parsed.data.includeLive,
    liveBudgetMs: parsed.data.liveBudgetMs,
  });
  res.json({
    ok: true,
    symbol: parsed.data.symbol,
    interval: parsed.data.interval,
    displayMode: "all-source-overlap-only",
    minStrength: parsed.data.minStrength,
    limit: parsed.data.limit,
    includeLive: parsed.data.includeLive,
    liveBudgetMs: parsed.data.liveBudgetMs,
  });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not found", path: req.path });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`levels-engine-v1.4 backend listening on port ${port}`);
});
