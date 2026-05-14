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

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

const CANDLE_INTERVAL_MS = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "2h": 2 * 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "8h": 8 * 60 * 60_000,
  "12h": 12 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "3d": 3 * 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

function normalizeCandleSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function normalizeCandleInterval(interval) {
  const raw = String(interval || "4h").trim();
  if (Object.prototype.hasOwnProperty.call(CANDLE_INTERVAL_MS, raw)) return raw;
  const lower = raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CANDLE_INTERVAL_MS, lower)) return lower;
  return raw;
}

function parseCandleLimit(raw) {
  const n = Number(raw ?? 500);
  if (!Number.isFinite(n) || n <= 0) return 500;
  return Math.max(1, Math.min(5000, Math.floor(n)));
}

function normalizeHyperliquidCandle(c) {
  const time = Number(c.t ?? c.time ?? c.timestamp);
  const open = Number(c.o ?? c.open);
  const high = Number(c.h ?? c.high);
  const low = Number(c.l ?? c.low);
  const close = Number(c.c ?? c.close);
  const volume = Number(c.v ?? c.volume ?? 0);

  if (![time, open, high, low, close].every(Number.isFinite)) return null;

  return {
    time,
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) ? volume : 0,
  };
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "levels-engine-v1.4-backend-host",
    mode: "render-safe-dynamic-engine-import",
    endpoints: [
      "/api/health",
      "/api/engine-check",
      "/api/market-data/candles?symbol=BTC&interval=4h&limit=20",
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
    build: "v1.4-backend-host-render-safe-v3-candles",
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

app.get("/api/market-data/candles", async (req, res) => {
  const symbol = normalizeCandleSymbol(req.query.symbol);
  const interval = normalizeCandleInterval(req.query.interval);
  const limit = parseCandleLimit(req.query.limit);

  if (!symbol) {
    validationError(res, "symbol is required");
    return;
  }

  const stepMs = CANDLE_INTERVAL_MS[interval];
  if (!stepMs) {
    validationError(res, `Unsupported interval: ${interval}. Supported intervals: ${Object.keys(CANDLE_INTERVAL_MS).join(", ")}`);
    return;
  }

  const endTime = Date.now();
  const startTime = endTime - stepMs * limit;

  try {
    const hlRes = await fetch(HL_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "candleSnapshot",
        req: {
          coin: symbol,
          interval,
          startTime,
          endTime,
        },
      }),
    });

    if (!hlRes.ok) {
      const detail = await hlRes.text().catch(() => "");
      res.status(502).json({
        ok: false,
        error: "Failed to fetch candles from Hyperliquid",
        detail,
      });
      return;
    }

    const raw = await hlRes.json();
    if (!Array.isArray(raw)) {
      res.status(502).json({
        ok: false,
        error: "Unexpected Hyperliquid candle response shape",
        detail: typeof raw === "object" ? JSON.stringify(raw).slice(0, 500) : String(raw),
      });
      return;
    }

    const candles = raw
      .map(normalizeHyperliquidCandle)
      .filter(Boolean)
      .sort((a, b) => a.time - b.time);

    res.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=30");
    res.json({
      ok: true,
      symbol,
      interval,
      source: "hyperliquid",
      candles,
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: "Failed to fetch candles",
      detail: errorMessage(err),
      raw: errorPayload(err),
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
