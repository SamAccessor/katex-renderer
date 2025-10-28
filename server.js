// server.js — improved high-resolution KaTeX renderer
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

// Simple in-memory cache
const cache = new Map();

function forceWhite(svgStr) {
  return svgStr.replace(/fill=".*?"/g, 'fill="white"');
}
function hashKey(...parts) {
  return crypto.createHash('md5').update(parts.join(':')).digest('hex');
}

// find tight bbox in raw RGBA buffer
function findTightBBox(rawData, width, height, channels, alphaThreshold = 1) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const rowStart = y * width * channels;
    for (let x = 0; x < width; x++) {
      const idx = rowStart + x * channels;
      const alpha = channels >= 4 ? rawData[idx + 3] : 255;
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

// Parse viewBox "minX minY width height" -> numbers, or null if absent
function parseViewBox(viewBoxStr) {
  if (!viewBoxStr) return null;
  const parts = viewBoxStr.trim().split(/\s+|,/).map(Number).filter(n => !Number.isNaN(n));
  if (parts.length >= 4) {
    return { minX: parts[0], minY: parts[1], vbw: parts[2], vbh: parts[3] };
  }
  return null;
}

app.post("/renderRaw", async (req, res) => {
  try {
    const {
      latex,
      tileHeight = 128,
      fontSize = 48,
      // scale controls how many pixels per SVG unit (higher = higher-res)
      scale = 4,
      margin = 2,
      scaleTo = false,
      targetWidth = null,
      targetHeight = null,
    } = req.body || {};

    if (!latex) return res.status(400).json({ error: "Missing 'latex' field" });

    const key = hashKey(latex, scale, fontSize, targetWidth, targetHeight, margin, scaleTo);
    if (cache.has(key)) return res.json(cache.get(key));

    // Render LaTeX -> inner SVG (MathJax)
    const node = mathDocument.convert(latex, { display: true, em: fontSize });
    let innerSVG = adaptor.innerHTML(node);
    innerSVG = forceWhite(innerSVG);

    // Get viewBox from MathJax node (if present)
    const rawViewBox = adaptor.getAttribute(node, "viewBox") || null;
    const vb = parseViewBox(rawViewBox);

    // If viewBox exists, use its width/height * scale as explicit pixel dimensions.
    // This forces predictable high-resolution rasterization.
    let svgWrap;
    if (vb) {
      const pixelW = Math.max(1, Math.round(vb.vbw * scale));
      const pixelH = Math.max(1, Math.round(vb.vbh * scale));
      // Add preserveAspectRatio to avoid unexpected stretching by downstream tools
      svgWrap = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.minX} ${vb.minY} ${vb.vbw} ${vb.vbh}" width="${pixelW}" height="${pixelH}" preserveAspectRatio="xMinYMin meet">${innerSVG}</svg>`;
    } else {
      // fallback: no viewBox — supply width/height from fontSize*scale
      const fallbackSize = Math.max(1, Math.round(fontSize * scale));
      svgWrap = `<svg xmlns="http://www.w3.org/2000/svg" width="${fallbackSize}" height="${fallbackSize}" preserveAspectRatio="xMinYMin meet">${innerSVG}</svg>`;
    }

    // Rasterize SVG to PNG using explicit pixel size
    // Avoid relying solely on density — setting width/height in SVG ensures correct bitmap size.
    const fullPngBuffer = await sharp(Buffer.from(svgWrap)).png({ compressionLevel: 0, adaptiveFiltering: false }).toBuffer();

    // get raw pixels for tight bbox
    const rawObj = await sharp(fullPngBuffer).raw().toBuffer({ resolveWithObject: true });
    const rawData = rawObj.data;
    const fullWidth = rawObj.info.width;
    const fullHeight = rawObj.info.height;
    const channels = rawObj.info.channels;

    // compute tight bbox (in pixel coordinates of full raster)
    let bbox = findTightBBox(rawData, fullWidth, fullHeight, channels, 1);
    if (!bbox) bbox = { left: 0, top: 0, width: fullWidth, height: fullHeight };

    // apply margin (pixels)
    const marginPx = Math.max(0, Math.round(margin || 0));
    bbox.left = Math.max(0, bbox.left - marginPx);
    bbox.top = Math.max(0, bbox.top - marginPx);
    bbox.width = Math.min(fullWidth - bbox.left, bbox.width + marginPx * 2);
    bbox.height = Math.min(fullHeight - bbox.top, bbox.height + marginPx * 2);

    // extract tight crop
    let croppedBuffer = await sharp(fullPngBuffer)
      .extract({ left: bbox.left, top: bbox.top, width: bbox.width, height: bbox.height })
      .png({ compressionLevel: 0, adaptiveFiltering: false })
      .toBuffer();

    // optionally resize (high-quality kernel)
    let finalBuffer = croppedBuffer;
    let finalWidth = bbox.width;
    let finalHeight = bbox.height;

    if (scaleTo) {
      if (targetWidth && targetHeight) {
        finalBuffer = await sharp(croppedBuffer)
          .resize(targetWidth, targetHeight, { fit: "contain", kernel: "lanczos3", background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png({ compressionLevel: 0, adaptiveFiltering: false })
          .toBuffer();
      } else if (targetWidth) {
        finalBuffer = await sharp(croppedBuffer)
          .resize({ width: targetWidth, kernel: "lanczos3" })
          .png({ compressionLevel: 0, adaptiveFiltering: false })
          .toBuffer();
      } else if (targetHeight) {
        finalBuffer = await sharp(croppedBuffer)
          .resize({ height: targetHeight, kernel: "lanczos3" })
          .png({ compressionLevel: 0, adaptiveFiltering: false })
          .toBuffer();
      }
      const meta = await sharp(finalBuffer).metadata();
      finalWidth = meta.width;
      finalHeight = meta.height;
    }

    // slice finalBuffer into full-width horizontal raw tiles
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

    const payload = {
      tiles,
      width: finalWidth,
      height: finalHeight,
      channels,
      tileHeight: tileH,
      crop: { originalWidth: fullWidth, originalHeight: fullHeight, left: bbox.left, top: bbox.top, width: bbox.width, height: bbox.height },
    };

    cache.set(key, payload);
    return res.json(payload);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// Convenience endpoint: return a single trimmed high-res PNG (good for quick testing)
app.post("/renderFull", async (req, res) => {
  try {
    const { latex, fontSize = 48, scale = 4, margin = 2, scaleTo = false, targetWidth = null, targetHeight = null } = req.body || {};
    if (!latex) return res.status(400).json({ error: "Missing 'latex' field" });

    const node = mathDocument.convert(latex, { display: true, em: fontSize });
    let innerSVG = adaptor.innerHTML(node);
    innerSVG = forceWhite(innerSVG);
    const rawViewBox = adaptor.getAttribute(node, "viewBox") || null;
    const vb = parseViewBox(rawViewBox);

    let svgWrap;
    if (vb) {
      const pixelW = Math.max(1, Math.round(vb.vbw * scale));
      const pixelH = Math.max(1, Math.round(vb.vbh * scale));
      svgWrap = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.minX} ${vb.minY} ${vb.vbw} ${vb.vbh}" width="${pixelW}" height="${pixelH}" preserveAspectRatio="xMinYMin meet">${innerSVG}</svg>`;
    } else {
      const fallbackSize = Math.max(1, Math.round(fontSize * scale));
      svgWrap = `<svg xmlns="http://www.w3.org/2000/svg" width="${fallbackSize}" height="${fallbackSize}" preserveAspectRatio="xMinYMin meet">${innerSVG}</svg>`;
    }

    let buf = await sharp(Buffer.from(svgWrap)).png({ compressionLevel: 0, adaptiveFiltering: false }).toBuffer();

    // trim and optionally resize
    buf = await sharp(buf).trim().toBuffer();
    if (scaleTo && (targetWidth || targetHeight)) {
      buf = await sharp(buf)
        .resize(targetWidth || null, targetHeight || null, { fit: "contain", kernel: "lanczos3", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 0, adaptiveFiltering: false })
        .toBuffer();
    }

    res.setHeader("Content-Type", "image/png");
    return res.send(buf);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`High-res KaTeX server running on http://localhost:${PORT}`));
