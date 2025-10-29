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
app.use(bodyParser.json({ limit: "4mb" }));

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex = new TeX({ packages: AllPackages });
const svg = new SVG({ fontCache: "none" });
const mathDocument = mathjax.document("", { InputJax: tex, OutputJax: svg });

const TILE_HEIGHT = 1024;
const GAP = 1;

function isLikelyPlainText(str) {
  return !/[\\^_{}]|\\frac|\\sum|\\sqrt|\\int|\\pm|\\sin|\\cos|\\tan|\\log|\\ln|\\exp|\\leq|\\geq|\\neq|\\to|\\infty/.test(str);
}
function preprocessFormula(str) {
  if (!str || typeof str !== "string" || !str.trim()) return "\\text{ }";
  if (isLikelyPlainText(str)) {
    const safe = str.replace(/([\\{}])/g, "\\$1");
    return `\\text{${safe}}`;
  }
  return str;
}

async function getTightSVG(svgString, scale) {
  const density = 72 * scale;
  const pngBuffer = await sharp(Buffer.from(svgString), { density })
    .png()
    .toBuffer();
  const { data, info } = await sharp(pngBuffer).raw().toBuffer({ resolveWithObject: true });

  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const alpha = data[(y * info.width + x) * 4 + 3];
      if (alpha > 1) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    minX = 0; minY = 0; maxX = info.width - 1; maxY = info.height - 1;
  }
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;

  const cropped = await sharp(pngBuffer)
    .extract({ left: minX, top: minY, width, height })
    .png()
    .toBuffer();

  return { png: cropped, width, height };
}

app.post("/render", async (req, res) => {
  try {
    const {
      formulas,
      scale = 3
    } = req.body;

    let formulaList = [];
    if (Array.isArray(formulas)) {
      formulaList = formulas;
    } else if (typeof req.body.formula === "string") {
      formulaList = [req.body.formula];
    } else {
      return res.status(400).json({ error: "Missing or invalid LaTeX input" });
    }

    const processedFormulas = formulaList.map(preprocessFormula);

    // Render and crop each formula (including plain text) as math
    const rows = [];
    let totalHeight = 0, maxWidth = 0;
    for (const latex of processedFormulas) {
      const node = mathDocument.convert(latex, { display: true });
      const inner = adaptor.innerHTML(node);
      const viewBox = adaptor.getAttribute(node, "viewBox") || "0 0 128 64";
      const svgWrapped = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">
          <style>
            * { fill: white !important; stroke: white !important; }
          </style>
          ${inner}
        </svg>
      `;
      const { png, width, height } = await getTightSVG(svgWrapped, scale);
      rows.push({ png, width, height });
      totalHeight += height + GAP;
      if (width > maxWidth) maxWidth = width;
    }
    totalHeight -= GAP;

    // Compose final image by stacking PNGs vertically, centered
    let composite = sharp({
      create: {
        width: maxWidth,
        height: totalHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    });
    let y = 0;
    const composites = [];
    for (const row of rows) {
      const left = Math.floor((maxWidth - row.width) / 2);
      composites.push({
        input: row.png,
        top: y,
        left: left >= 0 ? left : 0
      });
      y += row.height + GAP;
    }
    composite = composite.composite(composites);

    // Output as vertical tiles (TILE_HEIGHT rows per tile)
    const { data, info } = await composite.raw().toBuffer({ resolveWithObject: true });
    const tiles = [];
    const channels = info.channels;
    const width = info.width;
    const height = info.height;
    for (let y = 0; y < height; y += TILE_HEIGHT) {
      const rows = Math.min(TILE_HEIGHT, height - y);
      const slice = data.subarray(y * width * channels, (y + rows) * width * channels);
      tiles.push(Buffer.from(slice).toString("base64"));
    }

    res.json({
      width,
      height,
      channels,
      tileHeight: TILE_HEIGHT,
      tiles
    });

  } catch (err) {
    console.error("[render] ERROR:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ MathJax renderer running at http://localhost:${PORT}`)
);
