// Polyfill browser globals for pdf parsers in Node.js
if (typeof global.DOMMatrix === 'undefined') {
  global.DOMMatrix = class DOMMatrix {
    constructor() {
      this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
    }
  };
}

const express = require('express');
const multer = require('multer');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const pdfParse = require('pdf-parse');
const sharp = require('sharp');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

// Setup directories
const TEMP_DIR = path.join(__dirname, 'temp_uploads');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '150mb' }));
app.use(express.urlencoded({ extended: true, limit: '150mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMP_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    cb(null, `${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 }
});

const cleanupFiles = (...filePaths) => {
  filePaths.forEach((p) => {
    if (p && fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch (e) {}
    }
  });
};

const hexToRgb = (hex) => {
  if (!hex || typeof hex !== 'string') return rgb(0, 0, 0);
  const cleanHex = hex.replace('#', '');
  if (cleanHex.length !== 6) return rgb(0, 0, 0);
  const r = parseInt(cleanHex.substring(0, 2), 16) / 255;
  const g = parseInt(cleanHex.substring(2, 4), 16) / 255;
  const b = parseInt(cleanHex.substring(4, 6), 16) / 255;
  return rgb(r, g, b);
};

const getSofficeBinary = () => {
  if (process.platform === 'win32') {
    const winPaths = [
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Programs\\LibreOffice\\program\\soffice.exe')
    ];
    for (const p of winPaths) {
      if (fs.existsSync(p)) return `"${p}"`;
    }
  }
  return 'soffice';
};

const getConversionParams = (inputExt, targetExt) => {
  let inFilter = '';
  let outFilter = targetExt;

  if (inputExt === 'pdf') {
    inFilter = '--infilter=writer_pdf_import';
    outFilter = targetExt;
  } else {
    outFilter = targetExt;
  }

  return { inFilter, outFilter };
};

// ==========================================
// 1. SINGLE FILE CONVERSION ENDPOINT
// ==========================================
app.post('/api/convert', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const { targetFormat } = req.body;
  if (!targetFormat) {
    cleanupFiles(req.file.path);
    return res.status(400).json({ error: 'Target format required.' });
  }

  const inputPath = req.file.path;
  
  let originalExt = path.extname(req.file.originalname).replace(/^\./, '').toLowerCase();
  if (!originalExt && req.file.mimetype) {
    if (req.file.mimetype.includes('pdf')) originalExt = 'pdf';
    else if (req.file.mimetype.includes('jpeg') || req.file.mimetype.includes('jpg')) originalExt = 'jpg';
    else if (req.file.mimetype.includes('png')) originalExt = 'png';
  }

  const cleanTargetExt = targetFormat.replace(/^\./, '').toLowerCase();
  const originalNameWithoutExt = path.parse(req.file.originalname).name || 'converted_file';
  const sofficeBin = getSofficeBinary();

  try {
    const fileBytes = fs.readFileSync(inputPath);

    // --- CASE 1: PDF -> TXT & PDF -> HTML ---
    if (originalExt === 'pdf' && (cleanTargetExt === 'txt' || cleanTargetExt === 'html')) {
      const parsedData = await pdfParse(fileBytes);
      cleanupFiles(inputPath);

      if (cleanTargetExt === 'txt') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(originalNameWithoutExt)}.txt"`);
        return res.send(parsedData.text || 'No extractable text found.');
      } else {
        const textBody = (parsedData.text || 'No text extracted')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\n/g, '<br>\n');

        const htmlOutput = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${originalNameWithoutExt}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; padding: 2rem; max-width: 800px; margin: 0 auto; color: #1e293b; background: #f8fafc; }
    .content-card { background: #ffffff; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
    h1 { color: #4f46e5; border-bottom: 2px solid #e2e8f0; padding-bottom: 0.5rem; }
  </style>
</head>
<body>
  <div class="content-card">
    <h1>${originalNameWithoutExt}</h1>
    <div>${textBody}</div>
  </div>
</body>
</html>`;

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(originalNameWithoutExt)}.html"`);
        return res.send(htmlOutput);
      }
    }

    // --- CASE 2: Image -> PDF ---
    if (['png', 'jpg', 'jpeg', 'webp'].includes(originalExt) && cleanTargetExt === 'pdf') {
      const pdfDoc = await PDFDocument.create();
      let img;
      if (originalExt === 'png') {
        img = await pdfDoc.embedPng(fileBytes);
      } else {
        const jpegBuffer = await sharp(fileBytes).jpeg().toBuffer();
        img = await pdfDoc.embedJpg(jpegBuffer);
      }

      const page = pdfDoc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });

      const pdfBytes = await pdfDoc.save();
      cleanupFiles(inputPath);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(originalNameWithoutExt)}.pdf"`);
      return res.send(Buffer.from(pdfBytes));
    }

    // --- CASE 3: Image -> Image ---
    if (['png', 'jpg', 'jpeg', 'webp'].includes(originalExt) && ['png', 'jpg', 'jpeg', 'webp'].includes(cleanTargetExt)) {
      const targetFormatName = cleanTargetExt === 'jpg' ? 'jpeg' : cleanTargetExt;
      const convertedBuffer = await sharp(fileBytes).toFormat(targetFormatName).toBuffer();
      cleanupFiles(inputPath);

      res.setHeader('Content-Type', `image/${cleanTargetExt}`);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(originalNameWithoutExt)}.${cleanTargetExt}"`);
      return res.send(convertedBuffer);
    }

    // --- CASE 4: TXT -> PDF ---
    if (originalExt === 'txt' && cleanTargetExt === 'pdf') {
      const textContent = fs.readFileSync(inputPath, 'utf8');
      const pdfDoc = await PDFDocument.create();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      
      const lines = textContent.split(/\r?\n/);
      let page = pdfDoc.addPage([595.28, 841.89]);
      let y = 800;

      for (const line of lines) {
        if (y < 50) {
          page = pdfDoc.addPage([595.28, 841.89]);
          y = 800;
        }
        page.drawText(line.substring(0, 90), { x: 50, y, size: 10, font, color: rgb(0, 0, 0) });
        y -= 14;
      }

      const pdfBytes = await pdfDoc.save();
      cleanupFiles(inputPath);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(originalNameWithoutExt)}.pdf"`);
      return res.send(Buffer.from(pdfBytes));
    }

    // --- CASE 5: LibreOffice Conversion ---
    const userProfileDir = path.join(TEMP_DIR, `lo_profile_${Date.now()}`);
    const fileUri = `file:///${userProfileDir.replace(/\\/g, '/').replace(/ /g, '%20')}`;
    const { inFilter, outFilter } = getConversionParams(originalExt, cleanTargetExt);

    const args = [
      `"-env:UserInstallation=${fileUri}"`,
      '--headless',
      inFilter,
      `--convert-to ${outFilter}`,
      `"${inputPath}"`,
      `--outdir "${TEMP_DIR}"`
    ].filter(Boolean).join(' ');

    const cmd = `${sofficeBin} ${args}`;
    
    await execPromise(cmd, { timeout: 45000 });

    const generatedFileName = `${path.parse(inputPath).name}.${cleanTargetExt}`;
    const generatedFilePath = path.join(TEMP_DIR, generatedFileName);

    if (!fs.existsSync(generatedFilePath)) {
      throw new Error(`Conversion process produced no output.`);
    }

    res.download(generatedFilePath, `${originalNameWithoutExt}.${cleanTargetExt}`, (err) => {
      cleanupFiles(inputPath, generatedFilePath);
      if (fs.existsSync(userProfileDir)) {
        try { fs.rmSync(userProfileDir, { recursive: true, force: true }); } catch (e) {}
      }
    });

  } catch (error) {
    console.error('Conversion Error:', error.message);
    cleanupFiles(inputPath);
    res.status(500).json({ 
      error: `Could not convert .${originalExt || 'unknown'} to .${cleanTargetExt}. Format pairing may not be supported.` 
    });
  }
});

