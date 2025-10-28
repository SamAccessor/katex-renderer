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

// 🔹 Setup MathJax
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const tex = new TeX({ packages: AllPackages });
const svg = new SVG({ fontCache: "none" });
const mathDocument = mathjax.document("", { InputJax: tex, OutputJax: svg });

// 🔹 Cache for repeated renders
const cache = new Map();
function hashKey(...parts) {
  return crypto.createHash("md5").update(parts.join(":")).digest("hex");
}

// 🔹 Bounding-box finder (tight crop)
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

// 🔹 Render route
app.post("/renderRaw", async (req, res) => {
  try {
    const {
      latex,
      scale = 6,
      margin = 2,
      tileHeight = 128,
      display = false, // false = inline, true = block
    } = req.body;

    if (!latex || typeof latex !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'latex' input" });
    }

    const key = hashKey(latex, scale, margin, tileHeight, display);
    if (cache.has(key)) return res.json(cache.get(key));

    // Step 1: Render LaTeX → SVG
    let node;
    try {
      node = mathDocument.convert(latex, { display });
    } catch (mjErr) {
      console.error("❌ MathJax parse error:", mjErr);
      return res.status(400).json({ error: "MathJax parse error", details: mjErr.message });
    }

    if (!node) {
      throw new Error("MathJax conversion returned null node.");
    }

    let svgInner = adaptor.innerHTML(node);
    let viewBox = adaptor.getAttribute(node, "viewBox");

    // Expand viewBox dynamically to avoid cutoff
    let expandedViewBox = "0 0 2048 512"; // default large area
    if (viewBox) {
      const parts = viewBox.split(" ").map(Number);
      if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
        parts[2] *= 1.5; // widen width by 50%
        parts[3] *= 1.5; // height safety
        expandedViewBox = parts.join(" ");
      }
    }

    // Step 2: Inject white fill + transparent background
    const svgWrapped = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="${expandedViewBox}" style="background:none; overflow:visible">
        <style>* { fill: white !important; stroke: white !important; }</style>
        ${svgInner}
      </svg>
    `;

    // Step 3: Rasterize SVG → PNG at high density
    const density = 72 * scale;
    const png = await sharp(Buffer.from(svgWrapped), { density })
      .png({ compressionLevel: 0 })
      .toBuffer();

    // Step 4: Find tight bounding box (auto-crop)
    const raw = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const bbox =
      findBBox(raw.data, raw.info.width, raw.info.height, raw.info.channels) || {
        left: 0,
        top: 0,
        width: raw.info.width,
        height: raw.info.height,
      };

    // Step 5: Crop
    const cropped = await sharp(png)
      .extract(bbox)
      .png({ compressionLevel: 0 })
      .toBuffer();

    const meta = await sharp(cropped).metadata();
    const finalW = meta.width;
    const finalH = meta.height;

    // Step 6: Split into RGBA base64 tiles
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
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ White MathJax renderer running at http://localhost:${PORT}`)
);
