
import express from "express";
import cors from "cors";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import WebSocket from "ws";

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Upload a JPG, PNG, or WebP image."));
  }
});

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "GUYPREDICTION AI",
    message: "AI analysis backend is running."
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    apiKeyConfigured: Boolean(process.env.GEMINI_API_KEY)
  });
});

// PUBLIC MARKET DATA
const marketCache = new Map();

const marketSymbols = new Set([
  "XAUUSD", "EURUSD", "GBPUSD", "USDJPY",
  "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "BTCUSD"
]);

const marketIntervals = new Set([
  "1m", "5m", "15m", "30m", "1h", "4h", "1d"
]);

async function getCachedJson(url, ttlMs = 10000) {
  const cached = marketCache.get(url);

  if (cached && Date.now() - cached.time < ttlMs) {
    return cached.data;
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(9000)
  });

  if (!response.ok) {
    let detail = "";

    try {
      const body = await response.json();
      detail = body.message || body.error || "";
    } catch {}

    throw new Error(
      `Market provider HTTP ${response.status}` +
      (detail ? `: ${detail}` : "")
    );
  }

  const data = await response.json();

  marketCache.set(url, {
    time: Date.now(),
    data
  });

  return data;
}

// LIVE / LAST KNOWN PRICE
app.get("/api/market/quote", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").toUpperCase();

    if (!marketSymbols.has(symbol)) {
      return res.status(400).json({
        error: "Unsupported market symbol."
      });
    }

    // Allow the provider to return the last known price
    // when the market is closed.
    const data = await getCachedJson(
      `https://biquote.io/api/${symbol}`,
      5000
    );

    res.json({
      ...data,
      provider: "biquote.io",
      retrievedAt: new Date().toISOString(),
      priceLabel: data.marketState === "closed" || data.stale
        ? "LAST KNOWN PRICE — NOT LIVE"
        : "LIVE PRICE"
    });

  } catch (error) {
    res.status(502).json({
      error: "Market quote unavailable: " + error.message
    });
  }
});

// HISTORICAL CANDLES
app.get("/api/market/ohlc", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").toUpperCase();
    const interval = String(req.query.interval || "15m");

    const limit = Math.max(
      50,
      Math.min(500, Number(req.query.limit) || 200)
    );

    if (
      !marketSymbols.has(symbol) ||
      !marketIntervals.has(interval)
    ) {
      return res.status(400).json({
        error: "Unsupported symbol or timeframe."
      });
    }

    const data = await getCachedJson(
      `https://biquote.io/api/${symbol}/ohlc?interval=${encodeURIComponent(interval)}&limit=${limit}`,
      15000
    );

    res.json({
      ...data,
      provider: "biquote.io",
      retrievedAt: new Date().toISOString()
    });

  } catch (error) {
    res.status(502).json({
      error: "Candle data unavailable: " + error.message
    });
  }
});

// ECONOMIC CALENDAR
app.get("/api/calendar", async (req, res) => {
  try {
    const days = Math.max(
      1,
      Math.min(14, Number(req.query.days) || 7)
    );

    const from = new Date().toISOString();
    const to = new Date(
      Date.now() + days * 86400000
    ).toISOString();

    const url = new URL("https://biquote.io/api/calendar");

    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    url.searchParams.set(
      "countries",
      "US,EU,GB,JP,CA,AU,NZ,CH"
    );
    url.searchParams.set("importance", "high");
    url.searchParams.set("limit", "200");

    const events = await getCachedJson(
      url.toString(),
      60000
    );

    res.json({
      events,
      provider: "biquote.io",
      retrievedAt: new Date().toISOString(),
      timezone: "UTC"
    });

  } catch (error) {
    res.status(502).json({
      error: "Economic calendar unavailable: " + error.message
    });
  }
});

// AI SCREENSHOT ANALYSIS


// DERIV PUBLIC MARKET DATA
const derivWsUrl = "wss://api.derivws.com/trading/v1/options/ws/public";
let derivSymbolsCache = { time: 0, symbols: [] };

function derivRequest(payload, expectedType, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(derivWsUrl);
    const reqId = Math.floor(Date.now() % 1000000000);
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(new Error("Deriv request timed out."));
    }, timeoutMs);

    ws.on("open", () => {
      ws.send(JSON.stringify({ ...payload, req_id: reqId }));
    });

    ws.on("message", raw => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (data.error) {
        finish(new Error(data.error.message || "Deriv API error."));
        return;
      }

      if (
        data.req_id === reqId ||
        data.msg_type === expectedType
      ) {
        finish(null, data);
      }
    });

    ws.on("error", error => finish(error));

    ws.on("close", () => {
      if (!settled) {
        finish(new Error("Deriv connection closed."));
      }
    });
  });
}

// Discover available synthetic indices from Deriv
async function getDerivSyntheticSymbols() {
  if (
    derivSymbolsCache.symbols.length &&
    Date.now() - derivSymbolsCache.time < 300000
  ) {
    return derivSymbolsCache.symbols;
  }

  const response = await derivRequest(
    { active_symbols: "brief" },
    "active_symbols"
  );

  const all =
    response.active_symbols ||
    response.data?.active_symbols ||
    [];

  const symbols = all
    .filter(item =>
      item.market === "synthetic_index" ||
      item.market === "synthetic"
    )
    .map(item => ({
      symbol: item.underlying_symbol || item.symbol,
      name:
        item.underlying_symbol_name ||
        item.display_name ||
        item.symbol,
      market: item.market,
      subgroup: item.subgroup,
      isOpen: item.exchange_is_open !== 0,
      suspended: item.is_trading_suspended === 1
    }))
    .filter(item => item.symbol);

  derivSymbolsCache = {
    time: Date.now(),
    symbols
  };

  return symbols;
}

