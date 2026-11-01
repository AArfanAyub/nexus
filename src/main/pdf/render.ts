/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * HTML → PDF via one reused, hidden `BrowserWindow` (ARCHITECTURE §I.5).
 *
 * The window is created once and kept for the process lifetime: creating one per
 * print costs ~300 ms and leaks a renderer if the print fails. It is created with
 * `sandbox: true` and `javascript: false`, so the document being printed cannot
 * execute anything, and it loads a `data:` URL, so nothing is written to disk
 * before the operator chooses a path.
 *
 * Failure handling is the important part: **every** path destroys or releases the
 * window, and the caller gets `INTERNAL` with a sentence a user can act on —
 * never a stack trace (BR-16).
 */

import { BrowserWindow } from 'electron';

import { logError } from '../log';
import { AppError } from '../errors';

let printWindow: BrowserWindow | null = null;
let queue: Promise<unknown> = Promise.resolve();

function windowFor(): BrowserWindow {
  if (printWindow && !printWindow.isDestroyed()) return printWindow;
  printWindow = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      sandbox: true,
      javascript: false,
      nodeIntegration: false,
      contextIsolation: true,
      offscreen: false,
      spellcheck: false,
    },
  });
  // A print window must never appear in the window list or steal focus.
  printWindow.setMenuBarVisibility(false);
  return printWindow;
}

function loadInto(win: BrowserWindow, html: string): Promise<void> {
  const encoded = Buffer.from(html, 'utf8').toString('base64');
  return new Promise<void>((resolve, reject) => {
    const onFinish = (): void => {
      cleanup();
      resolve();
    };
    const onFail = (_event: unknown, code: number, description: string): void => {
      cleanup();
      reject(new Error(`load failed (${String(code)}): ${description}`));
    };
    const cleanup = (): void => {
      win.webContents.off('did-finish-load', onFinish);
      win.webContents.off('did-fail-load', onFail);
    };
    win.webContents.once('did-finish-load', onFinish);
    win.webContents.once('did-fail-load', onFail);
    void win.loadURL(`data:text/html;base64,${encoded}`);
  });
}

/** Counts pages by scanning the page objects Chromium writes into the PDF. */
export function countPdfPages(pdf: Buffer): number {
  const text = pdf.toString('latin1');
  const matches = text.match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : 1;
}

/**
 * Renders HTML to a PDF buffer.
 *
 * Serialised through a promise chain: two prints at once would fight over the
 * single window, and Chromium's `printToPDF` is not re-entrant.
 */
export async function renderPdf(html: string): Promise<{ readonly pdf: Buffer; readonly pages: number }> {
  const run = async (): Promise<{ pdf: Buffer; pages: number }> => {
    const win = windowFor();
    try {
      await loadInto(win, html);
      // One paint frame plus a hair: fonts and layout must settle before the
      // capture, or the first page renders with fallback metrics.
      await new Promise((resolve) => setTimeout(resolve, 60));
      const pdf = await win.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: true,
        margins: { marginType: 'none' },
        preferCSSPageSize: true,
      });
      return { pdf, pages: countPdfPages(pdf) };
    } catch (error) {
      // A broken window cannot be trusted for the next print.
      if (!win.isDestroyed()) win.destroy();
      printWindow = null;
      logError('pdf.render', error);
      throw new AppError(
        'INTERNAL',
        'The PDF could not be produced. Nothing was written — try again, and if it repeats check the log file.',
      );
    }
  };

  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

/** Releases the hidden window. Called on quit so the process can exit. */
export function disposePdfWindow(): void {
  if (printWindow && !printWindow.isDestroyed()) printWindow.destroy();
  printWindow = null;
}
