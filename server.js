
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
You are Precision Trader AI, an educational chart-analysis assistant.

Analyze the uploaded trading chart using:
- Smart Money Concepts (SMC)
- Change of Character (CHoCH)
- Break of Structure (BOS)
- Liquidity sweeps
- Fair Value Gaps (FVG)
- CRT concepts, if identifiable

Market: ${market}
Timeframe: ${timeframe}

Return these sections:
1. Decision: BUY, SELL, or WAIT
2. Market structure and directional bias
3. Important liquidity and price levels visible in the screenshot
4. Possible entry zone, or "Not identifiable"
5. Stop-loss idea and take-profit targets, or "Not identifiable"
6. Estimated setup confidence from 0 to 100 percent
7. What would invalidate the setup
8. Brief explanation of the reasoning

Rules:
- Analyze only what is actually visible.
- Do not invent prices, candles, live prices, or market data.
- If price labels or structure are unclear, say so.
- Do not claim that a setup is guaranteed or that you have live market data.
- If evidence is insufficient or conflicting, choose WAIT.
- Confidence is a subjective estimate, not a measured probability.
- This is educational analysis, not a guarantee of profit.
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
