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

// Bounding box finder (for cropping)
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

// Render route
app.post("/renderRaw", async (req, res) => {
  try {
    const { latex, scale = 6, margin = 2, tileHeight = 128 } = req.body;
    if (!latex) return res.status(400).json({ error: "Missing latex" });

    const key = hashKey(latex, scale, margin, tileHeight);
    if (cache.has(key)) return res.json(cache.get(key));

    // Step 1: Render LaTeX → SVG
    const node = mathDocument.convert(latex, { display: true });
    let svg = adaptor.innerHTML(node);

    // Inject white text color
    const styledSVG = svg.replace(
      /<svg([^>]*)>/,
      `<svg$1><style>* { fill: white !important; stroke: white !important; }</style>`
    );

    const viewBox = adaptor.getAttribute(node, "viewBox") || "0 0 512 512";
    const svgWrapped = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" style="background:none">${styledSVG}</svg>`;

    // Step 2: Rasterize SVG → PNG (high density)
    const density = 72 * scale;
    let png = await sharp(Buffer.from(svgWrapped), { density }).png({ compressionLevel: 0 }).toBuffer();

    // Step 3: Crop to bounding box
    const raw = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const bbox = findBBox(raw.data, raw.info.width, raw.info.height, raw.info.channels) || {
      left: 0,
      top: 0,
      width: raw.info.width,
      height: raw.info.height,
    };
    let cropped = await sharp(png).extract(bbox).png({ compressionLevel: 0 }).toBuffer();

    // Step 4: Auto downscale if over Roblox limits
    let meta = await sharp(cropped).metadata();
    const maxDim = 1024;
    if (meta.width > maxDim || meta.height > maxDim) {
      const scaleFactor = Math.min(maxDim / meta.width, maxDim / meta.height);
      cropped = await sharp(cropped)
        .resize({
          width: Math.floor(meta.width * scaleFactor),
          height: Math.floor(meta.height * scaleFactor),
        })
        .png({ compressionLevel: 0 })
        .toBuffer();
      meta = await sharp(cropped).metadata();
      console.warn(`[RenderRaw] Downscaled to ${meta.width}x${meta.height}`);
    }

    const finalW = meta.width;
    const finalH = meta.height;

    // Step 5: Split into tiles (base64)
    const fullRaw = await sharp(cropped).raw().toBuffer();
    const channels = 4;
    const tiles = [];
    for (let y = 0; y < finalH; y += tileHeight) {
      const rows = Math.min(tileHeight, finalH - y);
      const slice = fullRaw.subarray(y * finalW * channels, (y + rows) * finalW * channels);
      tiles.push(Buffer.from(slice).toString("base64"));
    }

    const payload = { tiles, width: finalW, height: finalH, channels, tileHeight };
    cache.set(key, payload);
    res.json(payload);
  } catch (err) {
    console.error("[renderRaw] ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ White MathJax renderer running at http://localhost:${PORT}`));
