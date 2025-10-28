import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import sharp from "sharp";
import crypto from "crypto";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));

// Setup MathJax
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex = new TeX({ packages: AllPackages });
const svg = new SVG({ fontCache: "none" });
const mathDocument = mathjax.document("", { InputJax: tex, OutputJax: svg });

// Cache for repeated renders
const cache = new Map();

function hashKey(...parts) {
  return crypto.createHash("md5").update(parts.join(":")).digest("hex");
}

function findBBox(data, width, height, channels, alphaThreshold = 1) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * channels;
    for (let x = 0; x < width; x++) {
      const alpha = data[row + x * channels + 3];
      if (alpha > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

app.post("/renderRaw", async (req, res) => {
  try {
    const {
      latex,
      scale = 6,
      margin = 2,
      tileHeight = 128
    } = req.body;

    if (!latex || typeof latex !== "string" || latex.trim() === "") {
      return res.status(400).json({ error: "Missing or invalid LaTeX" });
    }

    const key = hashKey(latex, scale, margin, tileHeight);
    if (cache.has(key)) return res.json(cache.get(key));

    // Step 1: Render LaTeX → SVG
    const node = mathDocument.convert(latex, { display: true });
    if (!node) throw new Error("MathJax conversion failed: no node returned.");

    const inner = adaptor.innerHTML(node);
    const viewBox = adaptor.getAttribute(node, "viewBox") || "0 0 128 64";

    // Step 2: Wrap SVG with white fill/stroke styling
    const svgWrapped = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">
        <style>
          * { fill: white !important; stroke: white !important; }
        </style>
        ${inner}
      </svg>
    `;

    // Step 3: Rasterize SVG → PNG @ high density (with padding)
    const density = 72 * scale;
    const padded = await sharp(Buffer.from(svgWrapped), { density })
      .extend({
        top: margin * scale,
        bottom: margin * scale,
        left: margin * scale,
        right: margin * scale,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png({ compressionLevel: 0 })
      .toBuffer();

    // Step 4: Get raw data to detect bounding box
    const rawResult = await sharp(padded).raw().toBuffer({ resolveWithObject: true });
    if (!rawResult || !rawResult.data || !rawResult.info) {
      throw new Error("Failed to extract raw buffer from rasterized SVG.");
    }

    const { data, info } = rawResult;
    const bbox = findBBox(data, info.width, info.height, info.channels) || {
      left: 0,
      top: 0,
      width: info.width,
      height: info.height,
    };

    // Step 5: Crop to bounding box
    const cropped = await sharp(padded)
      .extract(bbox)
      .png({ compressionLevel: 0 })
      .toBuffer();

    const meta = await sharp(cropped).metadata();
    const finalW = meta.width;
    const finalH = meta.height;

    if (!finalW || !finalH) throw new Error("Invalid cropped image dimensions.");

    // Step 6: Split into horizontal RGBA tiles
    const fullRaw = await sharp(cropped).raw().toBuffer();
    const channels = 4;
    const tiles = [];

    for (let y = 0; y < finalH; y += tileHeight) {
      const rows = Math.min(tileHeight, finalH - y);
      const slice = fullRaw.subarray(y * finalW * channels, (y + rows) * finalW * channels);
      tiles.push(Buffer.from(slice).toString("base64"));
    }

    const payload = {
      tiles,
      width: finalW,
      height: finalH,
      channels,
      tileHeight,
      crop: bbox,
    };

    cache.set(key, payload);
    res.json(payload);

  } catch (err) {
    console.error("[renderRaw] ERROR:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ White MathJax renderer running safely at http://localhost:${PORT}`)
);

