"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.countPdfPages = countPdfPages;
exports.renderPdf = renderPdf;
exports.disposePdfWindow = disposePdfWindow;
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
const electron_1 = require("electron");
const log_1 = require("../log");
const errors_1 = require("../errors");
let printWindow = null;
let queue = Promise.resolve();
function windowFor() {
    if (printWindow && !printWindow.isDestroyed())
        return printWindow;
    printWindow = new electron_1.BrowserWindow({
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
function loadInto(win, html) {
    const encoded = Buffer.from(html, 'utf8').toString('base64');
    return new Promise((resolve, reject) => {
        const onFinish = () => {
            cleanup();
            resolve();
        };
        const onFail = (_event, code, description) => {
            cleanup();
            reject(new Error(`load failed (${String(code)}): ${description}`));
        };
        const cleanup = () => {
            win.webContents.off('did-finish-load', onFinish);
            win.webContents.off('did-fail-load', onFail);
        };
        win.webContents.once('did-finish-load', onFinish);
        win.webContents.once('did-fail-load', onFail);
        void win.loadURL(`data:text/html;base64,${encoded}`);
    });
}
/** Counts pages by scanning the page objects Chromium writes into the PDF. */
function countPdfPages(pdf) {
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
async function renderPdf(html) {
    const run = async () => {
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
        }
        catch (error) {
            // A broken window cannot be trusted for the next print.
            if (!win.isDestroyed())
                win.destroy();
            printWindow = null;
            (0, log_1.logError)('pdf.render', error);
            throw new errors_1.AppError('INTERNAL', 'The PDF could not be produced. Nothing was written — try again, and if it repeats check the log file.');
        }
    };
    const result = queue.then(run, run);
    queue = result.catch(() => undefined);
    return result;
}
/** Releases the hidden window. Called on quit so the process can exit. */
function disposePdfWindow() {
    if (printWindow && !printWindow.isDestroyed())
        printWindow.destroy();
    printWindow = null;
}
//# sourceMappingURL=render.js.map