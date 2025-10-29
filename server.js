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

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex = new TeX({ packages: AllPackages });
const svg = new SVG({ fontCache: "none" });
const mathDocument = mathjax.document("", { InputJax: tex, OutputJax: svg });

const MAX_SIZE = 1024;
const GAP = 1; // minimal vertical gap in px

function isPlainText(str) {
  // Heuristic: treat as plain text if no math symbols
  return !/[\\^_{}]|\\frac|\\sum|\\sqrt|\\int/.test(str);
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

    // Render and crop each formula or text
    const rows = [];
    let totalHeight = 0, maxWidth = 0;
    for (const latex of formulaList) {
      let svgWrapped;
      if (isPlainText(latex)) {
        // Render as SVG text, not math
        const fontSize = 32 * scale;
        const safeText = latex.replace(/[<>&]/g, "");
        // Estimate width: 0.6em per char (rough, but works for monospace/cursive)
        const estWidth = Math.max(1, Math.floor(safeText.length * fontSize * 0.6));
        svgWrapped = `
          <svg xmlns="http://www.w3.org/2000/svg" width="${estWidth}" height="${fontSize + 8}">
            <style>
              text { fill: white; font-size: ${fontSize}px; font-family: 'Cursive', 'Arial', sans-serif; }
            </style>
            <text x="0" y="${fontSize}" fill="white">${safeText}</text>
          </svg>
        `;
      } else {
        // Render as math
        const node = mathDocument.convert(latex, { display: true });
        const inner = adaptor.innerHTML(node);
        const viewBox = adaptor.getAttribute(node, "viewBox") || "0 0 128 64";
        svgWrapped = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">
            <style>
              * { fill: white !important; stroke: white !important; }
            </style>
            ${inner}
          </svg>
        `;
      }
      const { png, width, height } = await getTightSVG(svgWrapped, scale);
      rows.push({ png, width, height });
      totalHeight += height + GAP;
      if (width > maxWidth) maxWidth = width;
    }
    totalHeight -= GAP; // remove last gap

    // If maxWidth > MAX_SIZE, scale all PNGs down proportionally
    let finalWidth = maxWidth;
    let finalHeight = totalHeight;
    let scaleDown = 1;
    if (maxWidth > MAX_SIZE) {
      scaleDown = MAX_SIZE / maxWidth;
      finalWidth = MAX_SIZE;
      finalHeight = Math.max(1, Math.floor(totalHeight * scaleDown));
    }

    // Resize all PNGs if needed
    const resizedRows = [];
    for (const row of rows) {
      let png = row.png;
      let width = row.width;
      let height = row.height;
      if (scaleDown !== 1) {
        const resized = await sharp(png)
          .resize({
            width: Math.max(1, Math.floor(width * scaleDown)),
            height: Math.max(1, Math.floor(height * scaleDown)),
            fit: "fill"
          })
          .png()
          .toBuffer();
        const meta = await sharp(resized).metadata();
        png = resized;
        width = meta.width;
        height = meta.height;
      }
      resizedRows.push({ png, width, height });
    }

    // Compose final image by stacking PNGs vertically, centered
    let composite = sharp({
      create: {
        width: finalWidth,
        height: finalHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    });
    let y = 0;
    const composites = [];
    for (const row of resizedRows) {
      const left = Math.floor((finalWidth - row.width) / 2);
      composites.push({
        input: row.png,
        top: y,
        left: left >= 0 ? left : 0
      });
      y += row.height + Math.max(1, Math.floor(GAP * scaleDown));
    }
    composite = composite.composite(composites);

    // Output raw RGBA buffer
    const { data, info } = await composite.raw().toBuffer({ resolveWithObject: true });
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
