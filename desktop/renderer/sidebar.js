// The shared sidebar (design Sidebar.dc.html): one copy of the rows for every window, so no screen
// keeps its own navigation markup. build() creates the four rows once from model.sidebarItems —
// order overview, ask, filing, settings, `graph` absent until LET-139 lands — with createElement
// and textContent only. paint() just moves the current row and the overview count pill.

import * as m from './model.js';

const SVG = 'http://www.w3.org/2000/svg';

export const ORDER = ['overview', 'ask', 'filing', 'settings'];

function icon(name, px) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('width', String(px));
  svg.setAttribute('height', String(px));
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Fill the empty <nav id="sidebar"> from index.html. Real <button>s so keyboard users get the
 * design's rows; app.js wires the clicks by data-section. */
export function build(nav) {
  for (const row of m.sidebarItems(null, 0)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.section = row.section;
    button.append(icon(row.glyph, 18));
    const label = document.createElement('span');
    label.textContent = row.title;
    button.append(label);
    if (row.section === 'overview') {
      // The count the design puts beside overview; aria-hidden so the label below is not read twice.
      const count = document.createElement('span');
      count.className = 'count';
      count.setAttribute('aria-hidden', 'true');
      button.append(count);
    }
    nav.append(button);
  }
}

/** Paint the current row and the overview count from model.sidebarItems: the label is the title
 * normally, "overview, 5 need you" while items are pending. The number itself is styling only. */
export function paint(nav, section, count) {
  for (const row of m.sidebarItems(section, count)) {
    const button = nav.querySelector(`[data-section="${row.section}"]`);
    if (!button) continue;
    if (row.current) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
    button.setAttribute('aria-label', row.aria);
    const pill = button.querySelector('.count');
    if (pill) pill.textContent = row.count;
  }
}
