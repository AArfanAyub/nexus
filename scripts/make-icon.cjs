/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Rasterises `build/icon.svg` into the icon set the installers need.
 *
 *   npx electron scripts/make-icon.cjs
 *
 * Chromium is the only SVG renderer we already ship, so it does the rendering and
 * we do the container format by hand: a multi-resolution `.ico` whose entries are
 * PNG-compressed (Vista+), plus the 512 PNG that Linux and the docs page use.
 * No image dependency is added to the runtime bundle for a build-time concern.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const SVG = fs.readFileSync(path.join(ROOT, 'build', 'icon.svg'), 'utf8');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** ICONDIR + one ICONDIRENTRY per image, then the PNG payloads. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette size
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: false },
  });

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    svg{display:block;width:512px;height:512px}
  </style></head><body>${SVG}</body></html>`;

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 500));

  const full = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), full.toPNG());

  const images = SIZES.map((size) => ({
    size,
    png: full.resize({ width: size, height: size, quality: 'best' }).toPNG(),
  }));

  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico(images));
  fs.writeFileSync(
    path.join(ROOT, 'build', 'icon-256.png'),
    images.find((image) => image.size === 256).png,
  );

  process.stdout.write(`icon.ico (${SIZES.join(', ')}) + icon.png 512x512 written\n`);
  app.quit();
});
