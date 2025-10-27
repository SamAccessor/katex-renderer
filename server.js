import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import katex from "katex";
import puppeteer from "puppeteer"; // normal puppeteer with bundled Chromium
import sharp from "sharp";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "20mb" }));

// Helper: split raw RGBA buffer into tiles
function splitBufferToTiles(rawBuffer, width, height, channels, tileHeight = 8) {
  const tiles = [];
  const bytesPerRow = width * channels;
  for (let y = 0; y < height; y += tileHeight) {
    const rows = Math.min(tileHeight, height - y);
    const start = y * bytesPerRow;
    const end = start + bytesPerRow * rows;
    tiles.push(rawBuffer.slice(start, end).toString("base64"));
  }
  return tiles;
}

// POST /renderRaw endpoint
app.post("/renderRaw", async (req, res) => {
  const latex = String(req.body.latex || "").trim();
  if (!latex) return res.status(400).json({ error: "Missing LaTeX" });

  console.log("[RenderRaw] Rendering:", latex);

  const width = Number(req.body.width) || 512;
  const height = Number(req.body.height) || 128;
  const tileHeight = Math.max(1, Number(req.body.tileHeight) || 8);

  try {
    // Generate KaTeX HTML
    const html = katex.renderToString(latex, {
      throwOnError: false,
      displayMode: true,
      output: "html",
    });

    // Full HTML template for Puppeteer
    const pageHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8"/>
        <style>
          body {
            margin: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            width: ${width}px;
            height: ${height}px;
            background: transparent;
          }
          .katex {
            color: white;
            font-size: 48px;
          }
        </style>
      </head>
      <body>${html}</body>
      </html>
    `;

    // Launch Puppeteer with bundled Chromium
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"], // required for Render
    });

    const page = await browser.newPage();
    await page.setContent(pageHTML, { waitUntil: "networkidle0" });
    const element = await page.$("body");
    const pngBuffer = await element.screenshot({ omitBackground: true });
    await browser.close();

    // Convert to raw RGBA using Sharp
    const { data, info } = await sharp(pngBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const tiles = splitBufferToTiles(data, info.width, info.height, info.channels, tileHeight);

    console.log("[RenderRaw] ✅ PNG Render successful.");
    res.json({
      width: info.width,
      height: info.height,
      channels: info.channels,
      tileHeight,
      tiles,
      pngBase64: pngBuffer.toString("base64"),
    });
  } catch (err) {
    console.error("[RenderRaw] ❌ ERROR:", err);
    res.status(500).json({ error: err.toString() });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`KaTeX Renderer running on port ${PORT}`));