// ==========================================
// 2. BATCH MULTI-IMAGE MERGE TO SINGLE PDF
// ==========================================
app.post('/api/batch/merge-images-pdf', upload.array('files', 50), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No images provided for batch merging.' });
  }

  const uploadedPaths = req.files.map(f => f.path);

  try {
    const pdfDoc = await PDFDocument.create();

    for (const file of req.files) {
      const fileBytes = fs.readFileSync(file.path);
      const ext = path.extname(file.originalname).replace(/^\./, '').toLowerCase();
      let img;

      if (ext === 'png') {
        img = await pdfDoc.embedPng(fileBytes);
      } else {
        const jpegBuffer = await sharp(fileBytes).jpeg().toBuffer();
        img = await pdfDoc.embedJpg(jpegBuffer);
      }

      const page = pdfDoc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }

    const mergedPdfBytes = await pdfDoc.save();
    cleanupFiles(...uploadedPaths);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="merged_images.pdf"');
    res.send(Buffer.from(mergedPdfBytes));
  } catch (err) {
    console.error('Batch Image Merge Error:', err);
    cleanupFiles(...uploadedPaths);
    res.status(500).json({ error: 'Failed to merge images into PDF.' });
  }
});

// ==========================================
// 3. PDF LIVE EDIT ENDPOINT
// ==========================================
app.post('/api/pdf/apply-edits', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded.' });

  const inputPath = req.file.path;

  try {
    const annotations = req.body.annotations ? JSON.parse(req.body.annotations) : [];
    const fileBytes = fs.readFileSync(inputPath);
    
    const pdfDoc = await PDFDocument.load(fileBytes);
    const pages = pdfDoc.getPages();
    const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    for (const item of annotations) {
      const pageIndex = parseInt(item.pageIndex, 10) || 0;
      if (pageIndex < 0 || pageIndex >= pages.length) continue;

      const page = pages[pageIndex];
      const { width: pdfWidth, height: pdfHeight } = page.getSize();

      const scaleX = item.canvasWidth ? (pdfWidth / item.canvasWidth) : 1;
      const scaleY = item.canvasHeight ? (pdfHeight / item.canvasHeight) : 1;

      if (item.type === 'text' && item.text) {
        const fontSize = Math.max(6, (parseFloat(item.fontSize) || 16) * scaleY);
        const posX = Math.max(0, (parseFloat(item.x) || 0) * scaleX);
        const posY = pdfHeight - ((parseFloat(item.y) || 0) * scaleY) - fontSize;
        const fontToUse = item.fontWeight === 'bold' ? boldFont : regularFont;
        const textColor = hexToRgb(item.fill || '#000000');

        page.drawText(String(item.text), {
          x: posX,
          y: Math.max(0, posY),
          size: fontSize,
          font: fontToUse,
          color: textColor
        });
      }

      if (item.type === 'image' && item.imageData) {
        const posX = Math.max(0, (parseFloat(item.x) || 0) * scaleX);
        const imgWidth = (parseFloat(item.width) || 100) * scaleX;
        const imgHeight = (parseFloat(item.height) || 100) * scaleY;
        const posY = pdfHeight - ((parseFloat(item.y) || 0) * scaleY) - imgHeight;

        const base64Data = item.imageData.replace(/^data:image\/\w+;base64,/, '');
        const imageBuffer = Buffer.from(base64Data, 'base64');

        const embeddedImage = item.imageData.includes('image/png')
          ? await pdfDoc.embedPng(imageBuffer)
          : await pdfDoc.embedJpg(imageBuffer);

        page.drawImage(embeddedImage, {
          x: posX,
          y: Math.max(0, posY),
          width: imgWidth,
          height: imgHeight
        });
      }
    }

    const modifiedPdfBytes = await pdfDoc.save();
    cleanupFiles(inputPath);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="edited_${req.file.originalname}"`);
    res.send(Buffer.from(modifiedPdfBytes));

  } catch (error) {
    console.error('PDF Edit Processing Error:', error);
    cleanupFiles(inputPath);
    res.status(500).json({ error: error.message || 'Failed to apply edits.' });
  }
});

// Explicit root fallback
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(` All For One Server running on Port: ${PORT}`);
  console.log(` Open: http://localhost:${PORT}`);
  console.log(`=========================================`);
});