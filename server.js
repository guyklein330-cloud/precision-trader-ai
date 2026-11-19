
import express from "express";
import cors from "cors";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Upload a JPG, PNG, or WebP image."));
    }
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

app.post("/api/analyze", upload.single("chart"), async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is missing in Render environment variables."
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
You are GUYPREDICTION AI, a professional trading chart analyst.

Market: ${market}
Timeframe: ${timeframe}
User notes: ${notes}

Analyze the uploaded chart using:
- Smart Money Concepts (SMC)
- ICT concepts
- Candle Range Theory (CRT)
- Market structure
- BOS and CHoCH
- Liquidity sweeps
- Fair Value Gaps
- Support and resistance

Use this exact response format:

DECISION: BUY / SELL / WAIT

MARKET BIAS:
Explain bullish, bearish or neutral direction.

MARKET STRUCTURE:
Explain BOS or CHoCH if visible.

LIQUIDITY:
Identify liquidity sweeps if visible.

FVG:
Identify imbalance if visible.

CRT:
Identify the range high and low if possible.

ENTRY ZONE:
STOP LOSS:
TAKE PROFIT 1:
TAKE PROFIT 2:
RISK TO REWARD:

CONFIDENCE:
Give a subjective estimate from 0% to 100%.
This is not a measured probability.

WHAT TO DO NOW:
Give one clear trading instruction.

REASONING:
Explain the decision.

IMPORTANT:
Never invent prices or claim access to live market data.
Only use information visible in the screenshot.
If the chart is unclear, choose WAIT.
Never guarantee profits.
`;

    const ai = new GoogleGenAI({ apiKey });

    let result;
let lastError;

for (let attempt = 0; attempt < 3; attempt++) {
  try {
    result = await ai.models.generateContent({
      model: "gemini-3.5-flash-lite",
      contents: [
        {
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
        }
      ]
    });

    break;
  } catch (error) {
    lastError = error;
    const message = String(error.message || error);

    if (!/503|UNAVAILABLE|429|RESOURCE_EXHAUSTED|500|502|504/i.test(message)) {
      throw error;
    }

    if (attempt === 2) throw error;

    const delay = 2000 * Math.pow(2, attempt);
    console.log(`Gemini retry ${attempt + 1} in ${delay}ms`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

if (!result) throw lastError || new Error("No AI response.");

    return res.json({
      success: true,
      market,
      timeframe,
      analysis: result.text || "No analysis returned."
    });

  } catch (error) {
    console.error("Analysis error:", error);

    return res.status(500).json({
      error: "AI analysis failed: " + String(error.message || error).slice(0, 400)
    });
  }
});

app.use((error, req, res, next) => {
  console.error("Request error:", error);
  res.status(400).json({
    error: error.message || "Invalid request."
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log("GUYPREDICTION AI backend running on port " + port);
});
