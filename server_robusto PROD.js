// server_robusto.js — Robust server de impresión (pkg-safe + puppeteer-core + Sumatra externo)

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer-core");
const { print: printPDF, getPrinters } = require("pdf-to-printer");
const { execFile } = require("child_process");

const app = express();

// ========= Middlewares =========
app.use(express.json({ type: ["application/json", "application/*+json"], limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: ["text/plain"], limit: "1mb" }));
app.use(cors({ origin: true }));

// ========= Rutas pkg-safe =========
const RUNTIME_DIR = (typeof process.pkg !== "undefined")
  ? path.dirname(process.execPath)    // p.ej. C:\Program Files\PrinterEndpoint
  : __dirname;                        // dev

const baseDir = RUNTIME_DIR;
const tempDir = path.join(baseDir, "temp");
const binDir  = path.join(baseDir, "bin");
try { fs.mkdirSync(tempDir, { recursive: true }); } catch {}
try { fs.mkdirSync(binDir,  { recursive: true }); } catch {}

// Ruta esperada de Sumatra externo
const SUMATRA = process.env.SUMATRA_PDF_PATH || path.join(binDir, "SumatraPDF.exe");

// ========= Utils =========
const safeRm = (f) => f && fs.promises.rm(f, { force: true }).catch(() => {});

// ========= HTML helper =========
function htmlFromText(text) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ticket</title>
<style>
  @page { margin: 0; size: 80mm auto; }
  body { margin: 6mm 0 8mm 0; font-family: -apple-system, system-ui, Roboto, "Segoe UI", Arial, sans-serif; font-size: 12px; }
  .wrap { width: 80mm; padding: 0 2mm; box-sizing: border-box; }
  .line { border-top: 1px dashed #000; margin: 6px 0; }
  .center { text-align: center; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="center"><strong>Página de prueba</strong></div>
    <div class="line"></div>
    <div class="mono">${(text || "").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
  </div>
</body>
</html>`;
}

// ========= Render a PDF con Puppeteer (core) =========
async function renderHtmlToPdf(htmlPath, pdfPath) {
  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.emulateMediaType("screen");
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle0" });
    await page.pdf({
      path: pdfPath,
      printBackground: true,
      width: "80mm",
      margin: { top: "4mm", right: "0mm", bottom: "6mm", left: "0mm" },
    });
  } finally {
    await browser.close();
  }
}

// ===== Helpers de listado con fallback =====
function getPrintersViaPowerShellWMI() {
  return new Promise((resolve, reject) => {
    const ps =
      '[Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8; ' +
      'Get-WmiObject -Class Win32_Printer | ' +
      'Select-Object Name,PrinterStatus,Default,WorkOffline | ' +
      'ConvertTo-Json -Compress';

    execFile("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const data = JSON.parse(stdout);
        const arr = Array.isArray(data) ? data : [data];
        const mapped = arr.map(p => ({
          name: p?.Name,
          status: p?.PrinterStatus ?? "Unknown",
          default: !!p?.Default,
          workOffline: !!p?.WorkOffline,
        })).filter(p => !!p.name);
        resolve(mapped);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function getPrintersViaWmic() {
  return new Promise((resolve, reject) => {
    execFile("wmic", ["printer", "get", "Name,Default,WorkOffline,PrinterStatus", "/format:csv"], { windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const lines = stdout.split(/\r?\n/).filter(Boolean);
        const rows = lines.slice(1).map(l => l.split(","));
        const mapped = rows.map(cols => {
          const name = cols[cols.length - 4];
          const def = cols[cols.length - 3];
          const offline = cols[cols.length - 2];
          const status = cols[cols.length - 1];
          if (!name) return null;
          return {
            name,
            status: status || "Unknown",
            default: def === "TRUE" || def === "TRUE\r",
            workOffline: offline === "TRUE" || offline === "TRUE\r",
          };
        }).filter(Boolean);
        resolve(mapped);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ========= Endpoints =========
app.get("/health", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.get("/printers", async (_req, res) => {
  try {
    try {
      const list = await getPrinters();
      const printers = (list || []).map(p => ({
        name: p?.name || p?.printer || String(p),
        status: p?.status || p?.printerStatus || "Unknown",
        default: !!(p?.isDefault || p?.Default),
      }));
      if (printers.length) return res.json(printers);
      throw new Error("Lista vacía desde pdf-to-printer");
    } catch (e1) {
      console.warn("⚠️ getPrinters() falló, probando PowerShell WMI…", e1?.message || e1);
    }

    try {
      const printers = await getPrintersViaPowerShellWMI();
      if (printers.length) return res.json(printers);
      throw new Error("Lista vacía desde PowerShell WMI");
    } catch (e2) {
      console.warn("⚠️ PowerShell WMI falló, probando WMIC…", e2?.message || e2);
    }

    const printers = await getPrintersViaWmic();
    return res.json(printers);
  } catch (e) {
    console.error("❌ Error listando impresoras:", e);
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// ========= /print robusto =========
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

      await printPDF(pdfPath, { printer, sumatraPdfPath: SUMATRA });
      return res.json({ success: true, mode: "text→pdf", printer });
    }

    if (type === "html") {
      if (!content || typeof content !== "string") {
        return res.status(400).json({ success: false, error: "Falta 'content' HTML para imprimir." });
      }
      fs.writeFileSync(htmlFilePath, content, "utf8");
      await renderHtmlToPdf(htmlFilePath, pdfPath);

      await printPDF(pdfPath, { printer, sumatraPdfPath: SUMATRA });
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
        return res.status(400).json({ success: false, error: "Solo se admite PDF en 'file' para impresión robusta." });
      }

      await printPDF(inputPath, { printer, sumatraPdfPath: SUMATRA });
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
