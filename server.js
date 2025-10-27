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

app.post("/renderRaw", async (req, res) => {
  try {
    const { latex } = req.body;
    if (!latex) return res.status(400).json({ error: "Missing 'latex' field" });

    // Convert LaTeX to MathJax node
    const node = mathDocument.convert(latex, { display: true });

    // Extract SVG string
    let svgContent = adaptor.innerHTML(node);

    // Wrap SVG and force text to white
svgContent = `<svg xmlns="http://www.w3.org/2000/svg">${svgContent}</svg>`;

// Replace all fill colors with white
svgContent = svgContent.replace(/fill=".*?"/g, 'fill="white"');

// Convert to PNG (transparent background)
const pngBuffer = await sharp(Buffer.from(svgContent))
  .png()
  .toBuffer();

    res.json({ pngBase64: pngBuffer.toString("base64") });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
