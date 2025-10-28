// server.js
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import sharp from 'sharp';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));
app.use(cors());

const MAX_SIZE = 1024;

// MathJax v3 setup
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex = new TeX({ packages: ['base', 'ams'] });
const svg = new SVG({ fontCache: 'none' });
const mj = mathjax.document('', { InputJax: tex, OutputJax: svg });

function getSVGDimensions(svgString) {
  const wMatch = svgString.match(/width="([\d.]+)ex"/);
  const hMatch = svgString.match(/height="([\d.]+)ex"/);
  const EX_TO_PX = 8;
  if (wMatch && hMatch) {
    let w = Math.ceil(parseFloat(wMatch[1]) * EX_TO_PX);
    let h = Math.ceil(parseFloat(hMatch[1]) * EX_TO_PX);
    return { width: w, height: h };
  }
  return { width: 256, height: 128 };
}

// Utility: Replace all fill colors in SVG with white
function svgToWhite(svgString) {
  return svgString
    .replace(/fill="black"/g, 'fill="white"')
    .replace(/fill="#000"/g, 'fill="#fff"')
    .replace(/fill="#000000"/g, 'fill="#ffffff"');
}

app.post('/render', async (req, res) => {
  const startTime = Date.now();
  const { formula } = req.body || {};
  if (!formula || typeof formula !== 'string') {
    return res.status(400).json({ error: 'Missing formula' });
  }

  try {
    // 1. Render TeX to SVG using MathJax v3
    const node = mj.convert(formula, { display: true });
    let svgString = adaptor.outerHTML(node);

    // 2. Convert all fills to white
    svgString = svgToWhite(svgString);

    // 3. Compute size, clamp to 1024x1024
    const size = getSVGDimensions(svgString);
    let targetW = size.width;
    let targetH = size.height;
    const scale = Math.min(MAX_SIZE / targetW, MAX_SIZE / targetH, 1);
    targetW = Math.max(1, Math.floor(targetW * scale));
    targetH = Math.max(1, Math.floor(targetH * scale));

    // 4. Rasterize SVG to RGBA (fast, in-memory)
    const { data: rgbaBuffer, info } = await sharp(Buffer.from(svgString))
      .resize(targetW, targetH, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // 5. Return base64 RGBA + size
    const base64 = Buffer.from(rgbaBuffer).toString('base64');
    const elapsed = Date.now() - startTime;
    res.set('X-Render-Time-ms', elapsed);
    return res.json({
      width: info.width,
      height: info.height,
      channels: info.channels,
      rgbaBase64: base64,
      renderTimeMs: elapsed
    });
  } catch (err) {
    console.error('Render error:', err);
    return res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MathJax v3 renderer (white text) listening on port ${PORT}`);
});
