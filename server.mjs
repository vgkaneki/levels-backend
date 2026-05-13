import express from "express";

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

let enginePromise = null;

async function loadEngine() {
  if (!enginePromise) {
    enginePromise = import("./exported-levels-engine/dist/index.js");
  }
  return enginePromise;
}

function errorPayload(err) {
  return {
    message: err instanceof Error ? err.message : String(err),
    name: err instanceof Error ? err.name : "Error",
    stack: err instanceof Error ? err.stack : undefined,
  };
}

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
    mode: "render-safe-dynamic-engine-import",
    endpoints: [
      "/api/health",
      "/api/engine-check",
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
    build: "v1.4-backend-host-render-safe-v2",
    time: new Date().toISOString(),
  });
});

app.get("/api/engine-check", async (_req, res) => {
  try {
    const engine = await loadEngine();
    res.json({
      ok: true,
      engineLoaded: true,
      checkedMethodsCount: engine.ALL_SOURCE_OVERLAP_CHECKED_METHODS?.length ?? null,
      exports: Object.keys(engine).sort(),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      engineLoaded: false,
      error: errorPayload(err),
      hint: "The backend server is running, but exported-levels-engine/dist/index.js failed to import. The engine file may be incomplete or malformed.",
    });
  }
});

app.get("/api/levels", async (req, res) => {
  try {
    const engine = await loadEngine();
    const parsed = engine.GetLevelsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      validationError(res, parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }

    const result = await engine.getCachedLevels(parsed.data.symbol, parsed.data.interval);
    engine.sendCached(res, req, result, 30);
  } catch (err) {
    const status = runtimeErrorStatus(err);
    res.status(status).json({
      ok: false,
      error: status === 400 ? errorMessage(err) : "Failed to compute levels",
      detail: errorMessage(err),
      raw: errorPayload(err),
    });
  }
});

async function serveAllSourceOverlap(req, res) {
  try {
    const engine = await loadEngine();
    const parsed = engine.GetAllSourceOverlapQueryParams.safeParse(req.query);
    if (!parsed.success) {
      validationError(res, parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }

    const result = await engine.getCachedAllSourceOverlap(parsed.data.symbol, parsed.data.interval, {
      minStrength: parsed.data.minStrength,
      limit: parsed.data.limit,
      includeLive: parsed.data.includeLive,
      liveBudgetMs: parsed.data.liveBudgetMs,
    });

    engine.sendCached(res, req, result, 8);
  } catch (err) {
    const status = runtimeErrorStatus(err);
    res.status(status).json({
      ok: false,
      error: status === 400 ? errorMessage(err) : "Failed to compute all-source overlap levels",
      detail: errorMessage(err),
      raw: errorPayload(err),
    });
  }
}

app.get("/api/levels/all-source-overlap", serveAllSourceOverlap);
app.get("/api/levels/confluence-overlay", serveAllSourceOverlap);

app.get("/api/levels/overlay", async (req, res) => {
  try {
    const engine = await loadEngine();
    const parsed = engine.GetLevelsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      validationError(res, parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }

    const result = await engine.getCachedLevelsOverlay(parsed.data.symbol, parsed.data.interval);
    engine.sendCached(res, req, result, 15);
  } catch (err) {
    const status = runtimeErrorStatus(err);
    res.status(status).json({
      ok: false,
      error: status === 400 ? errorMessage(err) : "Failed to compute levels overlay",
      detail: errorMessage(err),
      raw: errorPayload(err),
    });
  }
});

app.get("/api/levels/prewarm", async (req, res) => {
  try {
    const engine = await loadEngine();
    const parsed = engine.GetAllSourceOverlapQueryParams.safeParse(req.query);
    if (!parsed.success) {
      validationError(res, parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }

    engine.prewarmAllSourceOverlap(parsed.data.symbol, parsed.data.interval, {
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
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "Failed to prewarm all-source overlap levels",
      detail: errorMessage(err),
      raw: errorPayload(err),
    });
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not found", path: req.path });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`levels-engine-v1.4 backend listening on port ${port}`);
});
