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
const EX_TO_PX = 8;

// MathJax setup
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex = new TeX({ packages: ['base', 'ams'] });
const svg = new SVG({ fontCache: 'none' });
const doc = mathjax.document('', { InputJax: tex, OutputJax: svg });

// Extract pixel width/height from MathJax SVG’s ex-based attributes
function getSVGPixelDims(svgString) {
  const wMatch = svgString.match(/width="([\d.]+)ex"/);
  const hMatch = svgString.match(/height="([\d.]+)ex"/);
  if (wMatch && hMatch) {
    const w = Math.max(1, Math.ceil(parseFloat(wMatch[1]) * EX_TO_PX));
    const h = Math.max(1, Math.ceil(parseFloat(hMatch[1]) * EX_TO_PX));
    return { width: w, height: h };
  }
  return { width: 256, height: 128 };
}

// Force all fills to white
function forceWhite(svgString) {
  return svgString
    .replace(/fill="black"/g, 'fill="white"')
    .replace(/fill="#000"/g, 'fill="#fff"')
    .replace(/fill="#000000"/g, 'fill="#ffffff"');
}

// Render a single formula to an SVG fragment + measured size
function renderFormulaToSVG(formula) {
  // DO NOT WRAP with $$...$$!
  const node = doc.convert(formula, { display: true });
  let svg = adaptor.outerHTML(node);

  if (!svg || !svg.trim().startsWith('<svg')) {
    // Fallback minimal SVG with text to avoid pipeline break
    const safeText = (formula || '').replace(/[<>]/g, '');
    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40ex" height="3ex"><text x="0" y="20" fill="white" font-size="16" font-family="Arial">${safeText}</text></svg>`;
  }

  svg = forceWhite(svg);
  const dims = getSVGPixelDims(svg);
  // Strip outer <svg> tags so we can compose later
  const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  return { inner, width: dims.width, height: dims.height };
}

// Compose multiple formula SVG fragments stacked vertically into one SVG
function composeStackedSVG(frags) {
  let y = 0;
  let maxW = 1;
  const gap = 10;
  const rows = [];

  for (const f of frags) {
    rows.push(`<g transform="translate(0,${y})">${f.inner}</g>`);
    y += f.height + gap;
    maxW = Math.max(maxW, f.width);
  }

  const canvasW = Math.min(maxW, MAX_SIZE);
  const canvasH = Math.min(y - gap, MAX_SIZE);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">
${rows.join('\n')}
</svg>`;

  return { svg, width: canvasW, height: canvasH };
}

// Rasterize SVG -> raw RGBA buffer using Sharp, keep transparency
async function svgToRGBA(svgString, targetW, targetH) {
  const { data, info } = await sharp(Buffer.from(svgString))
    .resize(targetW, targetH, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      kernel: sharp.kernel.lanczos3,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, info };
}

// POST /render
app.post('/render', async (req, res) => {
  try {
    let formulas = req.body.formulas;
    if (!Array.isArray(formulas)) {
      const single = req.body.formula;
      if (typeof single === 'string' && single.trim().length > 0) {
        formulas = [single];
      }
    }
    if (!Array.isArray(formulas) || formulas.length === 0) {
      return res.status(400).json({ error: 'Provide formula (string) or formulas (array of strings).' });
    }

    // Render each formula to an SVG fragment + measure
    const frags = formulas.map(renderFormulaToSVG);

    // Compose stacked output
    let { svg, width, height } = composeStackedSVG(frags);

    // Clamp to MAX_SIZE with aspect preservation (never upscale)
    const scale = Math.min(MAX_SIZE / width, MAX_SIZE / height, 1);
    const targetW = Math.max(1, Math.floor(width * scale));
    const targetH = Math.max(1, Math.floor(height * scale));

    // Rasterize to RGBA (transparent background)
    const { data, info } = await svgToRGBA(svg, targetW, targetH);

    const base64 = Buffer.from(data).toString('base64');
    res.json({
      width: info.width,
      height: info.height,
      channels: info.channels,
      rgbaBase64: base64,
    });
  } catch (err) {
    console.error('Render error:', err);
    res.status(500).json({ error: 'Render failed: ' + (err?.message || String(err)) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MathJax renderer (display math, white-on-transparent) listening on port ${PORT}`);
});
