// server.js
// npm install express cors body-parser puppeteer sharp katex

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import katex from "katex";
import puppeteer from "puppeteer";
import sharp from "sharp";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "20mb" }));

// Utility: split raw RGBA buffer into base64 tiles
function makeTilesFromRawBuffer(rawBuffer, width, height, channels, tileHeight = 8) {
  const tiles = [];
  const bytesPerRow = width * channels;
  for (let y = 0; y < height; y += tileHeight) {
    const h = Math.min(tileHeight, height - y);
    const start = y * bytesPerRow;
    const end = start + bytesPerRow * h;
    const slice = rawBuffer.slice(start, end);
    tiles.push(slice.toString("base64"));
  }
  return tiles;
}

// Create HTML wrapper for KaTeX
function buildKaTeXHtml(latex, fontSize = 48) {
  const math = katex.renderToString(latex, {
    throwOnError: false,
    displayMode: true,
    strict: false,
  });
  return `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
    <style>
      html, body {
        margin: 0; padding: 0; background: transparent;
      }
      .container {
        display: flex; align-items: center; justify-content: center;
        width: 100vw; height: 100vh;
      }
      .math {
        color: white !important;
        font-size: ${fontSize}px;
        line-height: 1;
      }
    </style>
  </head>
  <body>
    <div class="container"><div class="math">${math}</div></div>
  </body>
  </html>`;
}

// POST /renderRaw
app.post("/renderRaw", async (req, res) => {
  const start = Date.now();

  try {
    const latex = String(req.body.latex || "").trim();
    if (!latex) {
      return res.status(400).json({ error: "Missing LaTeX string" });
    }

    const outW = Number(req.body.width) || 512;
    const outH = Number(req.body.height) || 128;
    const tileHeight = Math.max(1, Number(req.body.tileHeight) || 8);
    const supersample = Math.max(1, Number(req.body.scale) || 2);
    const fontSize = Number(req.body.fontSize) || 48;

    console.log("[RenderRaw] Starting render:", latex);

    // Launch Puppeteer
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    const html = buildKaTeXHtml(latex, fontSize * supersample);
    await page.setViewport({
      width: outW * supersample,
      height: outH * supersample,
      deviceScaleFactor: 1,
    });
    await page.setContent(html, { waitUntil: "networkidle0" });

    // Screenshot KaTeX output (transparent background)
    const pngBuffer = await page.screenshot({ omitBackground: true });
    await browser.close();

    console.log("[RenderRaw] Screenshot captured, size:", pngBuffer.length, "bytes");

    // Resize and convert to raw RGBA buffer
    const resized = await sharp(pngBuffer)
      .resize(outW, outH, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = resized;
    console.log("[RenderRaw] Sharp processed:", info);

    // Split into tiles
    const tiles = makeTilesFromRawBuffer(data, info.width, info.height, info.channels, tileHeight);

    console.log("[RenderRaw] Generated", tiles.length, "tiles");

    // ✅ RETURN the data
    res.json({
      width: info.width,
      height: info.height,
      channels: info.channels,
      tileHeight,
      tiles,
      elapsedMs: Date.now() - start,
    });

  } catch (err) {
    console.error("[RenderRaw] ERROR:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// healthcheck
app.get("/", (req, res) => res.send("✅ KaTeX RGBA renderer running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});