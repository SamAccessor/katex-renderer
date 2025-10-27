import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import sharp from "sharp";
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

// Helper: force all text to white
function forceWhite(svgStr) {
  return svgStr.replace(/fill=".*?"/g, 'fill="white"');
}

app.post("/renderRaw", async (req, res) => {
  try {
    let { latex, tileHeight = 8, fontSize = 48 } = req.body;
    if (!latex) return res.status(400).json({ error: "Missing 'latex' field" });

    // Convert LaTeX to SVG
    const node = mathDocument.convert(latex, { display: true });
    let svgContent = adaptor.innerHTML(node);
    svgContent = `<svg xmlns="http://www.w3.org/2000/svg">${forceWhite(svgContent)}</svg>`;

    // Render SVG to PNG buffer
    let pngBuffer = await sharp(Buffer.from(svgContent))
      .png()
      .toBuffer();

    // Crop the PNG to its non-transparent bounding box
    const metadata = await sharp(pngBuffer).metadata();
    const trimmed = await sharp(pngBuffer)
      .trim() // remove transparent borders
      .toBuffer();

    const trimmedMeta = await sharp(trimmed).metadata();
    const width = trimmedMeta.width;
    const height = trimmedMeta.height;
    const channels = 4; // RGBA

    // Split into tiles for Roblox
    const tiles = [];
    for (let y = 0; y < height; y += tileHeight) {
      const rows = Math.min(tileHeight, height - y);
      const tileBuffer = await sharp(trimmed)
        .extract({ left: 0, top: y, width, height: rows })
        .raw()
        .toBuffer();
      tiles.push(tileBuffer.toString("base64"));
    }

    res.json({ tiles, width, height, channels });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
