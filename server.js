// server.js
// Use: npm install express katex sharp body-parser cors
import express from "express";
import katex from "katex";
import sharp from "sharp";
import bodyParser from "body-parser";
import cors from "cors";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));

// Helper: extract <svg>...</svg> from katex.renderToString output
function extractSVG(katexHtml) {
  const m = katexHtml.match(/<svg[\s\S]*<\/svg>/);
  return m ? m[0] : null;
}

// Create tiles (base64) from raw RGBA buffer
function makeTilesFromRawBuffer(rawBuffer, width, height, channels, tileHeight = 8) {
  const tiles = [];
  const bytesPerRow = width * channels;

  for (let y = 0; y < height; y += tileHeight) {
    const h = Math.min(tileHeight, height - y);
    const sliceStart = y * bytesPerRow;
    const bytesPerTile = bytesPerRow * h;
    const slice = rawBuffer.slice(sliceStart, sliceStart + bytesPerTile);
    tiles.push(slice.toString("base64"));
  }

  return tiles;
}

app.post("/render", async (req, res) => {
  try {
    const { latex } = req.body;
    const outWidth = Number(req.body.width) || 512;
    const outHeight = Number(req.body.height) || 128;
    const padding = Number(req.body.padding) || 8;
    const tileHeight = Number(req.body.tileHeight) || 8;
    const supersample = Number(req.body.supersample) || 2; // render at higher DPI then downscale

    if (!latex || typeof latex !== "string") {
      return res.status(400).json({ error: "Missing 'latex' string in body." });
    }

    // Render KaTeX to SVG
    const katexHtml = katex.renderToString(latex, {
      output: "svg",
      throwOnError: false,
      displayMode: true,
      strict: false,
    });

    const innerSvg = extractSVG(katexHtml);
    if (!innerSvg) {
      return res.status(500).json({ error: "Failed to extract SVG from KaTeX output." });
    }

    // Try to get intrinsic SVG viewBox size (if present)
    let vbMatch = innerSvg.match(/viewBox="([^"]+)"/);
    let intrinsicW = null, intrinsicH = null;
    if (vbMatch) {
      const parts = vbMatch[1].split(/\s+/).map(Number);
      if (parts.length === 4) {
        intrinsicW = parts[2];
        intrinsicH = parts[3];
      }
    }

    // If intrinsic not found, we can wrap and let sharp measure by rendering temporarily
    if (!intrinsicW || !intrinsicH) {
      const wrappedTemp = `<svg xmlns="http://www.w3.org/2000/svg">${innerSvg}</svg>`;
      const tempMeta = await sharp(Buffer.from(wrappedTemp)).png().toBuffer({ resolveWithObject: true });
      intrinsicW = tempMeta.info.width || outWidth;
      intrinsicH = tempMeta.info.height || outHeight;
    }

    // Compute available area after padding
    const availW = Math.max(1, outWidth - 2 * padding);
    const availH = Math.max(1, outHeight - 2 * padding);
    // scale factor to fit intrinsic SVG into available area
    const scale = Math.min(availW / intrinsicW, availH / intrinsicH);

    // Render at supersampled internal size to improve AA, then we'll resize to outWidth/outHeight
    const renderW = Math.max(1, Math.ceil(intrinsicW * scale * supersample));
    const renderH = Math.max(1, Math.ceil(intrinsicH * scale * supersample));

    // Wrap SVG into a canvas with viewBox = intrinsic dims, then let sharp rasterize it to renderW x renderH
    const wrappedSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${renderW}" height="${renderH}" viewBox="0 0 ${intrinsicW} ${intrinsicH}" preserveAspectRatio="xMidYMid meet">
        ${innerSvg}
      </svg>
    `;

    // Rasterize to raw RGBA
    const { data, info } = await sharp(Buffer.from(wrappedSvg))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // data = Buffer of length = info.width * info.height * info.channels
    // Next: compose center into final canvas at outWidth*outHeight at supersampled resolution then downscale

    // Create an empty transparent canvas (supersampled)
    const canvasW = outWidth * supersample;
    const canvasH = outHeight * supersample;

    // Resize the rendered SVG to fit inside availW*supersample x availH*supersample
    const targetW = Math.round(availW * supersample);
    const targetH = Math.round(availH * supersample);

    const resizedBuffer = await sharp(data, {
      raw: {
        width: info.width,
        height: info.height,
        channels: info.channels,
      }
    }).resize(targetW, targetH, { fit: "contain" }).png().toBuffer();

    // Compose centered on transparent canvas and then get raw RGBA
    const composedBuffer = await sharp({
      create: {
        width: canvasW,
        height: canvasH,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite([{ input: resizedBuffer, gravity: "center" }])
      .raw()
      .toBuffer({ resolveWithObject: true });

    const finalRaw = composedBuffer.data; // Buffer
    const finalInfo = composedBuffer.info; // { width: canvasW, height: canvasH, channels: 4 }

    // Downscale to requested outWidth x outHeight for final image (to improve AA we can downscale)
    const downscaled = await sharp(finalRaw, {
      raw: {
        width: finalInfo.width,
        height: finalInfo.height,
        channels: finalInfo.channels
      }
    }).resize(outWidth, outHeight, { fit: "contain" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const rawBuffer = downscaled.data;
    const rawInfo = downscaled.info; // { width: outWidth, height: outHeight, channels: 4 }

    // Option A: return tiles of base64 raw bytes
    const tiles = makeTilesFromRawBuffer(rawBuffer, rawInfo.width, rawInfo.height, rawInfo.channels, tileHeight);

    return res.json({
      width: rawInfo.width,
      height: rawInfo.height,
      channels: rawInfo.channels,
      tileHeight: tileHeight,
      tiles: tiles
    });

  } catch (err) {
    console.error("Render error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("KaTeX renderer alive"));
app.listen(PORT, () => console.log(`Renderer listening on ${PORT}`));