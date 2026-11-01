/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Development-only: sample frames out of a screen recording.
 *
 * Chromium already ships an H.264 decoder, so Electron is the cheapest frame
 * extractor on a machine with no ffmpeg. Each frame is drawn to a canvas at the
 * requested timestamp and written as PNG.
 *
 *   npx electron scripts/video-frames.cjs --in clip.mp4 --out tmp/frames --every 2
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const INPUT = path.resolve(arg('in', ''));
const OUT = path.resolve(arg('out', 'tmp/frames'));
const EVERY = Number(arg('every', '2'));

fs.mkdirSync(OUT, { recursive: true });
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 720, show: false });
  /*
   * The player page is written to disk and loaded as `file://`, not as a `data:`
   * URL: a `data:` document is an opaque origin, and Chromium refuses to load a
   * `file://` video into it, so `loadedmetadata` never fires and the script hangs
   * with nothing to report.
   */
  const playerPath = path.join(OUT, 'player.html');
  const videoUrl = `file:///${INPUT.replace(/\\/g, '/').replace(/ /g, '%20')}`;
  fs.writeFileSync(
    playerPath,
    `<!doctype html><html><body style="margin:0;background:#000">
      <video id="v" src="${videoUrl}" muted preload="auto" style="width:1280px"></video>
    </body></html>`,
  );
  await win.loadURL(`file:///${playerPath.replace(/\\/g, '/')}`);

  const meta = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const v = document.getElementById('v');
    const timer = setTimeout(() => reject(new Error('metadata timeout: ' + v.readyState)), 20000);
    const done = () => { clearTimeout(timer); resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight }); };
    if (v.readyState >= 1) done(); else v.addEventListener('loadedmetadata', done, { once: true });
    v.load();
  })`);

  process.stdout.write(`duration ${meta.duration.toFixed(1)}s  ${meta.width}x${meta.height}\n`);

  let index = 0;
  for (let t = 0.4; t < meta.duration; t += EVERY) {
    const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const v = document.getElementById('v');
      const grab = () => {
        const canvas = document.createElement('canvas');
        canvas.width = v.videoWidth; canvas.height = v.videoHeight;
        canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      v.addEventListener('seeked', grab, { once: true });
      v.currentTime = ${t};
    })`);
    const file = path.join(OUT, `f${String(index).padStart(3, '0')}-${t.toFixed(1)}s.png`);
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    index += 1;
  }
  process.stdout.write(`${index} frames written to ${OUT}\n`);
  app.quit();
});
