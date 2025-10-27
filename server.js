// server.js
// npm i express cors body-parser puppeteer sharp katex
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import katex from "katex";
import puppeteer from "puppeteer";
import sharp from "sharp";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));

// Utility: make tiles from raw RGBA buffer
function makeTilesFromRawBuffer(rawBuffer, width, height, channels, tileHeight = 8) {
  const tiles = [];
  const bytesPerRow = width * channels;
  for (let y = 0; y < height; y += tileHeight) {
    const h = Math.min(tileHeight, height - y);
    const start = y * bytesPerRow;
    const slice = rawBuffer.slice(start, start + bytesPerRow * h);
    tiles.push(slice.toString("base64"));
  }
  return tiles;
}

// Small HTML wrapper for KaTeX with white text on transparent background
function katexHtml(latex, fontSize = 48) {
  const katexHtml = katex.renderToString(latex, {
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
        html,body { margin:0; padding:0; background: transparent; }
        .container {
          display:flex; align-items:center; justify-content:center;
          width:100%; height:100%;
        }
        .math {
          color: white !important;
          font-size: ${fontSize}px;
          line-height: 1;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="math">${katexHtml}</div>
      </div>
    </body>
  </html>
  `;
}

// POST /renderRaw
// body: { latex: string, width?:number, height?:number, tileHeight?:number, padding?:number, scale?:number }
// Returns JSON { width, height, channels, tileHeight, tiles[] }
app.post("/renderRaw", async (req, res) => {
  try {
    const latex = String(req.body.latex || "");
    const outW = Number(req.body.width) || 512;
    const outH = Number(req.body.height) || 128;
    const tileHeight = Math.max(1, Number(req.body.tileHeight) || 8);
    const supersample = Math.max(1, Number(req.body.scale) || 2);
    const fontSize = Number(req.body.fontSize) || 48;
    if (!latex) return res.status(400).json({ error: "missing latex" });

    // Render HTML + screenshot with puppeteer
    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      headless: "new",
    });
    const page = await browser.newPage();

    // set viewport large enough to capture; we'll crop/resize with sharp later
    const viewportW = Math.max(800, Math.ceil(outW * supersample));
    const viewportH = Math.max(200, Math.ceil(outH * supersample));
    await page.setViewport({ width: viewportW, height: viewportH, deviceScaleFactor: 1 });

    const html = katexHtml(latex, fontSize * supersample);
    await page.setContent(html, { waitUntil: "networkidle0" });

    // screenshot body, omit background for transparency
    const pngBuffer = await page.screenshot({ omitBackground: true });

    await browser.close();

    // Use sharp to measure/crop/resize:
    // 1) load screenshot buffer
    // 2) fit it into outW*outH using contain/center, using supersample factor
    const canvasW = outW * supersample;
    const canvasH = outH * supersample;

    // Resize screenshot to fit inside available area
    const resized = await sharp(pngBuffer)
      .resize(Math.round(outW * supersample), Math.round(outH * supersample), { fit: "contain", background: { r:0,g:0,b:0,alpha:0 } })
      .png()
      .toBuffer();

    // Compose centered onto transparent canvas sized canvasW x canvasH
    const composed = await sharp({
      create: { width: canvasW, height: canvasH, channels: 4, background: { r:0,g:0,b:0,alpha:0 } }
    }).composite([{ input: resized, gravity: "center" }])
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Downscale to final outW x outH (this yields antialiased result)
    const downscaled = await sharp(composed.data, {
      raw: { width: composed.info.width, height: composed.info.height, channels: composed.info.channels }
    }).resize(outW, outH, { fit: "contain" }).raw().toBuffer({ resolveWithObject: true });

    const rawBuffer = downscaled.data;
    const rawInfo = downscaled.info; // { width: outW, height: outH, channels: 4 }

    // Create base64 tiles
    const tiles = makeTilesFromRawBuffer(rawBuffer, rawInfo.width, rawInfo.height, rawInfo.channels, tileHeight);

    return res.json({
      width: rawInfo.width,
      height: rawInfo.height,
      channels: rawInfo.channels,
      tileHeight: tileHeight,
      tiles: tiles
    });
  } catch (err) {
    console.error("renderRaw error:", err);
    return res.status(500).json({ error: String(err && err.stack ? err.stack : err) });
  }
});

app.get("/", (_, res) => res.send("katex renderer alive"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("renderer listening on", PORT));