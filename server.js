// server.js — fixed high-res JSON output for Roblox EditableImage
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

// MathJax setup
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex = new TeX({ packages: AllPackages });
const svg = new SVG({ fontCache: "none" });
const mathDocument = mathjax.document("", { InputJax: tex, OutputJax: svg });

const cache = new Map();

function hashKey(...parts) {
  return crypto.createHash("md5").update(parts.join(":")).digest("hex");
}

function forceWhite(svg) {
  return svg.replace(/fill=".*?"/g, 'fill="white"');
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
      fontSize = 48,
      scale = 8, // 🔼 high pixel density
      margin = 2,
      tileHeight = 128,
      scaleTo = false,
      targetWidth = null,
      targetHeight = null,
    } = req.body;

    if (!latex) return res.status(400).json({ error: "Missing latex" });

    const key = hashKey(latex, fontSize, scale, margin, scaleTo, targetWidth, targetHeight);
    if (cache.has(key)) return res.json(cache.get(key));

    // Render LaTeX → SVG
    const node = mathDocument.convert(latex, { display: true, em: fontSize });
    let svg = adaptor.innerHTML(node);
    svg = forceWhite(svg);
    const viewBox = adaptor.getAttribute(node, "viewBox");
    const wrappedSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${svg}</svg>`;

    // Rasterize SVG → PNG
    const density = 72 * scale; // high density
    let png = await sharp(Buffer.from(wrappedSVG), { density })
      .png({ compressionLevel: 0 })
      .toBuffer();

    // Find tight bounding box
    const raw = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const bbox = findBBox(raw.data, raw.info.width, raw.info.height, raw.info.channels) || {
      left: 0,
      top: 0,
      width: raw.info.width,
      height: raw.info.height,
    };

    // Crop to bounding box
    const cropped = await sharp(png)
      .extract(bbox)
      .png({ compressionLevel: 0 })
      .toBuffer();

    let final = cropped;
    let finalW = bbox.width;
    let finalH = bbox.height;

    // Optionally resize
    if (scaleTo) {
      final = await sharp(cropped)
        .resize(targetWidth || null, targetHeight || null, {
          fit: "contain",
          kernel: "lanczos3",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .toBuffer();
      const meta = await sharp(final).metadata();
      finalW = meta.width;
      finalH = meta.height;
    }

    // Encode into base64 tiles
    const tiles = [];
    for (let y = 0; y < finalH; y += tileHeight) {
      const h = Math.min(tileHeight, finalH - y);
      const tile = await sharp(final)
        .extract({ left: 0, top: y, width: finalW, height: h })
        .raw()
        .toBuffer();
      tiles.push(tile.toString("base64"));
    }

    const payload = {
      tiles,
      width: finalW,
      height: finalH,
      channels: 4,
      tileHeight,
      crop: bbox,
    };

    cache.set(key, payload);
    res.json(payload);
  } catch (err) {
    console.error("Render error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ KaTeX JSON renderer running at http://localhost:${PORT}`)
);
