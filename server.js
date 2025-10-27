// server.js
// npm i express katex sharp body-parser cors
import express from "express";
import katex from "katex";
import sharp from "sharp";
import bodyParser from "body-parser";
import cors from "cors";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));

// Helper to extract SVG from KaTeX output
function extractSVG(katexHtml) {
  const m = katexHtml.match(/<svg[\s\S]*<\/svg>/);
  return m ? m[0] : null;
}

function makeTilesFromRawBuffer(rawBuffer, width, height, channels, tileHeight = 8) {
  const tiles = [];
  const bytesPerRow = width * channels;
  for (let y = 0; y < height; y += tileHeight) {
    const h = Math.min(tileHeight, height - y);
    const start = y * bytesPerRow;
    const slice = rawBuffer.slice(start, start + bytesPerRow * h);
    tiles.push(slice.toString("base64"));
  }
  return tiles;
}

app.post("/render", async (req, res) => {
  try {
    const latex = String(req.body.latex || "");
    const outW = Number(req.body.width) || 512;
    const outH = Number(req.body.height) || 128;
    const padding = Number(req.body.padding) || 8;
    const tileHeight = Number(req.body.tileHeight) || 8;
    const supersample = Math.max(1, Number(req.body.supersample) || 2);

    if (!latex) return res.status(400).json({ error: "missing latex" });

    // Render KaTeX to SVG
    const katexHtml = katex.renderToString(latex, {
      output: "svg",
      throwOnError: false,
      displayMode: true,
      strict: false,
    });
    const innerSvg = extractSVG(katexHtml);
    if (!innerSvg) return res.status(500).json({ error: "katex->svg failed" });

    // try get viewBox
    let intrinsicW = null, intrinsicH = null;
    const vb = innerSvg.match(/viewBox="([^"]+)"/);
    if (vb) {
      const parts = vb[1].trim().split(/\s+/).map(Number);
      if (parts.length === 4) { intrinsicW = parts[2]; intrinsicH = parts[3]; }
    }

    // fallback measure by rasterizing SVG at 1:1 quickly
    if (!intrinsicW || !intrinsicH) {
      const tmpWrapped = `<svg xmlns="http://www.w3.org/2000/svg">${innerSvg}</svg>`;
      const tmp = await sharp(Buffer.from(tmpWrapped)).png().toBuffer({ resolveWithObject: true });
      intrinsicW = tmp.info.width || outW;
      intrinsicH = tmp.info.height || outH;
    }

    // available area
    const availW = Math.max(1, outW - 2 * padding);
    const availH = Math.max(1, outH - 2 * padding);
    const fitScale = Math.min(availW / intrinsicW, availH / intrinsicH);

    // render at supersampled internal size then downscale
    const renderW = Math.max(1, Math.ceil(intrinsicW * fitScale * supersample));
    const renderH = Math.max(1, Math.ceil(intrinsicH * fitScale * supersample));

    const wrappedSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${renderW}" height="${renderH}"
           viewBox="0 0 ${intrinsicW} ${intrinsicH}" preserveAspectRatio="xMidYMid meet">
        ${innerSvg}
      </svg>
    `;

    // rasterize svg -> raw RGBA
    const { data: svgData, info: svgInfo } = await sharp(Buffer.from(wrappedSvg))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // resize rendered raster to fit avail area (supersampled canvas)
    const targetW = Math.round(availW * supersample);
    const targetH = Math.round(availH * supersample);

    const resizedPng = await sharp(svgData, {
      raw: { width: svgInfo.width, height: svgInfo.height, channels: svgInfo.channels }
    }).resize(targetW, targetH, { fit: "contain" }).png().toBuffer();

    // compose onto transparent canvas sized outW*supersample x outH*supersample
    const canvasW = outW * supersample;
    const canvasH = outH * supersample;

    const composed = await sharp({
      create: { width: canvasW, height: canvasH, channels: 4, background: { r:0,g:0,b:0,alpha:0 } }
    }).composite([{ input: resizedPng, gravity: "center" }])
      .raw()
      .toBuffer({ resolveWithObject: true });

    // downscale to final outW x outH
    const down = await sharp(composed.data, {
      raw: { width: composed.info.width, height: composed.info.height, channels: composed.info.channels }
    }).resize(outW, outH, { fit: "contain" }).raw().toBuffer({ resolveWithObject: true });

    const rawBuffer = down.data;
    const rawInfo = down.info; // width/outH, channels (should be 4)

    // create tiles (base64 of raw bytes)
    const tiles = makeTilesFromRawBuffer(rawBuffer, rawInfo.width, rawInfo.height, rawInfo.channels, tileHeight);

    return res.json({
      width: rawInfo.width,
      height: rawInfo.height,
      channels: rawInfo.channels,
      tileHeight: tileHeight,
      tiles: tiles
    });

  } catch (err) {
    console.error("render error:", err);
    res.status(500).json({ error: String(err && err.stack ? err.stack : err) });
  }
});

app.get("/", (req, res) => res.send("katex renderer alive"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("renderer listening on", PORT));