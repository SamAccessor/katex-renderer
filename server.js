// server.js
// npm install express cors body-parser katex sharp
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import katex from "katex";
import sharp from "sharp";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "20mb" }));

function splitBufferToTiles(rawBuffer, width, height, channels, tileHeight = 8) {
  const tiles = [];
  const bytesPerRow = width * channels;
  for (let y = 0; y < height; y += tileHeight) {
    const rows = Math.min(tileHeight, height - y);
    const start = y * bytesPerRow;
    const end = start + bytesPerRow * rows;
    tiles.push(rawBuffer.slice(start, end).toString("base64"));
  }
  return tiles;
}

app.get("/", (req, res) => res.send("KaTeX renderer alive"));

app.post("/renderRaw", async (req, res) => {
  try {
    const latex = String(req.body.latex || "");
    const outW = Number(req.body.width) || 512;
    const outH = Number(req.body.height) || 128;
    const tileHeight = Math.max(1, Number(req.body.tileHeight) || 8);
    const fontSize = Number(req.body.fontSize) || 48;

    if (!latex) return res.status(400).json({ error: "missing latex" });

    console.log("[server] Rendering:", latex);

    // 1) Render KaTeX to HTML
    const html = katex.renderToString(latex, {
      throwOnError: false,
      displayMode: true,
      colorIsTextColor: true
    });

    // 2) wrap into an SVG with white text on transparent background
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}">
        <foreignObject width="100%" height="100%">
          <div xmlns="http://www.w3.org/1999/xhtml"
               style="
                 display:flex;
                 align-items:center;
                 justify-content:center;
                 width:100%;
                 height:100%;
                 background: transparent;
                 color: white;
                 font-size: ${fontSize}px;
                 font-family: 'Times New Roman', serif;
               ">
            ${html}
          </div>
        </foreignObject>
      </svg>
    `;

    // 3) Convert SVG -> PNG (sharp), then to raw RGBA
    const pngBuffer = await sharp(Buffer.from(svg))
      .png({ compressionLevel: 9 })
      .toBuffer();

    // make raw RGBA buffer
    const rawResult = await sharp(pngBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const rawBuffer = rawResult.data;
    const info = rawResult.info; // width,height,channels

    // 4) Split into tiles (base64 raw bytes)
    const tiles = splitBufferToTiles(rawBuffer, info.width, info.height, info.channels, tileHeight);

    // optional: include pngBase64 for debugging if you want
    const pngBase64 = pngBuffer.toString("base64");

    console.log("[server] Render DONE", { width: info.width, height: info.height, tiles: tiles.length });

    res.json({
      width: info.width,
      height: info.height,
      channels: info.channels,
      tileHeight,
      tiles,
      pngBase64
    });
  } catch (err) {
    console.error("[server] ERROR:", err);
    res.status(500).json({ error: String(err && err.stack ? err.stack : err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`KaTeX renderer listening on ${PORT}`));