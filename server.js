import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import katex from "katex";
import puppeteer from "puppeteer";
import sharp from "sharp";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "20mb" }));

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

app.post("/renderRaw", async (req, res) => {
  const latex = String(req.body.latex || "").trim();
  if (!latex) return res.status(400).json({ error: "Missing LaTeX" });

  const tileHeight = Math.max(1, Number(req.body.tileHeight) || 8);
  const fontSize = Number(req.body.fontSize) || 48;

  try {
    // Render LaTeX with KaTeX
    const html = katex.renderToString(latex, {
      throwOnError: false,
      displayMode: true,
    });

    // Dynamic sizing container
    const pageHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8"/>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css">
        <style>
          body {
            margin: 0;
            display: inline-block;
            background: transparent;
          }
          .katex {
            font-size: ${fontSize}px;
            color: white;
          }
        </style>
      </head>
      <body>${html}</body>
      </html>
    `;

    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();
    await page.setContent(pageHTML, { waitUntil: "networkidle0" });

    // Measure the rendered element dynamically
    const element = await page.$("body");
    const boundingBox = await element.boundingBox();
    const pngBuffer = await element.screenshot({
      omitBackground: true,
      clip: {
        x: boundingBox.x,
        y: boundingBox.y,
        width: Math.ceil(boundingBox.width),
        height: Math.ceil(boundingBox.height),
      },
    });
    await browser.close();

    // Convert PNG to raw RGBA
    const { data, info } = await sharp(pngBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const tiles = splitBufferToTiles(data, info.width, info.height, info.channels, tileHeight);

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
app.listen(PORT, () => console.log(`KaTeX Renderer (puppeteer) running on port ${PORT}`));
