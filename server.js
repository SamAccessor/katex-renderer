// server.js
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

function forceWhite(svgStr) {
  return svgStr.replace(/fill=".*?"/g, 'fill="white"');
}

function hashKey(latex, scale, fontSize, targetWidth, targetHeight, margin, scaleTo) {
  return crypto
    .createHash('md5')
    .update(`${latex}:${scale}:${fontSize}:${targetWidth}:${targetHeight}:${margin}:${!!scaleTo}`)
    .digest('hex');
}

// helper: find tight bbox on raw RGBA buffer
function findTightBBox(rawData, width, height, channels, alphaThreshold = 1) {
  const data = rawData;
  let minX = width, minY = height, maxX = -1, maxY = -1;

  for (let y = 0; y < height; y++) {
    const rowStart = y * width * channels;
    for (let x = 0; x < width; x++) {
      const idx = rowStart + x * channels;
      const alpha = channels >= 4 ? data[idx + 3] : 255;
      if (alpha > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return { left: minX, top: minY, width: (maxX - minX + 1), height: (maxY - minY + 1) };
}

app.post("/renderRaw", async (req, res) => {
  try {
    const {
      latex,
      tileHeight = 128,
      fontSize = 48,
      scale = 3,
      margin = 2,
      scaleTo = false,
      targetWidth = null,
      targetHeight = null,
    } = req.body || {};

    if (!latex) return res.status(400).json({ error: "Missing 'latex' field" });

    const key = hashKey(latex, scale, fontSize, targetWidth, targetHeight, margin, scaleTo);
    if (cache.has(key)) return res.json(cache.get(key));

    // Render LaTeX -> SVG inner content
    const node = mathDocument.convert(latex, { display: true, em: fontSize });
    let innerSVG = adaptor.innerHTML(node);
    innerSVG = forceWhite(innerSVG);

    const viewBox = adaptor.getAttribute(node, "viewBox") || null;
    const svgWrap = viewBox
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${innerSVG}</svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg">${innerSVG}</svg>`;

    // Render a full PNG at requested density (no trim yet)
    const density = Math.max(1, 72 * (scale || 1));
    const fullPngBuffer = await sharp(Buffer.from(svgWrap), { density }).png().toBuffer();

    // Read raw pixels to compute tight bbox
    const rawObj = await sharp(fullPngBuffer).raw().toBuffer({ resolveWithObject: true });
    const rawData = rawObj.data;
    const fullWidth = rawObj.info.width;
    const fullHeight = rawObj.info.height;
    const channels = rawObj.info.channels;

    // compute tight bbox
    let bbox = findTightBBox(rawData, fullWidth, fullHeight, channels, 1);
    if (!bbox) bbox = { left: 0, top: 0, width: fullWidth, height: fullHeight };

    // apply margin
    const marginPx = Math.max(0, Math.round(margin || 0));
    bbox.left = Math.max(0, bbox.left - marginPx);
    bbox.top = Math.max(0, bbox.top - marginPx);
    bbox.width = Math.min(fullWidth - bbox.left, bbox.width + marginPx * 2);
    bbox.height = Math.min(fullHeight - bbox.top, bbox.height + marginPx * 2);

    // extract tight crop
    let croppedBuffer = await sharp(fullPngBuffer)
      .extract({ left: bbox.left, top: bbox.top, width: bbox.width, height: bbox.height })
      .png()
      .toBuffer();

    // optionally resize the tight crop to the requested target size
    let finalBuffer = croppedBuffer;
    let finalWidth = bbox.width;
    let finalHeight = bbox.height;

    if (scaleTo) {
      if (targetWidth && targetHeight) {
        finalBuffer = await sharp(croppedBuffer)
          .resize(targetWidth, targetHeight, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png()
          .toBuffer();
      } else if (targetWidth) {
        finalBuffer = await sharp(croppedBuffer).resize({ width: targetWidth }).png().toBuffer();
      } else if (targetHeight) {
        finalBuffer = await sharp(croppedBuffer).resize({ height: targetHeight }).png().toBuffer();
      }
      const meta = await sharp(finalBuffer).metadata();
      finalWidth = meta.width;
      finalHeight = meta.height;
    }

    // slice finalBuffer into full-width tiles (raw)
    const tiles = [];
    const tileH = Math.max(1, Math.floor(tileHeight));
    for (let y = 0; y < finalHeight; y += tileH) {
      const h = Math.min(tileH, finalHeight - y);
      const tileRaw = await sharp(finalBuffer)
        .extract({ left: 0, top: y, width: finalWidth, height: h })
        .raw()
        .toBuffer();
      tiles.push(tileRaw.toString("base64"));
    }

    // return payload
    const payload = {
      tiles,
      width: finalWidth,
      height: finalHeight,
      channels,
      tileHeight: tileH,
      // crop info relative to original full PNG (useful for debugging)
      crop: {
        originalWidth: fullWidth,
        originalHeight: fullHeight,
        left: bbox.left,
        top: bbox.top,
        width: bbox.width,
        height: bbox.height
      }
    };

    cache.set(key, payload);
    return res.json(payload);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
