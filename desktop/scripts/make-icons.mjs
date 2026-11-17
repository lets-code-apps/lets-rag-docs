// Renders the app's PNG icons from SVG with Electron's own Chromium (no image library):
//   assets/menubarTemplate.png, @2x  the menu-bar template: black on transparent, 18 and 36 px.
//                                    Drawn like Triage Mail's menubar.svg (the same 1.75px walls
//                                    and knock-out), with the RAG emblem's two text lines.
//   assets/icon.png                  1024 px app icon: a grain tile (radius 23%) with the white
//                                    emblem (renderer/emblem.svg) at 64% of the tile.
// Run from desktop/:  npx electron scripts/make-icons.mjs

import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DESKTOP = join(import.meta.dirname, '..');
const ASSETS = join(DESKTOP, 'assets');

const WALLS = 'M3,0 L18,0 L18,1.75 L4.75,1.75 L4.75,12 L3,12 Z M18,3 L18,18 L16.25,18 L16.25,4.75 L6,4.75 L6,3 Z M15,18 L0,18 L0,16.25 L13.25,16.25 L13.25,6 L15,6 Z M0,15 L0,0 L1.75,0 L1.75,13.25 L12,13.25 L12,15 Z';
const LINES = 'M3.4,6.75 H14.6 M3.4,10.35 H10.6';
export const MENUBAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18">
<defs><clipPath id="c"><rect width="18" height="18" rx="3.6"/></clipPath><mask id="m"><path fill="#fff" d="${WALLS}"/><path d="${LINES}" fill="none" stroke="#000" stroke-width="4.1" stroke-linecap="round"/></mask></defs>
<rect width="18" height="18" fill="#000" mask="url(#m)" clip-path="url(#c)"/><path d="${LINES}" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;

const EMBLEM_WHITE = readFileSync(join(DESKTOP, 'renderer', 'emblem.svg'), 'utf8').replaceAll('#000000', '#FFFFFF');

/** Runs in the page: draws SVG (and for the app icon the grain tile) on a canvas, returns PNG bytes as base64. */
const PAINT = String.raw`
async function svgImage(svg) {
  const img = new Image();
  img.src = 'data:image/svg+xml;base64,' + btoa(svg);
  await img.decode();
  return img;
}
async function paint(kind, size, svg) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (kind === 'menubar') {
    g.drawImage(await svgImage(svg), 0, 0, size, size);
  } else {
    const tile = Math.round(size * 0.8);
    const at = (size - tile) / 2;
    const r = tile * 0.23;
    g.save();
    g.beginPath();
    g.roundRect(at, at, tile, tile, r);
    g.clip();
    // Grain tile: soft blobs of the app's colours, then fine noise.
    g.fillStyle = '#9AA6C4';
    g.fillRect(at, at, tile, tile);
    const blobs = [
      [0.18, 0.22, 0.55, '#2B4FB8'], [0.82, 0.30, 0.45, '#5B7FE0'], [0.30, 0.85, 0.50, '#18234A'],
      [0.78, 0.80, 0.42, '#3A62CF'], [0.55, 0.50, 0.30, '#B7BFD6'], [0.10, 0.60, 0.30, '#22346F'],
    ];
    for (const [x, y, rad, color] of blobs) {
      const cx = at + x * tile, cy = at + y * tile, rr = rad * tile;
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, rr);
      grad.addColorStop(0, color);
      grad.addColorStop(1, color + '00');
      g.fillStyle = grad;
      g.fillRect(at, at, tile, tile);
    }
    const data = g.getImageData(0, 0, size, size);
    let seed = 7;
    for (let i = 0; i < data.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = ((seed >> 16) % 48) - 24;
      data.data[i] += n; data.data[i + 1] += n; data.data[i + 2] += n;
    }
    g.putImageData(data, 0, 0);
    g.restore();
    const e = tile * 0.64;
    g.drawImage(await svgImage(svg), (size - e) / 2, (size - e) / 2, e, e);
  }
  return canvas.toDataURL('image/png').split(',')[1];
}
`;

async function render(win, kind, size, svg) {
  const b64 = await win.webContents.executeJavaScript(`(async () => { ${PAINT}; return paint(${JSON.stringify(kind)}, ${size}, ${JSON.stringify(svg)}); })()`);
  return Buffer.from(b64, 'base64');
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('about:blank');
  writeFileSync(join(ASSETS, 'menubarTemplate.png'), await render(win, 'menubar', 18, MENUBAR_SVG));
  writeFileSync(join(ASSETS, 'menubarTemplate@2x.png'), await render(win, 'menubar', 36, MENUBAR_SVG));
  writeFileSync(join(ASSETS, 'icon.png'), await render(win, 'icon', 1024, EMBLEM_WHITE));
  console.log('icons written to assets/');
  app.exit(0);
});
