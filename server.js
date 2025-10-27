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
app.use(bodyParser.json({ limit: "20mb" }));

// MathJax setup
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex = new TeX({ packages: AllPackages });
const svg = new SVG({ fontCache: "none" });
const mathDocument = mathjax.document("", { InputJax: tex, OutputJax: svg });

// In-memory cache
const cache = new Map();

// Helper: force all fills to white
function forceWhite(svgStr) {
  return svgStr.replace(/fill=".*?"/g, 'fill="white"');
}

// Hash LaTeX + scale for caching
function hashKey(latex, scale, fontSize) {
  return crypto.createHash('md5').update(`${latex}:${scale}:${fontSize}`).digest('hex');
}

app.post("/renderRaw", async (req, res) => {
  try {
    let {
      latex,
      tileHeight = 8,
      fontSize = 48,
      scale = 3 // high-resolution multiplier
    } = req.body;

    if (!latex) return res.status(400).json({ error: "Missing 'latex' field" });

    const key = hashKey(latex, scale, fontSize);
    if (cache.has(key)) {
      return res.json(cache.get(key));
    }

   // --- Render LaTeX → SVG ---
const node = mathDocument.convert(latex, { display: true, em: fontSize });
let innerSVG = adaptor.innerHTML(node);
innerSVG = forceWhite(innerSVG);

// Grab viewBox safely using liteAdaptor
const viewBox = adaptor.getAttribute(node, "viewBox") || `0 0 ${fontSize*scale} ${fontSize*scale}`;

// Wrap in high-res SVG
const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${fontSize*scale}" height="${fontSize*scale}">${innerSVG}</svg>`;

    // --- Convert SVG → PNG (raw buffer) ---
    const pngObj = await sharp(Buffer.from(svgContent), { density: 72 * scale })
      .png()
      .trim() // crop transparent borders
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = pngObj;
    const { width, height, channels } = info;

    // --- Slice tiles ---
    const tiles = [];
    const scaledTileHeight = tileHeight * scale;
    for (let y = 0; y < height; y += scaledTileHeight) {
      const rows = Math.min(scaledTileHeight, height - y);
      const tileData = Buffer.alloc(rows * width * channels);
      for (let row = 0; row < rows; row++) {
        const srcStart = ((y + row) * width * channels);
        const srcEnd = srcStart + (width * channels);
        const destStart = row * width * channels;
        data.copy(tileData, destStart, srcStart, srcEnd);
      }
      tiles.push(tileData.toString("base64"));
    }

    const payload = { tiles, width, height, channels };
    cache.set(key, payload); // cache result
    res.json(payload);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
