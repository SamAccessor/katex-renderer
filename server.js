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

app.post("/renderRaw", async (req, res) => {
  try {
    const { latex, scale = 6, margin = 2, tileHeight = 128 } = req.body;

    if (!latex || typeof latex !== "string" || latex.trim() === "") {
      return res.status(400).json({ error: "Missing or invalid LaTeX" });
    }

    // ✅ sanity check first
    if (!latex.match(/[a-zA-Z0-9\\]/)) {
      throw new Error("Invalid or empty LaTeX string");
    }

    let node;
    try {
      node = mathDocument.convert(latex, { display: true });
    } catch (mjError) {
      console.error("❌ MathJax parse error:", mjError);
      return res.status(400).json({
        error: "MathJax parse error",
        details: mjError.message || mjError.toString(),
      });
    }

    if (!node) throw new Error("MathJax conversion returned null node.");

    const inner = adaptor.innerHTML(node);
    const viewBox = adaptor.getAttribute(node, "viewBox") || "0 0 128 64";
    const svgWrapped = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">
        <style>* { fill: white !important; stroke: white !important; }</style>
        ${inner}
      </svg>
    `;

    // ... (keep same sharp cropping & tiling logic from the previous version)
  } catch (err) {
    console.error("[renderRaw] ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ White MathJax renderer running safely at http://localhost:${PORT}`)
);
