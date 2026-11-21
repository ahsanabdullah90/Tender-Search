import fs from 'fs';
import path from 'path';
import { TESSDATA_DIR } from '../db/connection.js';
import { getAppSetting } from '../db/repositories/systemRepo.js';

export const LOCAL_OCR_DEFAULT_MAX_PAGES = 3;

export interface LocalOcrResult {
  text: string;
  pagesOcred: number;
  engine: 'tesseract.js';
}

let tesseractWorkerPromise: Promise<any> | null = null;
let ocrMutex: Promise<void> = Promise.resolve();

function withOcrMutex<T>(task: () => Promise<T>): Promise<T> {
  const next = ocrMutex.then(task, task);
  ocrMutex = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

export function hasValidImageMagicBytes(buf: Buffer): boolean {
  if (!buf || buf.length < 12) return false;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // GIF: 47 49 46
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  // BMP: 42 4D
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true;
  // TIFF: II* / MM*
  if (
    (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
    (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)
  ) {
    return true;
  }
  // WEBP: RIFF....WEBP
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return true;
  }
  return false;
}

function hasCachedTrainedData(): boolean {
  try {
    return (
      fs.existsSync(path.join(TESSDATA_DIR, 'eng.traineddata')) ||
      fs.existsSync(path.join(TESSDATA_DIR, 'eng.traineddata.gz'))
    );
  } catch {
    return false;
  }
}

async function getOrCreateTesseractWorker(): Promise<any> {
  if (!tesseractWorkerPromise) {
    tesseractWorkerPromise = (async () => {
      const modName = 'tesseract.js';
      const tesseract: any = await import(modName);
      const createWorker = tesseract.createWorker || tesseract.default?.createWorker;
      if (typeof createWorker !== 'function') {
        throw new Error('tesseract.js createWorker export not found');
      }
      return createWorker('eng', 1, {
        cachePath: TESSDATA_DIR,
        logger: () => {}
      });
    })().catch(err => {
      tesseractWorkerPromise = null;
      throw err;
    });
  }
  return tesseractWorkerPromise;
}

async function defaultRecognizeImage(buf: Buffer): Promise<string> {
  if (!hasValidImageMagicBytes(buf)) return '';
  // QA-3: never trigger an unmocked traineddata download from the internet during Vitest runs
  if (process.env.VITEST && !hasCachedTrainedData()) return '';

  return withOcrMutex(async () => {
    const worker = await getOrCreateTesseractWorker();
    const res = await worker.recognize(buf);
    return String(res?.data?.text || '').trim();
  });
}

async function defaultRasterizePdf(buf: Buffer, maxPages: number = LOCAL_OCR_DEFAULT_MAX_PAGES): Promise<Buffer[]> {
  if (process.env.VITEST && !hasCachedTrainedData()) return [];

  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const canvasModName = '@napi-rs/canvas';
  const canvasLib: any = await import(canvasModName);
  const resolvedCanvas =
    canvasLib.default && typeof canvasLib.default === 'object' ? { ...canvasLib.default, ...canvasLib } : canvasLib;
  const createCanvas = resolvedCanvas.createCanvas;
  if (typeof createCanvas !== 'function') {
    throw new Error('@napi-rs/canvas createCanvas export not found');
  }

  // Register DOM canvas constructors globally so pdfjs-dist uses native Path2D/ImageData/DOMMatrix
  // instead of plain JS polyfill objects (avoids CanvasFillRule errors on ctx.fill(Path2D)).
  const globalObj = globalThis as Record<string, unknown>;
  for (const key of ['Path2D', 'ImageData', 'DOMMatrix', 'DOMPoint', 'DOMRect', 'Image'] as const) {
    if (resolvedCanvas[key] && !globalObj[key]) {
      globalObj[key] = resolvedCanvas[key];
    }
  }
  const ImageCtor = resolvedCanvas.Image;

  // Guard 9-arg ctx.drawImage(CanvasElement, ...) calls in @napi-rs/canvas on Windows by
  // converting auxiliary CanvasElement sources to PNG-backed Image instances first.
  const wrapContextDrawImage = (rawCtx: any) => {
    if (!rawCtx || typeof rawCtx.drawImage !== 'function') return rawCtx;
    const origDrawImage = rawCtx.drawImage.bind(rawCtx);
    rawCtx.drawImage = (src: any, ...rest: any[]) => {
      if (src && typeof src.toBuffer === 'function' && typeof ImageCtor === 'function') {
        if (!src.width || !src.height) return;
        const img = new ImageCtor();
        img.src = src.toBuffer('image/png');
        return origDrawImage(img, ...rest);
      }
      return origDrawImage(src, ...rest);
    };
    return rawCtx;
  };

  const canvasFactory = {
    create(width: number, height: number) {
      const canvas = createCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
      const context = wrapContextDrawImage(canvas.getContext('2d'));
      return { canvas, context };
    },
    reset(pair: { canvas: any; context: any }, width: number, height: number) {
      pair.canvas.width = Math.max(1, Math.ceil(width));
      pair.canvas.height = Math.max(1, Math.ceil(height));
    },
    destroy(pair: { canvas: any; context: any }) {
      pair.canvas.width = 0;
      pair.canvas.height = 0;
    }
  };

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    isOffscreenCanvasSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    canvasFactory
  }).promise;

  const pngPages: Buffer[] = [];
  try {
    const limit = Math.min(doc.numPages, Math.max(1, maxPages));
    for (let p = 1; p <= limit; p++) {
      let target: { canvas: any; context: any } | null = null;
      try {
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale: 2.0 });
        target = canvasFactory.create(viewport.width, viewport.height);
        await page.render({ canvasContext: target.context, viewport, canvasFactory }).promise;
        pngPages.push(target.canvas.toBuffer('image/png'));
      } catch (pageErr: any) {
        console.warn(`[LocalOCR] Failed to rasterize PDF page ${p}:`, pageErr?.message || pageErr);
      } finally {
        if (target) canvasFactory.destroy(target);
      }
    }
  } finally {
    await doc.destroy().catch(() => {});
  }
  return pngPages;
}

