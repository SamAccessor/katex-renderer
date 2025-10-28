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

function svgToWhite(svgString) {
  return svgString
    .replace(/fill="black"/g, 'fill="white"')
    .replace(/fill="#000"/g, 'fill="#fff"')
    .replace(/fill="#000000"/g, 'fill="#ffffff"');
}

// Render multiple formulas stacked vertically
function renderStackedSVG(formulas) {
  let y = 0;
  let svgParts = [];
  let maxWidth = 0;
  let totalHeight = 0;

  for (const formula of formulas) {
    const node = mj.convert(formula, { display: true });
    let svgString = adaptor.outerHTML(node);
    svgString = svgToWhite(svgString);

    if (!svgString.trim().startsWith('<svg')) {
      throw new Error('MathJax did not produce a valid SVG for formula: ' + formula);
    }

    const { width, height } = getSVGDimensions(svgString);

    // Remove outer <svg> and get inner content
    const inner = svgString.replace(/^<svg[^>]*>|<\/svg>$/g, '');

    svgParts.push(`<g transform="translate(0,${y})">${inner}</g>`);
    y += height + 10; // 10px spacing
    maxWidth = Math.max(maxWidth, width);
    totalHeight += height + 10;
  }

  // Clamp to MAX_SIZE
  maxWidth = Math.min(maxWidth, MAX_SIZE);
  totalHeight = Math.min(totalHeight, MAX_SIZE);

  // Compose final SVG
  const stackedSVG = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${maxWidth}" height="${totalHeight}">
      ${svgParts.join('\n')}
    </svg>
  `;
  return { svg: stackedSVG, width: maxWidth, height: totalHeight };
}

app.post('/render', async (req, res) => {
  const { formulas } = req.body || {};
  if (!formulas || !Array.isArray(formulas) || formulas.length === 0) {
    return res.status(400).json({ error: 'Missing formulas array' });
  }

  try {
    // 1. Render stacked SVG
    const { svg, width, height } = renderStackedSVG(formulas);

    // 2. Rasterize SVG to RGBA (high quality)
    const { data: rgbaBuffer, info } = await sharp(Buffer.from(svg))
      .resize(width, height, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
        kernel: sharp.kernel.lanczos3
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // 3. Return base64 RGBA + size
    const base64 = Buffer.from(rgbaBuffer).toString('base64');
    res.json({
      width: info.width,
      height: info.height,
      channels: info.channels,
      rgbaBase64: base64
    });
  } catch (err) {
    console.error('Render error:', err);
    res.status(500).json({ error: 'Render failed: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MathJax v3 renderer (white text, high-res, stacked) listening on port ${PORT}`);
});
