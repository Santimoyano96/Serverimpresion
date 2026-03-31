// server_mac.js — Servidor de impresión para macOS (CUPS + Puppeteer + launchd)

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer-core");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const app = express();

// ========= Middlewares =========
app.use(express.json({ type: ["application/json", "application/*+json"], limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: ["text/plain"], limit: "1mb" }));
app.use(cors({ origin: true }));

// ========= Rutas pkg-safe =========
const RUNTIME_DIR = (typeof process.pkg !== "undefined")
  ? path.dirname(process.execPath)
  : __dirname;

const baseDir = RUNTIME_DIR;
const tempDir = path.join(baseDir, "temp");
try { fs.mkdirSync(tempDir, { recursive: true }); } catch {}

// ========= Utils =========
const safeRm = (f) => f && fs.promises.rm(f, { force: true }).catch(() => {});

// ========= HTML helper =========
function htmlFromText(text) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Ticket</title>
<style>
  @page { margin: 0; size: 72mm auto; }
  * { box-sizing: border-box; }
  body { margin: 4mm 2mm 6mm 2mm; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.4; width: 68mm; }
  .line { border-top: 1px dashed #000; margin: 4px 0; }
  .center { text-align: center; }
  .right { text-align: right; }
</style>
</head>
<body>
  <div class="mono">${(text || "").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br/>")}</div>
</body>
</html>`;
}

// ========= Render a PDF con Puppeteer (core) =========
async function renderHtmlToPdf(htmlPath, pdfPath) {
  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.emulateMediaType("print");
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle0" });
    await page.pdf({
      path: pdfPath,
      printBackground: true,
      width: "72mm",
      height: "auto",
      margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
      pageRanges: "1",
    });
  } finally {
    await browser.close();
  }
}

// ========= Listar impresoras via lpstat (CUPS) =========
async function getPrintersMac() {
  // lpstat -a lista todas las impresoras aceptando trabajos
  // lpstat -d da la impresora predeterminada
  // lpstat -p da el estado de cada impresora

  let defaultPrinter = null;
  try {
    const { stdout: defOut } = await execFileAsync("lpstat", ["-d"]);
    // "system default destination: Brother_HL"
    const match = defOut.match(/system default destination:\s*(.+)/);
    if (match) defaultPrinter = match[1].trim();
  } catch {}

  // Obtener lista + estado
  let printerMap = {};
  try {
    const { stdout: pOut } = await execFileAsync("lpstat", ["-p"]);
    // "printer Brother_HL is idle.  enabled since ..."
    // "printer EPSON_XP is stopped.  disabled since ..."
    for (const line of pOut.split("\n")) {
      const m = line.match(/^printer\s+(\S+)\s+(is\s+\S+)/);
      if (m) {
        const name = m[1];
        const statusRaw = m[2].replace("is ", "").trim();
        printerMap[name] = statusRaw; // "idle", "stopped", "processing"
      }
    }
  } catch {}

  // Si lpstat -p no dio nada, intentar con lpstat -a
  if (Object.keys(printerMap).length === 0) {
    try {
      const { stdout: aOut } = await execFileAsync("lpstat", ["-a"]);
      // "Brother_HL accepting requests since ..."
      for (const line of aOut.split("\n")) {
        const m = line.match(/^(\S+)\s+accepting/);
        if (m) printerMap[m[1]] = "idle";
      }
    } catch {}
  }

  const printers = Object.entries(printerMap).map(([name, status]) => ({
    name,
    status,
    default: name === defaultPrinter,
    workOffline: status === "stopped",
  }));

  return printers;
}

// ========= Imprimir PDF via lp (CUPS) =========
async function printPdfMac(pdfPath, printerName) {
  const args = ["-d", printerName, "-o", "media=72mmx200mm", "-o", "fit-to-page=false", "-o", "scaling=100", pdfPath];
  const { stdout, stderr } = await execFileAsync("lp", args);
  console.log("lp stdout:", stdout);
  if (stderr) console.warn("lp stderr:", stderr);
}

// ========= Endpoints =========
app.get("/health", (_req, res) => {
  res.json({ status: "ok", platform: "macOS", time: new Date().toISOString() });
});

app.get("/printers", async (_req, res) => {
  try {
    const printers = await getPrintersMac();
    if (printers.length === 0) {
      return res.status(404).json({ success: false, error: "No se encontraron impresoras instaladas." });
    }
    return res.json(printers);
  } catch (e) {
    console.error("❌ Error listando impresoras:", e);
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// ========= /print =========
app.post("/print", async (req, res) => {
  let htmlFilePath = null;
  let pdfPath = null;

  try {
    const printer =
      (req.body && (req.body.printer || req.body.printerName)) || null;

    const type = (req.body && (req.body.type || "text")).toLowerCase();

    const content =
      (req.body && (req.body.data || req.body.text || req.body.content)) || "";

    const inputPath = req.body && (req.body.path || req.body.filePath) || null;

    console.log("🖨️ ===== NUEVA PETICIÓN DE IMPRESIÓN =====");
    console.log("🖨️ Tipo:", type);
    console.log("🖨️ Impresora:", printer || "(predeterminada del SO)");
    console.log("🖨️ Contenido (len):", typeof content === "string" ? content.length : 0);
    if (inputPath) console.log("🖨️ Archivo:", inputPath);

    if (!printer) {
      return res.status(400).json({ success: false, error: "Falta 'printer' (nombre exacto de la impresora)." });
    }

    const stamp = Date.now();
    htmlFilePath = path.join(tempDir, `print_${stamp}.html`);
    pdfPath = path.join(tempDir, `ticket_${stamp}.pdf`);

    if (type === "text") {
      if (!content || typeof content !== "string") {
        return res.status(400).json({ success: false, error: "Falta 'data'/'text' con contenido para imprimir." });
      }
      const html = htmlFromText(content);
      fs.writeFileSync(htmlFilePath, html, "utf8");
      await renderHtmlToPdf(htmlFilePath, pdfPath);
      await printPdfMac(pdfPath, printer);
      return res.json({ success: true, mode: "text→pdf", printer });
    }

    if (type === "html") {
      if (!content || typeof content !== "string") {
        return res.status(400).json({ success: false, error: "Falta 'content' HTML para imprimir." });
      }
      fs.writeFileSync(htmlFilePath, content, "utf8");
      await renderHtmlToPdf(htmlFilePath, pdfPath);
      await printPdfMac(pdfPath, printer);
      return res.json({ success: true, mode: "html→pdf", printer });
    }

    if (type === "file") {
      if (!inputPath) {
        return res.status(400).json({ success: false, error: "Falta 'path' (o 'filePath') al PDF." });
      }
      if (!fs.existsSync(inputPath)) {
        return res.status(404).json({ success: false, error: `Archivo no encontrado: ${inputPath}` });
      }
      const ext = path.extname(inputPath).toLowerCase();
      if (ext !== ".pdf") {
        return res.status(400).json({ success: false, error: "Solo se admite PDF en 'file' para impresión." });
      }
      await printPdfMac(inputPath, printer);
      return res.json({ success: true, mode: "file-pdf", printer });
    }

    return res.status(400).json({ success: false, error: "type inválido. Usa 'text', 'html' o 'file'." });
  } catch (err) {
    console.error("❌ Error imprimiendo:", err);
    return res.status(500).json({ success: false, error: String(err?.message || err) });
  } finally {
    setTimeout(() => {
      safeRm(pdfPath);
      safeRm(htmlFilePath);
    }, 10_000);
  }
});

// ========= Inicio del server =========
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Servidor de impresoras en http://localhost:${PORT}`);
  console.log(`📋 Impresoras:   GET /printers`);
  console.log(`🧪 Salud:        GET /health`);
});

module.exports = app;
