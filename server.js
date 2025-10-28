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

// MathJax setup (initialize once)
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex = new TeX({ packages: ['base', 'ams'] });
const svgOut = new SVG({ fontCache: 'none' });
const mj = mathjax.document('', { InputJax: tex, OutputJax: svgOut });

// 1ex ≈ 8px (MathJax SVG uses ex units); this is a common, practical approximation
const EX_TO_PX = 8;

// If no explicit math delimiters present, wrap as display math $$…$$
function ensureDisplayMath(src) {
  const s = (src || '').trim();
  if (!s) return '$$\\text{ }$$'; // avoid empty
  const hasDelims =
    s.startsWith('$$') && s.endsWith('$$') ||
    s.startsWith('\\[') && s.endsWith('\\]') ||
    s.startsWith('\\(') && s.endsWith('\\)') ||
    s.startsWith('$') && s.endsWith('$');
  return hasDelims ? s : `$$${s}$$`;
}

// Extract pixel width/height from MathJax SVG’s ex-based attributes
function getSVGPixelDims(svgString) {
  const wMatch = svgString.match(/width="([\d.]+)ex"/);
  const hMatch = svgString.match(/height="([\d.]+)ex"/);
  if (wMatch && hMatch) {
    const w = Math.max(1, Math.ceil(parseFloat(wMatch[1]) * EX_TO_PX));
    const h = Math.max(1, Math.ceil(parseFloat(hMatch[1]) * EX_TO_PX));
    return { width: w, height: h };
  }
  // Fallback if attributes not found (rare)
  return { width: 256, height: 128 };
}

// Force paths/glyphs to white (MathJax defaults to black)
function forceWhite(svgString) {
  return svgString
    .replace(/fill="black"/g, 'fill="white"')
    .replace(/fill="#000"/g, 'fill="#fff"')
    .replace(/fill="#000000"/g, 'fill="#ffffff"');
}

// Render a single formula to an SVG fragment + measured size
function renderFormulaToSVG(formula) {
  const wrapped = ensureDisplayMath(formula);
  const node = mj.convert(wrapped, { display: true });
  let svg = adaptor.outerHTML(node);

  // Sanity: must start with <svg …>…</svg>
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
  const gap = 10; // vertical spacing in px
  const rows = [];

  for (const f of frags) {
    rows.push(`<g transform="translate(0,${y})">${f.inner}</g>`);
    y += f.height + gap;
    maxW = Math.max(maxW, f.width);
  }

  // Final canvas dimensions (clamped to MAX_SIZE)
  const canvasW = Math.min(maxW, MAX_SIZE);
  const canvasH = Math.min(y - gap, MAX_SIZE); // subtract last gap

  // Compose final SVG (no background rect => transparent)
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
      background: { r: 0, g: 0, b: 0, alpha: 0 }, // fully transparent
      kernel: sharp.kernel.lanczos3,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, info };
}

// POST /render
// Accepts either:
// - { formula: string }
// - { formulas: string[] }
// Returns: { width, height, channels:4, rgbaBase64 }
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
      channels: info.channels, // expected 4
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
