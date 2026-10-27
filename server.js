
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
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

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
    service: "Precision Trader AI",
    message: "AI analysis backend is running."
  });
});

app.post("/api/analyze", upload.single("chart"), async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "Server API key is not configured."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Please upload a chart screenshot."
      });
    }

    const market = String(req.body.market || "XAUUSD").slice(0, 50);
    const timeframe = String(req.body.timeframe || "Unknown").slice(0, 30);

    const ai = new GoogleGenAI({ apiKey });

    
const prompt = `
You are Precision Trader AI, a clear and practical trading chart assistant.

Analyze the uploaded chart using Smart Money Concepts (SMC) and Candle Range Theory (CRT). Explain everything in simple English.

Market: ${market}
Timeframe: ${timeframe}

Use this exact response format:

DECISION: BUY, SELL, or WAIT

CURRENT SITUATION:
Explain the current market direction briefly.

PRICE TO WATCH:
Give the exact price level visible on the chart. Never invent a price.

BUY PLAN:
Watch price at: [price or Not identifiable]
Condition: Explain what bullish confirmation is needed.
Entry: [price or Not identifiable]
Stop Loss: [price or Not identifiable]
Take Profit 1: [price or Not identifiable]
Take Profit 2: [price or Not identifiable]

SELL PLAN:
Watch price at: [price or Not identifiable]
Condition: Explain what bearish confirmation is needed.
Entry: [price or Not identifiable]
Stop Loss: [price or Not identifiable]
Take Profit 1: [price or Not identifiable]
Take Profit 2: [price or Not identifiable]

CONFIDENCE:
Give an estimated confidence percentage from 0% to 100%, based on visible evidence. This is a subjective estimate, not a measured probability.

WHAT TO DO NOW:
Give one clear instruction:
- WAIT for a specific price or confirmation.
- Consider BUY only after the stated bullish confirmation.
- Consider SELL only after the stated bearish confirmation.

WHY:
Explain the main reason in no more than 3 short sentences.

IMPORTANT RULES:
- Analyze only information visible in the screenshot.
- Never invent prices, candles, or live market data.
- Do not assume the current price if it is not visible.
- Do not recommend entering just because price reaches a level.
- Require suitable confirmation before suggesting an entry.
- If the chart is unclear or evidence conflicts, choose WAIT.
- If an entry, stop loss, or target cannot be identified reliably, say "Not identifiable."
- Keep the response short, clear, and easy for a beginner.
- Never guarantee profits.
- This is educational analysis, not financial advice.
`;
    
    const result = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: [
        {
          inlineData: {
            mimeType: req.file.mimetype,
            data: req.file.buffer.toString("base64")
          }
        },
        prompt
      ]
    });

    return res.json({
      success: true,
      market,
      timeframe,
      analysis: result.text || "No analysis was returned."
    });
  } catch (error) {
    console.error("Analysis error:", error.message);

    return res.status(500).json({
      error: "Analysis failed. Check the server logs and API configuration."
    });
  }
});

app.use((error, req, res, next) => {
  res.status(400).json({
    error: error.message || "Invalid request."
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Precision Trader AI running on port ${port}`);
});
