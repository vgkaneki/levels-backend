import express from "express";
import WebSocket from "ws";

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
const HL_WS_URL = "wss://api.hyperliquid.xyz/ws";

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

const FETCH_TIMEOUT_MS = 12_000;
const LIVE_HEARTBEAT_MS = 15_000;
const LIVE_IDLE_CLOSE_MS = 12_000;
const LIVE_STALE_RECONNECT_MS = 90_000;
const LIVE_MAX_BACKOFF_MS = 30_000;

function normalizeCandleSymbol(symbol) {
  return String(symbol || "").trim();
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

function normalizeTimeMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return n > 1e11 ? Math.floor(n) : Math.floor(n * 1000);
}

function normalizeHyperliquidCandle(c) {
  const time = normalizeTimeMs(c?.t ?? c?.time ?? c?.timestamp ?? c?.T);
  const open = Number(c?.o ?? c?.open);
  const high = Number(c?.h ?? c?.high);
  const low = Number(c?.l ?? c?.low);
  const close = Number(c?.c ?? c?.close);
  const volume = Number(c?.v ?? c?.volume ?? 0);

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

function sseWrite(res, event, data) {
  if (res.destroyed || res.writableEnded) return false;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  return true;
}

function extractLiveCandle(payload) {
  const raw = payload?.data?.candle ?? payload?.data ?? payload?.candle ?? payload;
  return normalizeHyperliquidCandle(raw);
}

async function fetchWithTimeout(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function liveRoomKey(symbol, interval) {
  return `${symbol}|${interval}`;
}

const liveRooms = new Map();

function createLiveRoom(symbol, interval) {
  return {
    key: liveRoomKey(symbol, interval),
    symbol,
    interval,
    clients: new Set(),
    ws: null,
    status: "idle",
    startedAt: Date.now(),
    lastAnyMessageAt: 0,
    lastCandleAt: 0,
    latestCandle: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
    heartbeatTimer: null,
    staleTimer: null,
    idleCloseTimer: null,
    closeRequested: false,
  };
}

function getLiveRoom(symbol, interval) {
  const key = liveRoomKey(symbol, interval);
  let room = liveRooms.get(key);
  if (!room) {
    room = createLiveRoom(symbol, interval);
    liveRooms.set(key, room);
  }
  return room;
}

function broadcastRoom(room, event, data) {
  for (const client of [...room.clients]) {
    if (!client.res || client.res.destroyed || client.res.writableEnded) {
      room.clients.delete(client);
      continue;
    }
    sseWrite(client.res, event, data);
  }
}

function setRoomStatus(room, status, extra = {}) {
  room.status = status;
  broadcastRoom(room, "status", {
    ok: status !== "error",
    source: "hyperliquid",
    mode: "shared-live-candle-stream",
    symbol: room.symbol,
    interval: room.interval,
    status,
    clients: room.clients.size,
    lastCandleAt: room.lastCandleAt || null,
    now: Date.now(),
    ...extra,
  });
}

function clearRoomTimers(room) {
  clearTimeout(room.reconnectTimer);
  clearInterval(room.heartbeatTimer);
  clearInterval(room.staleTimer);
  clearTimeout(room.idleCloseTimer);
  room.reconnectTimer = null;
  room.heartbeatTimer = null;
  room.staleTimer = null;
  room.idleCloseTimer = null;
}

function stopLiveRoom(room, reason = "stopped") {
  room.closeRequested = true;
  clearRoomTimers(room);
  try {
    if (room.ws && (room.ws.readyState === WebSocket.OPEN || room.ws.readyState === WebSocket.CONNECTING)) {
      room.ws.close(1000, reason);
    }
  } catch {
    // Ignore socket close failures.
  }
  room.ws = null;
  room.status = "idle";
}

function scheduleLiveReconnect(room, reason = "reconnect") {
  if (room.closeRequested || room.clients.size === 0) return;
  clearTimeout(room.reconnectTimer);
  const backoff = Math.min(LIVE_MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(room.reconnectAttempts, 5));
  const jitter = Math.floor(Math.random() * 800);
  const delay = backoff + jitter;
  room.reconnectAttempts += 1;
  setRoomStatus(room, "connecting", { reconnecting: true, reason, retryInMs: delay });
  room.reconnectTimer = setTimeout(() => {
    room.reconnectTimer = null;
    startLiveRoom(room);
  }, delay);
  room.reconnectTimer.unref?.();
}

function startRoomHeartbeat(room) {
  clearInterval(room.heartbeatTimer);
  clearInterval(room.staleTimer);

  room.heartbeatTimer = setInterval(() => {
    if (room.clients.size === 0) return;
    if (room.ws?.readyState === WebSocket.OPEN) {
      try {
        room.ws.ping?.();
      } catch {
        // Ignore ping errors; stale watchdog will reconnect if needed.
      }
    }
    broadcastRoom(room, "heartbeat", {
      ok: true,
      symbol: room.symbol,
      interval: room.interval,
      status: room.status,
      clients: room.clients.size,
      now: Date.now(),
      lastCandleAt: room.lastCandleAt || null,
      lastAnyMessageAt: room.lastAnyMessageAt || null,
    });
  }, LIVE_HEARTBEAT_MS);
  room.heartbeatTimer.unref?.();

  room.staleTimer = setInterval(() => {
    if (room.clients.size === 0 || room.status === "idle") return;
    const last = room.lastAnyMessageAt || room.startedAt;
    const age = Date.now() - last;
    if (age > LIVE_STALE_RECONNECT_MS) {
      broadcastRoom(room, "status", {
        ok: false,
        source: "hyperliquid",
        mode: "shared-live-candle-stream",
        symbol: room.symbol,
        interval: room.interval,
        status: "stale",
        ageMs: age,
        now: Date.now(),
      });
      try {
        room.ws?.terminate?.();
      } catch {
        // Ignore termination failures.
      }
      room.ws = null;
      scheduleLiveReconnect(room, "stale stream");
    }
  }, Math.max(20_000, Math.floor(LIVE_STALE_RECONNECT_MS / 3)));
  room.staleTimer.unref?.();
}

function startLiveRoom(room) {
  if (room.closeRequested) room.closeRequested = false;
  if (room.clients.size === 0) return;
  if (room.ws && (room.ws.readyState === WebSocket.OPEN || room.ws.readyState === WebSocket.CONNECTING)) return;

  room.startedAt = Date.now();
  room.lastAnyMessageAt = Date.now();
  setRoomStatus(room, "connecting");
  startRoomHeartbeat(room);

  const ws = new WebSocket(HL_WS_URL, {
    perMessageDeflate: false,
    handshakeTimeout: 10_000,
  });
  room.ws = ws;

  ws.on("open", () => {
    if (room.ws !== ws || room.closeRequested) return;
    room.reconnectAttempts = 0;
    room.lastAnyMessageAt = Date.now();
    try {
      ws.send(JSON.stringify({
        method: "subscribe",
        subscription: {
          type: "candle",
          coin: room.symbol,
          interval: room.interval,
        },
      }));
      setRoomStatus(room, "live", { connected: true, subscribed: true });
      if (room.latestCandle) {
        broadcastRoom(room, "candle", {
          ok: true,
          symbol: room.symbol,
          interval: room.interval,
          source: "backend-cache",
          receivedAt: Date.now(),
          candle: room.latestCandle,
        });
      }
    } catch (err) {
      broadcastRoom(room, "error", { ok: false, error: "Failed to subscribe Hyperliquid candle stream", detail: errorMessage(err) });
      scheduleLiveReconnect(room, "subscribe failed");
    }
  });

  ws.on("message", (data) => {
    if (room.ws !== ws || room.closeRequested) return;
    room.lastAnyMessageAt = Date.now();
    try {
      const payload = JSON.parse(String(data));
      if (payload?.channel && payload.channel !== "candle") return;
      const candle = extractLiveCandle(payload);
      if (!candle) return;
      room.lastCandleAt = Date.now();
      room.latestCandle = candle;
      room.status = "live";
      broadcastRoom(room, "candle", {
        ok: true,
        symbol: room.symbol,
        interval: room.interval,
        source: "hyperliquid-ws",
        receivedAt: room.lastCandleAt,
        candle,
      });
    } catch (err) {
      broadcastRoom(room, "error", { ok: false, error: "Failed to parse Hyperliquid candle stream message", detail: errorMessage(err) });
    }
  });

  ws.on("pong", () => {
    if (room.ws === ws) room.lastAnyMessageAt = Date.now();
  });

  ws.on("error", (err) => {
    if (room.ws !== ws || room.closeRequested) return;
    setRoomStatus(room, "error", { error: "Hyperliquid candle WebSocket error", detail: errorMessage(err) });
  });

  ws.on("close", (code, reason) => {
    if (room.ws === ws) room.ws = null;
    if (room.closeRequested || room.clients.size === 0) return;
    setRoomStatus(room, "connecting", { connected: false, closed: true, code, reason: String(reason || "") });
    scheduleLiveReconnect(room, `ws close ${code}`);
  });
}

function addLiveClient(room, req, res) {
  clearTimeout(room.idleCloseTimer);
  const client = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, res };
  room.clients.add(client);

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.write("retry: 2500\n\n");

  sseWrite(res, "status", {
    ok: true,
    source: "hyperliquid",
    mode: "shared-live-candle-stream",
    symbol: room.symbol,
    interval: room.interval,
    status: room.status,
    clients: room.clients.size,
    connectedAt: Date.now(),
    lastCandleAt: room.lastCandleAt || null,
  });

  if (room.latestCandle) {
    sseWrite(res, "candle", {
      ok: true,
      symbol: room.symbol,
      interval: room.interval,
      source: "backend-cache",
      receivedAt: Date.now(),
      candle: room.latestCandle,
    });
  }

  startLiveRoom(room);

  const cleanup = () => {
    room.clients.delete(client);
    if (room.clients.size === 0) {
      clearTimeout(room.idleCloseTimer);
      room.idleCloseTimer = setTimeout(() => {
        if (room.clients.size === 0) {
          stopLiveRoom(room, "idle");
          liveRooms.delete(room.key);
        }
      }, LIVE_IDLE_CLOSE_MS);
      room.idleCloseTimer.unref?.();
    } else {
      broadcastRoom(room, "status", {
        ok: true,
        source: "hyperliquid",
        mode: "shared-live-candle-stream",
        symbol: room.symbol,
        interval: room.interval,
        status: room.status,
        clients: room.clients.size,
        now: Date.now(),
      });
    }
  };

  req.on("close", cleanup);
  res.on("close", cleanup);
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
      "/api/market-data/candles/live?symbol=BTC&interval=1h",
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
    build: "v1.6-backend-host-shared-live-candles",
    liveRooms: liveRooms.size,
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
    const hlRes = await fetchWithTimeout(HL_INFO_URL, {
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
      mode: "snapshot",
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

app.get("/api/market-data/candles/live", (req, res) => {
  const symbol = normalizeCandleSymbol(req.query.symbol);
  const interval = normalizeCandleInterval(req.query.interval);

  if (!symbol) {
    validationError(res, "symbol is required");
    return;
  }

  if (!CANDLE_INTERVAL_MS[interval]) {
    validationError(res, `Unsupported interval: ${interval}. Supported intervals: ${Object.keys(CANDLE_INTERVAL_MS).join(", ")}`);
    return;
  }

  const room = getLiveRoom(symbol, interval);
  addLiveClient(room, req, res);
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
  console.log(`levels-engine-v1.6 backend listening on port ${port}`);
});