export const localOcrDeps = {
  recognizeImage: defaultRecognizeImage,
  rasterizePdf: defaultRasterizePdf
};

/** Returns true unless explicitly disabled in app_settings (`local_ocr_enabled = 'false'`). */
export function isLocalOcrEnabled(): boolean {
  try {
    return getAppSetting('local_ocr_enabled') !== 'false';
  } catch {
    return true;
  }
}

/**
 * Offline OCR fallback using Tesseract.js for scanned images and rasterized PDF pages (capped at `maxPages`).
 * Returns null if disabled, unsupported, or no text could be recognized.
 */
export async function extractTextWithLocalOcr(
  buf: Buffer,
  mimeType: string = '',
  opts: { maxPages?: number } = {}
): Promise<LocalOcrResult | null> {
  if (!buf || buf.length === 0 || !isLocalOcrEnabled()) return null;

  const isPdfFile = mimeType === 'application/pdf' || buf.subarray(0, 5).toString('latin1') === '%PDF-';
  const isImageFile = mimeType.startsWith('image/');

  if (isPdfFile) {
    const maxPages = opts.maxPages ?? LOCAL_OCR_DEFAULT_MAX_PAGES;
    const pageBuffers = await localOcrDeps.rasterizePdf(buf, maxPages);
    if (!pageBuffers || pageBuffers.length === 0) return null;

    const chunks: string[] = [];
    for (const png of pageBuffers) {
      const pageText = await localOcrDeps.recognizeImage(png);
      if (pageText && pageText.trim()) {
        chunks.push(pageText.trim());
      }
    }
    const combined = chunks.join('\n\n').trim();
    return combined ? { text: combined, pagesOcred: pageBuffers.length, engine: 'tesseract.js' } : null;
  }

  if (isImageFile) {
    const text = (await localOcrDeps.recognizeImage(buf)).trim();
    return text ? { text, pagesOcred: 1, engine: 'tesseract.js' } : null;
  }

  return null;
}

/** Terminates the reusable Tesseract worker cleanly on server shutdown. */
export async function terminateLocalOcrWorker(): Promise<void> {
  const pending = tesseractWorkerPromise;
  tesseractWorkerPromise = null;
  if (!pending) return;
  try {
    const worker = await pending;
    if (worker && typeof worker.terminate === 'function') {
      await worker.terminate();
    }
  } catch {
    // Ignore errors during teardown
  }
}
