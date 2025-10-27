import express from "express";
import katex from "katex";
import sharp from "sharp";
import cors from "cors";
import bodyParser from "body-parser";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));

app.get("/", (req, res) => {
  res.send("✅ KaTeX Renderer running (debug build)");
});

app.post("/renderRaw", async (req, res) => {
  const {
    latex,
    width = 512,
    height = 128,
    tileHeight = 8,
    fontSize = 48,
  } = req.body;

  if (!latex) {
    return res.status(400).json({ error: "Missing latex input" });
  }

  console.log("[RenderRaw] Starting render:", latex);

  try {
    // Step 1: Render KaTeX → HTML
    const html = katex.renderToString(latex, {
      throwOnError: false,
      displayMode: true,
      colorIsTextColor: true,
    });

    // Step 2: Make SVG container
    const styledSVG = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <foreignObject width="100%" height="100%">
          <div xmlns="http://www.w3.org/1999/xhtml"
               style="
                 display:flex;
                 align-items:center;
                 justify-content:center;
                 width:100%;
                 height:100%;
                 color:white;
                 background:transparent;
                 font-size:${fontSize}px;
                 font-family: 'Latin Modern Math', 'Times New Roman', serif;
               ">
            ${html}
          </div>
        </foreignObject>
      </svg>
    `;

    console.log("[RenderRaw] SVG built, converting to PNG...");

    // Step 3: Convert SVG → PNG
    const pngBuffer = await sharp(Buffer.from(styledSVG))
      .png({ compressionLevel: 9 })
      .toBuffer()
      .catch((err) => {
        console.error("[RenderRaw] Sharp PNG conversion error:", err);
        throw new Error("sharp_failed");
      });

    console.log("[RenderRaw] PNG conversion OK, extracting raw pixels...");

    const img = sharp(pngBuffer);
    const meta = await img.metadata();
    const raw = await img.raw().toBuffer();

    console.log("[RenderRaw] Metadata:", meta);

    const fullWidth = meta.width;
    const fullHeight = meta.height;

    const tiles = [];
    for (let y = 0; y < fullHeight; y += tileHeight) {
      const start = y * fullWidth * 4;
      const end = (y + tileHeight) * fullWidth * 4;
      tiles.push(raw.slice(start, end).toString("base64"));
    }

    console.log("[RenderRaw] Render successful! Sending JSON response.");
    res.json({
      width: fullWidth,
      height: fullHeight,
      channels: 4,
      tileHeight,
      tiles,
    });
  } catch (err) {
    console.error("[RenderRaw] ERROR:", err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ KaTeX Renderer (debug) running on port ${PORT}`);
});