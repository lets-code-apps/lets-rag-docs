// The Electron wrapper around shot-diff.mjs for desktop CI: it decodes the committed baseline and the
// freshly taken shots with Electron's own nativeImage (no image library), runs the pixel diff, writes a
// markdown/JSON report plus a red-on-transparent diff PNG per changed shot, and exits non-zero if anything
// changed so the CI job goes red. Run from desktop/:
//   electron scripts/compare-shots.mjs <baselineDir> <actualDir> [outDir]
// It needs an Electron main process (ELECTRON_RUN_AS_NODE has no nativeImage), like scripts/make-icons.mjs.
// Default outDir is out/shot-diff (desktop/out/ is gitignored), and it never touches the baseline in place.

import { app, nativeImage } from 'electron';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffBitmaps, compareSets, renderMarkdown, MAX_RATIO } from './shot-diff.mjs';

const [baselineDir, actualDir, outDir = join(import.meta.dirname, '..', 'out', 'shot-diff')] = process.argv.slice(2);
// The run URL for the artifact link, and nothing personal: only synthetic shots ever reach here (CI
// hard-sets the fake engine). Left empty for a local run.
const runUrl = process.env.DESKTOP_CI_URL ?? '';

const pngNames = (dir) => readdirSync(dir).filter((name) => name.endsWith('.png')).sort();

app.whenReady().then(async () => {
  let code = 0;
  try {
    mkdirSync(join(outDir, 'diff'), { recursive: true });
    const baselineNames = pngNames(baselineDir);
    const actualNames = pngNames(actualDir);
    const measured = {};

    for (const name of actualNames) {
      if (!baselineNames.includes(name)) continue; // a new shot is reported by compareSets
      const base = nativeImage.createFromPath(join(baselineDir, name));
      const shot = nativeImage.createFromPath(join(actualDir, name));
      const bs = base.getSize();
      const as = shot.getSize();
      if (bs.width !== as.width || bs.height !== as.height) {
        const size = `${bs.width}x${bs.height} vs ${as.width}x${as.height}`;
        measured[name] = { ratio: 1, reason: 'size changed', size };
        continue;
      }
      const { width, height } = bs;
      const a = base.toBitmap();
      const b = shot.toBitmap();
      const diff = diffBitmaps(a, b, width, height);
      measured[name] = { ratio: diff.ratio };
      if (diff.ratio > MAX_RATIO) {
        code = 1;
        // Paint the differing pixels red (nativeImage bitmaps are BGRA) so the change is obvious in the diff.
        const marks = Buffer.from(a);
        for (let i = 0; i < marks.length; i += 4) {
          if (
            Math.abs(a[i] - b[i]) > 12
            || Math.abs(a[i + 1] - b[i + 1]) > 12
            || Math.abs(a[i + 2] - b[i + 2]) > 12
          ) {
            marks[i] = 0;
            marks[i + 1] = 0;
            marks[i + 2] = 255;
          }
        }
        writeFileSync(join(outDir, 'diff', name), nativeImage.createFromBitmap(marks, { width, height }).toPNG());
      }
    }

    const results = compareSets(baselineNames, actualNames, measured);
    if (results.length > 0) code = 1;
    const report = renderMarkdown(results, runUrl, actualNames.length);
    writeFileSync(join(outDir, 'compare-report.md'), report);
    writeFileSync(join(outDir, 'compare-report.json'), JSON.stringify(results, null, 2) + '\n');
    // Every shot's measured ratio, green or not: this is what CI threshold calibration needs, because compare-report
    // only lists problems and a green run would otherwise record no numbers at all.
    writeFileSync(join(outDir, 'compare-measured.json'), JSON.stringify(measured, null, 2) + '\n');
    // The report is also printed so a green run shows "all match" in the CI log.
    console.error(report);
    app.exit(code);
  } catch (error) {
    console.error(`compare-shots: ${String(error)}`);
    app.exit(2);
  }
});
