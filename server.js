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

// --- MathJax setup ---
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex = new TeX({ packages: AllPackages });
const svg = new SVG({ fontCache: "none" });
const mathDocument = mathjax.document("", { InputJax: tex, OutputJax: svg });

// --- In-memory cache ---
const cache = new Map();

// --- Helper: force all fills to white ---
function forceWhite(svgStr) {
  return svgStr.replace(/fill=".*?"/g, 'fill="white"');
}

// --- Helper: hash LaTeX + scale ---
function hashKey(latex, scale, fontSize, targetWidth, targetHeight) {
  return crypto
    .createHash('md5')
    .update(`${latex}:${scale}:${fontSize}:${targetWidth}:${targetHeight}`)
    .digest('hex');
}

// --- /renderRaw endpoint ---
app.post("/renderRaw", async (req, res) => {
  try {
    let {
      latex,
      tileHeight = 128,
      fontSize = 48,
      scale = 3, // rendering scale
      targetWidth = 800, // editable image width
      targetHeight = 600 // editable image height
    } = req.body;

    if (!latex) return res.status(400).json({ error: "Missing 'latex' field" });

    const key = hashKey(latex, scale, fontSize, targetWidth, targetHeight);
    if (cache.has(key)) return res.json(cache.get(key));

    // --- Convert LaTeX → SVG ---
    const node = mathDocument.convert(latex, { display: true, em: fontSize });
    let innerSVG = adaptor.innerHTML(node);
    innerSVG = forceWhite(innerSVG);

    const viewBox = adaptor.getAttribute(node, "viewBox") || `0 0 ${fontSize*scale} ${fontSize*scale}`;

    // Wrap SVG
    let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${fontSize*scale}" height="${fontSize*scale}">${innerSVG}</svg>`;

    // --- Render SVG → PNG and trim whitespace ---
    let pngBuffer = await sharp(Buffer.from(svgContent), { density: 72 * scale })
      .png()
      .trim() // remove surrounding transparent pixels
      .toBuffer();

    // --- Optionally scale to fill the editable image ---
    pngBuffer = await sharp(pngBuffer)
      .resize(targetWidth, targetHeight, { fit: "contain", background: { r:0,g:0,b:0,alpha:0 } })
      .png()
      .toBuffer();

    // --- Get metadata for slicing ---
    const image = sharp(pngBuffer);
    const metadata = await image.metadata();
    const { width, height, channels } = metadata;

    // --- Slice tiles vertically (full width) ---
    const tiles = [];
    for (let y = 0; y < height; y += tileHeight) {
      const h = Math.min(tileHeight, height - y);
      const tileBuffer = await sharp(pngBuffer)
        .extract({ left: 0, top: y, width: width, height: h })
        .raw()
        .toBuffer();

      tiles.push(tileBuffer.toString("base64"));
    }

    const payload = { tiles, width, height, channels };
    cache.set(key, payload);
    res.json(payload);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
