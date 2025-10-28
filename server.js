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
app.use(bodyParser.json({ limit: "10mb" }));

// MathJax setup
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex = new TeX({ packages: AllPackages });
const svg = new SVG({ fontCache: "none" });
const mathDocument = mathjax.document("", { InputJax: tex, OutputJax: svg });

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

app.post("/render", async (req, res) => {
  try {
    const {
      formulas,
      scale = 6,
      margin = 2
    } = req.body;

    // Accept either a single formula or an array
    let formulaList = [];
    if (Array.isArray(formulas)) {
      formulaList = formulas;
    } else if (typeof req.body.formula === "string") {
      formulaList = [req.body.formula];
    } else {
      return res.status(400).json({ error: "Missing or invalid LaTeX input" });
    }

    // Render each formula as display math and stack vertically
    const svgRows = [];
    let totalHeight = 0, maxWidth = 0;
    for (const latex of formulaList) {
      // DO NOT WRAP with $$...$$!
      const node = mathDocument.convert(latex, { display: true });
      const inner = adaptor.innerHTML(node);
      const viewBox = adaptor.getAttribute(node, "viewBox") || "0 0 128 64";
      // Wrap each formula in its own SVG for measurement
      const svgWrapped = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">
          <style>
            * { fill: white !important; stroke: white !important; }
          </style>
          ${inner}
        </svg>
      `;
      // Measure with sharp
      const meta = await sharp(Buffer.from(svgWrapped), { density: 72 * scale }).metadata();
      svgRows.push({ svg: svgWrapped, width: meta.width, height: meta.height });
      totalHeight += meta.height + margin * scale;
      maxWidth = Math.max(maxWidth, meta.width);
    }

    // Compose a single SVG stacking all formulas vertically
    let y = 0;
    const stackedSVG = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${maxWidth}" height="${totalHeight}">
        <style>
          * { fill: white !important; stroke: white !important; }
        </style>
        ${svgRows.map(row => {
          const g = `<g transform="translate(0,${y})">${row.svg.replace(/^<svg[^>]*>|<\/svg>$/g, "")}</g>`;
          y += row.height + margin * scale;
          return g;
        }).join("\n")}
      </svg>
    `;

    // Rasterize, crop, and output a single RGBA buffer
    const density = 72 * scale;
    const padded = await sharp(Buffer.from(stackedSVG), { density })
      .png({ compressionLevel: 0 })
      .toBuffer();

    const rawResult = await sharp(padded).raw().toBuffer({ resolveWithObject: true });
    const { data, info } = rawResult;
    const bbox = findBBox(data, info.width, info.height, info.channels) || {
      left: 0, top: 0, width: info.width, height: info.height
    };

    const cropped = await sharp(padded)
      .extract(bbox)
      .png({ compressionLevel: 0 })
      .toBuffer();

    const meta = await sharp(cropped).metadata();
    const finalW = meta.width;
    const finalH = meta.height;
    const channels = 4;

    // Get raw RGBA buffer for Roblox
    const fullRaw = await sharp(cropped).raw().toBuffer();
    const base64 = Buffer.from(fullRaw).toString("base64");

    res.json({
      width: finalW,
      height: finalH,
      channels,
      rgbaBase64: base64
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
