// The screenshot-baseline comparator for desktop CI. It has no image library and no third-party
// service (pixelmatch/pngjs are not in package-lock.json and boundaries.test.ts bans extra deps): the
// pixel maths is plain BGRA arrays here, and compare-shots.mjs decodes PNGs with Electron's nativeImage
// and feeds them to diffBitmaps. A shot is "changed" on a size mismatch, when its pair is missing, or
// when more than MAX_RATIO of its pixels differ by more than PIXEL_DELTA on any channel — enough to
// catch an 8px shift of an article or a moved line of text, far above sub-pixel antialiasing noise.

export const PIXEL_DELTA = 12; // per-channel difference allowed before a pixel counts, of 255
export const MAX_RATIO = 0.002; // a shot is changed above 0.2% of pixels (~7,800 of a 2400x1640 Retina shot)

// Shot names are constrained to this in renderMarkdown, so no path or markup can reach the PR comment.
const SAFE_NAME = /^[a-z0-9-]+\.png$/;

/** Two BGRA bitmaps (nativeImage.toBitmap layout) of the same w×h → how much they differ. */
export function diffBitmaps(a, b, w, h, options) {
  const pixelDelta = options?.pixelDelta ?? PIXEL_DELTA;
  const total = w * h;
  let differing = 0;
  for (let i = 0; i < total * 4; i += 4) {
    if (
      Math.abs(a[i] - b[i]) > pixelDelta
      || Math.abs(a[i + 1] - b[i + 1]) > pixelDelta
      || Math.abs(a[i + 2] - b[i + 2]) > pixelDelta
    ) {
      differing += 1;
    }
  }
  const ratio = total === 0 ? 0 : differing / total;
  return { differing, ratio, changed: ratio > MAX_RATIO };
}

/**
 * Merge the two file sets with the measured per-shot diffs into the rows a report needs. `measured[name]`
 * carries `{ ratio, reason?, size? }` for names present in both; `new` and `removed` come from the sets.
 * Every row is a shot the reviewer should look at (a changed render, an uncommitted new shot, a lost one).
 */
export function compareSets(baselineNames, actualNames, measured, maxRatio = MAX_RATIO) {
  const rows = [];
  for (const name of actualNames) {
    if (!baselineNames.includes(name)) {
      rows.push({ name, status: 'new' });
      continue;
    }
    const m = measured[name] ?? { ratio: 0 };
    const changed = m.reason !== undefined || m.ratio > maxRatio;
    if (changed) {
      rows.push({ name, status: 'changed', ratio: m.ratio, reason: m.reason, size: m.size });
    }
  }
  for (const name of baselineNames) {
    if (!actualNames.includes(name)) rows.push({ name, status: 'removed' });
  }
  return rows;
}

/** The body of the PR comment (and the step summary): a hidden marker, then a table or an "all match" line. */
export function renderMarkdown(results, runUrl, total) {
  const safe = results.filter((row) => SAFE_NAME.test(row.name));
  if (safe.length === 0) {
    return `<!-- desktop-shots -->\n\nAll ${total} screenshots match the committed baseline.\n`;
  }
  const lines = [
    '<!-- desktop-shots -->',
    '',
    `**${safe.length} of ${total} screenshots changed.** Diff images are in the run artifact:`,
    runUrl || '(local run)',
    '',
    '| shot | status | ratio | size |',
    '|---|---|---|---|',
  ];
  for (const row of safe) {
    lines.push(`| ${row.name} | ${row.status} | ${(row.ratio ?? 0).toFixed(4)} | ${row.size ?? ''} |`);
  }
  return lines.join('\n') + '\n';
}
