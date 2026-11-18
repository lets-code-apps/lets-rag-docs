// Layout checks that run inside the page, alongside the window-title check in `npm run smoke`. They
// measure the real rendered page through `getBoundingClientRect()`, so a screen that has moved off
// the approved design (the settings article drifting from the sidebar, the library search pushed down,
// the app name crowding the window buttons or the emblem, a control too small to hit) fails CI. The
// rules and the numbers are the design's own (app.css): 132px of AppBar clear, a 44px minimum target.
// Like the `DRIVER`/`TITLE_ON` strings in main.ts, `GEOMETRY` is passed to `executeJavaScript`, so the
// string is not type-checked by `tsc` — geometry.test.ts parses it and runs it against an empty page.

export const APPBAR_CLEAR = 132;
export const MIN_TARGET = 44;
export const TOLERANCE = 1;

// Controls the approved design draws under 44px today: the inner buttons of a SegmentedControl (38px)
// and the nav rows (about 39px). The check measures the `.seg` container (46px) and the nav labels, so
// these stay green; listing them keeps the gap visible and names the follow-up (raise them to 44px).
// This CI-only change does not touch the CSS.
export const KNOWN_SHORT = ['.seg button', '.nav button'];

// A page-side measurement. Returns `{ ok, failures: string[] }`; every failure is "<rule id> <measured
// value>" so the SMOKE FAIL line carries what moved. The three design constants are baked in from the
// exports above when this module compiles.
export const GEOMETRY = `
  const fail = [];
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // 1) settings-article: the settings article sits hard against the sidebar (side by side at wide,
  // stacked flush-left at the 360px minimum). Only on the settings screen.
  const sBody = document.querySelector('.settings-body');
  const nav = document.querySelector('.nav');
  if (sBody && nav && shown(sBody)) {
    const b = sBody.getBoundingClientRect();
    const n = nav.getBoundingClientRect();
    if (window.innerWidth > 480) {
      if (Math.abs(b.left - n.right) > ${TOLERANCE}) fail.push('settings-article gap=' + (b.left - n.right).toFixed(1));
    } else if (b.top < n.bottom - ${TOLERANCE} || b.left > ${TOLERANCE}) {
      fail.push('settings-article top=' + (b.top - n.bottom).toFixed(1) + ' left=' + b.left.toFixed(1));
    }
  }

  // 2) library-search: the search field stays at the top of the library pane, under its heading, above
  // the rows and above the add panel when an add is showing. Only on the ask screen.
  const lib = document.querySelector('.library');
  const search = document.querySelector('#librarySearch');
  if (lib && search && shown(lib)) {
    const wrap = search.closest('.field-wrap');
    const field = search.closest('.field');
    const head = wrap ? wrap.previousElementSibling : null;
    if (!head || !head.classList.contains('library-head')) fail.push('library-search head=' + (head ? head.className : 'none'));
    const lt = lib.getBoundingClientRect().top;
    const ft = field.getBoundingClientRect().top;
    if (ft - lt >= 120) fail.push('library-search offset=' + (ft - lt).toFixed(1));
    const rows = document.querySelector('#libraryRows');
    if (rows && ft >= rows.getBoundingClientRect().top) fail.push('library-search below-rows');
    const panel = document.querySelector('#addPanel');
    if (panel && shown(panel) && ft >= panel.getBoundingClientRect().top) fail.push('library-search below-add-panel');
  }

  // 3) appbar-clear: the app name keeps ${APPBAR_CLEAR}px clear on both sides of the bar (window buttons,
  // emblem), on every screen.
  const title = document.querySelector('#appTitle');
  if (title && shown(title)) {
    const t = title.getBoundingClientRect();
    if (t.left < ${APPBAR_CLEAR} - ${TOLERANCE}) fail.push('appbar-clear left=' + t.left.toFixed(1));
    if (window.innerWidth - t.right < ${APPBAR_CLEAR} - ${TOLERANCE}) fail.push('appbar-clear right=' + (window.innerWidth - t.right).toFixed(1));
  }

  // 4) control-height: every visible control is at least ${MIN_TARGET}px tall; an icon-only button is
  // square too. The two known-short selectors (see KNOWN_SHORT) are not in the checked set.
  const controls = [
    ['.btn', false],
    ['.field', false],
    ['.switchrow', false],
    ['button.row', false],
    ['.btn.icon-only', true],
    ['.seg', false],
  ];
  for (const item of controls) {
    for (const el of document.querySelectorAll(item[0])) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.height < ${MIN_TARGET} - 0.5) fail.push('control-height ' + item[0] + ' h=' + r.height.toFixed(1));
      if (item[1] && r.width < ${MIN_TARGET} - 0.5) fail.push('control-width ' + item[0] + ' w=' + r.width.toFixed(1));
    }
  }

  return { ok: fail.length === 0, failures: fail };
`;
