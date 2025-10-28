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

// 🔹 Render route (white text on transparent background)
app.post("/renderRaw", async (req, res) => {
  try {
    const {
      latex,
      fontSize = 32,
      scale = 4,
      margin = 2,
      tileHeight = 128,
      scaleTo = false,
      targetWidth,
      targetHeight,
    } = req.body;

    if (!latex) return res.status(400).json({ error: "Missing latex" });

    const key = hashKey(latex, fontSize, scale, margin, tileHeight, targetWidth, targetHeight);
    if (cache.has(key)) return res.json(cache.get(key));

    // Step 1: Render LaTeX → SVG
    const node = mathDocument.convert(latex, { display: true });
    let svg = adaptor.innerHTML(node);
    const viewBox = adaptor.getAttribute(node, "viewBox") || "0 0 100 100";

    // Step 2: Apply font scaling safely
    const scaleFactor = Math.max(0.1, Math.min(fontSize / 32, 20)); // clamp to avoid extreme scale
    const [vx, vy, vw, vh] = viewBox.split(/\s+/).map(Number);
    const scaledViewBox = `0 0 ${vw * scaleFactor} ${vh * scaleFactor}`;

    const styledSVG = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="${scaledViewBox}" style="background:none">
        <style>* { fill: white !important; stroke: white !important; }</style>
        <g transform="scale(${scaleFactor})">${svg}</g>
      </svg>`;

    // Step 3: Rasterize SVG → PNG @ capped density
    const safeDensity = Math.min(72 * scale, 1200); // prevent overflows
    let sharpImg = sharp(Buffer.from(styledSVG), { density: safeDensity }).png({ compressionLevel: 0 });

    // Step 4: Optional resize to target size
    if (scaleTo && (targetHeight || targetWidth)) {
      sharpImg = sharpImg.resize({
        width: targetWidth ? Math.round(targetWidth * scaleFactor) : undefined,
        height: targetHeight ? Math.round(targetHeight * scaleFactor) : undefined,
        fit: "contain"
      });
    }

    let png = await sharpImg.toBuffer();

    // Step 5: Find bounding box safely
    const raw = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const { data, info } = raw;
    if (!data || !info || !info.width || !info.height) throw new Error("Invalid raw buffer from Sharp");

    const bbox = findBBox(data, info.width, info.height, info.channels) || {
      left: 0,
      top: 0,
      width: info.width,
      height: info.height,
    };

    // Step 6: Crop and tile
    const cropped = await sharp(png).extract(bbox).png({ compressionLevel: 0 }).toBuffer();
    const meta = await sharp(cropped).metadata();
    const finalW = meta.width;
    const finalH = meta.height;

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
