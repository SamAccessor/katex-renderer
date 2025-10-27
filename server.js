import express from "express";
import cors from "cors";
import { renderToString } from "katex";
import { createCanvas, loadImage } from "canvas";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.send("✅ KaTeX Render Server Online");
});

// 🔹 Render KaTeX formula to a PNG buffer (base64)
app.post("/render", async (req, res) => {
  try {
    const { latex, fontSize = 32, scale = 2 } = req.body;
    if (!latex) return res.status(400).json({ error: "No LaTeX provided" });

    // Render KaTeX to HTML
    const html = renderToString(latex, { throwOnError: false });

    // Create canvas based on text length
    const width = 800 * scale;
    const height = 200 * scale;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    // Optional background transparency
    ctx.clearRect(0, 0, width, height);

    // Draw KaTeX output (you can later fine-tune font and position)
    ctx.fillStyle = "black";
    ctx.font = `${fontSize * scale}px Times New Roman`;
    ctx.fillText(html.replace(/<[^>]+>/g, ""), 10, 50);

    // Send back PNG as base64
    const base64 = canvas.toDataURL("image/png").split(",")[1];
    res.json({ success: true, image: base64 });
  } catch (err) {
    console.error("Render Error:", err);
    res.status(500).json({ error: "Render failed", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));