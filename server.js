import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { createCanvas, loadImage } from "canvas";
import katex from "katex";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "5mb" }));

// Root test route
app.get("/", (req, res) => {
  res.status(200).send("✅ KaTeX renderer alive");
});

// Actual render endpoint
app.post("/render", async (req, res) => {
  try {
    const { latex, width = 512, height = 128 } = req.body;
    if (!latex) return res.status(400).json({ error: "Missing 'latex'" });

    // Render LaTeX to HTML string
    const html = katex.renderToString(latex, {
      throwOnError: false,
      displayMode: true,
    });

    // Simple text draw — (Roblox only needs pixel data)
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "black";
    ctx.font = "32px serif";
    ctx.fillText(html.replace(/<[^>]+>/g, ""), 10, 64);

    // Convert to PNG → base64
    const base64 = canvas.toDataURL("image/png").split(",")[1];
    res.json({
      ok: true,
      width,
      height,
      base64,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ KaTeX server running on port", PORT));