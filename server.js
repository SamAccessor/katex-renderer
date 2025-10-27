import express from "express";
import katex from "katex";
import { createCanvas } from "canvas";

const app = express();
app.use(express.json({ limit: "10mb" }));

app.post("/render", (req, res) => {
  const latex = req.body.latex || "E = mc^2";

  try {
    // Render LaTeX into HTML (for debugging only)
    const html = katex.renderToString(latex, {
      throwOnError: false,
      displayMode: true,
    });

    // Create a transparent canvas
    const width = 512, height = 256;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    // Clear and set transparent background
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(0,0,0,0)";
    ctx.fillRect(0, 0, width, height);

    // Temporary text (replace with real KaTeX image later)
    ctx.fillStyle = "white";
    ctx.font = "48px serif";
    ctx.fillText(latex, 20, 100);

    // Convert to pixel data
    const imgData = ctx.getImageData(0, 0, width, height).data;
    const pixels = [];
    for (let i = 0; i < imgData.length; i += 4) {
      pixels.push({
        r: imgData[i],
        g: imgData[i + 1],
        b: imgData[i + 2],
        a: imgData[i + 3],
      });
    }

    res.json({ width, height, pixels });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ KaTeX Renderer running on port ${PORT}`));