import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import katex from "katex";
import puppeteer from "puppeteer";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));

app.post("/render", async (req, res) => {
  const { latex } = req.body;
  if (!latex) return res.status(400).json({ error: "Missing LaTeX input" });

  const html = `
<html>
  <head>
    <style>
      body {
        margin: 0;
        padding: 0;
        background: transparent;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
      }
      .math {
        font-size: 48px;
        color: white; /* 👈 White KaTeX text */
      }
      .katex {
        color: white !important; /* 👈 Force all KaTeX internal elements to white */
      }
    </style>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
  </head>
  <body>
    <div class="math">
      ${katex.renderToString(latex, { throwOnError: false, displayMode: true })}
    </div>
  </body>
</html>
`;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 200 });
    await page.setContent(html, { waitUntil: "networkidle0" });

    const element = await page.$("body");
    const imageBuffer = await element.screenshot({ omitBackground: true });

    res.setHeader("Content-Type", "image/png");
    res.end(imageBuffer);
  } catch (err) {
    console.error("[Render Error]", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ KaTeX Renderer running on port ${PORT}`));