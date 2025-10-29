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
app.use(bodyParser.json({ limit: "2mb" }));

// MathJax setup
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex = new TeX({ packages: AllPackages });
const svg = new SVG({ fontCache: "none" });
const mathDocument = mathjax.document("", { InputJax: tex, OutputJax: svg });

app.post("/render", async (req, res) => {
  try {
    const {
      formulas,
      scale = 3, // Lower default scale for less memory
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
      // Only get metadata, do not rasterize yet
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

    // Rasterize to raw RGBA (transparent background)
    const density = 72 * scale;
    const rawResult = await sharp(Buffer.from(stackedSVG), { density })
      .resize({ width: Math.min(maxWidth, 1024), height: Math.min(totalHeight, 1024), fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = rawResult;
    // No extra cropping or tiling, just send the buffer
    const base64 = Buffer.from(data).toString("base64");

    res.json({
      width: info.width,
      height: info.height,
      channels: info.channels,
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