// GET AVAILABLE SYNTHETIC INDICES
app.get("/api/deriv/symbols", async (req, res) => {
  try {
    const symbols = await getDerivSyntheticSymbols();

    res.json({
      success: true,
      count: symbols.length,
      symbols,
      provider: "Deriv",
      retrievedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(502).json({
      error: "Deriv symbols unavailable: " + error.message
    });
  }
});

// GET LIVE SYNTHETIC INDEX PRICE
app.get("/api/deriv/quote", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "");
    const symbols = await getDerivSyntheticSymbols();

    if (!symbols.some(item => item.symbol === symbol)) {
      return res.status(400).json({
        error: "Unknown Deriv symbol. Check /api/deriv/symbols."
      });
    }

    const response = await derivRequest(
      { ticks: symbol },
      "tick"
    );

    const tick = response.tick || response.data?.tick;

    if (!tick || tick.quote === undefined) {
      throw new Error("No price returned by Deriv.");
    }

    res.json({
      symbol,
      name:
        symbols.find(item => item.symbol === symbol)?.name ||
        symbol,
      price: Number(tick.quote),
      epoch: tick.epoch,
      timestamp: tick.epoch
        ? new Date(tick.epoch * 1000).toISOString()
        : null,
      provider: "Deriv",
      retrievedAt: new Date().toISOString(),
      live: true
    });
  } catch (error) {
    res.status(502).json({
      error: "Deriv quote unavailable: " + error.message
    });
  }
});

// GET SYNTHETIC INDEX CANDLES
app.get("/api/deriv/ohlc", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "");
    const granularity = Number(req.query.granularity || 900);
    const count = Math.max(
      50,
      Math.min(500, Number(req.query.count) || 200)
    );

    const allowed = new Set([
      60, 120, 180, 300, 600, 900,
      1800, 3600, 7200, 14400, 28800, 86400
    ]);

    const symbols = await getDerivSyntheticSymbols();

    if (!symbols.some(item => item.symbol === symbol)) {
      return res.status(400).json({
        error: "Unknown Deriv symbol. Check /api/deriv/symbols."
      });
    }

    if (!allowed.has(granularity)) {
      return res.status(400).json({
        error: "Unsupported candle timeframe."
      });
    }

    const response = await derivRequest({
      ticks_history: symbol,
      count,
      end: "latest",
      style: "candles",
      granularity
    }, "history", 12000);

    const candles =
      response.candles ||
      response.history?.candles ||
      response.data?.candles ||
      [];

    res.json({
      success: true,
      symbol,
      intervalSeconds: granularity,
      candles,
      count: candles.length,
      provider: "Deriv",
      retrievedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(502).json({
      error: "Deriv candles unavailable: " + error.message
    });
  }
});
app.post("/api/analyze", upload.single("chart"), async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is missing."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Please upload a chart screenshot."
      });
    }

    const market = String(req.body.market || "XAUUSD");
    const timeframe = String(req.body.timeframe || "Unknown");
    const notes = String(req.body.notes || "");

    const prompt = `
You are GUYPREDICTION AI, a professional trading analyst.

Market: ${market}
Timeframe: ${timeframe}
Notes: ${notes}

Analyze using:
- Smart Money Concepts
- ICT
- Candle Range Theory
- Market structure
- BOS and CHoCH
- Liquidity sweeps
- Fair Value Gaps
- Support and resistance

Use this format:

DECISION: BUY / SELL / WAIT

MARKET BIAS:

MARKET STRUCTURE:

LIQUIDITY:

FVG:

CRT:

ENTRY ZONE:

STOP LOSS:

TAKE PROFIT 1:

TAKE PROFIT 2:

RISK TO REWARD:

CONFIDENCE:
Give a subjective score from 0% to 100%.
This is not a measured probability.

WHAT TO DO NOW:

REASONING:

IMPORTANT:
Never invent prices or claim access to live data.
Only use information visible in the screenshot.
If unclear, choose WAIT.
Never guarantee profits.
`;

    const ai = new GoogleGenAI({ apiKey });

    let result;
    let lastError;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await ai.models.generateContent({
          model: "gemini-3.5-flash-lite",
          contents: [{
            role: "user",
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: req.file.mimetype,
                  data: req.file.buffer.toString("base64")
                }
              }
            ]
          }]
        });

        break;

      } catch (error) {
        lastError = error;
        const message = String(error.message || error);

        if (
          !/503|UNAVAILABLE|429|RESOURCE_EXHAUSTED|500|502|504/i.test(message) ||
          attempt === 2
        ) {
          throw error;
        }

        const delay = 2000 * Math.pow(2, attempt);

        console.log(`Gemini retry ${attempt + 1} in ${delay}ms`);

        await new Promise(resolve =>
          setTimeout(resolve, delay)
        );
      }
    }

    if (!result) {
      throw lastError || new Error("No AI response.");
    }

    return res.json({
      success: true,
      market,
      timeframe,
      analysis: result.text || "No analysis returned."
    });

  } catch (error) {
    console.error("Analysis error:", error);

    return res.status(500).json({
      error: "AI analysis failed: " +
        String(error.message || error).slice(0, 400)
    });
  }
});

// ERROR HANDLER
app.use((error, req, res, next) => {
  console.error("Request error:", error);

  res.status(400).json({
    error: error.message || "Invalid request."
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(
    "GUYPREDICTION AI backend running on port " + port
  );
});
