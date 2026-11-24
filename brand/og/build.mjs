// Writes the three social cards (1200x630) as SVG and renders each to PNG with rsvg-convert:
//
//   node brand/og/build.mjs
//
// landing.png -> the landing page, docs.png -> the docs, playground.png -> the playground.
// The PNGs are what og:image points at (platforms don't read SVG), so commit both after a change.
// The type is Inter and DejaVu Sans Mono (any installed sans and mono will do); the colours are the
// site's dark theme (see brand/README.md).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const c = { bg: '#14161F', card: '#0d0f15', line: '#2c3040', ink: '#F2F3F8', muted: '#9aa0b4', accent: '#8b95ff', code: '#b8bdd0', tag: '#ff8fb3', attr: '#f5b97a', str: '#7ee0a6', kw: '#aab2ff', fn: '#7cc4ff' };
const sans = "Inter, 'Helvetica Neue', Arial, sans-serif";
const mono = "'DejaVu Sans Mono', ui-monospace, Menlo, monospace";
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Code lines are arrays of [colour, text] runs; monospace runs are placed with xml:space so spaces survive.
const codeLines = (lines, x, y, size, step) =>
  lines.map((runs, i) => `<text x="${x}" y="${y + i * step}" font-family="${mono}" font-size="${size}" xml:space="preserve">${runs.map(([fill, t]) => `<tspan fill="${fill}">${esc(t)}</tspan>`).join('')}</text>`).join('\n  ');

const source = [
  [[c.kw, 'let'], [c.code, ' status = '], [c.str, "'idle'"]],
  [],
  [[c.code, '<'], [c.tag, 'copy-button'], [c.attr, ' text label'], [c.code, '='], [c.str, '"Copy"'], [c.code, '>']],
  [[c.code, '  <'], [c.tag, 'button'], [c.attr, ' onclick'], [c.code, '={'], [c.fn, 'copy'], [c.code, '}>']],
  [[c.code, '    {'], [c.fn, 'label'], [c.code, '}']],
  [[c.code, '  </'], [c.tag, 'button'], [c.code, '>']],
  [[c.code, '</'], [c.tag, 'copy-button'], [c.code, '>']],
];

function frame({ kicker, title, sub, url, card }) {
  const lines = title.map((t, i) => `<text x="72" y="${246 + i * 66}" font-family="${sans}" font-size="56" font-weight="800" fill="${c.ink}" letter-spacing="-1">${esc(t)}</text>`).join('\n  ');
  const subY = 246 + (title.length - 1) * 66 + 62;
  const subLines = sub.map((t, i) => `<text x="72" y="${subY + i * 40}" font-family="${sans}" font-size="28" fill="${c.muted}">${esc(t)}</text>`).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${esc(title.join(' '))}">
  <title>${esc(title.join(' '))}</title>
  <defs>
    <pattern id="stripes" width="26" height="26" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="13" height="26" fill="#232738"/><rect x="13" width="13" height="26" fill="${c.accent}"/></pattern>
    <radialGradient id="glow" cx="0.85" cy="0.1" r="0.8"><stop offset="0" stop-color="#4f5df5" stop-opacity="0.28"/><stop offset="1" stop-color="#4f5df5" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1200" height="630" fill="${c.bg}"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <g transform="translate(66 52) scale(0.6)"><path fill="${c.ink}" d="M10 15 a5 5 0 0 1 5 -5 H81 a5 5 0 0 1 5 5 V27 H10 Z"/><path fill="${c.ink}" d="M10 69 H86 V81 a5 5 0 0 1 -5 5 H15 a5 5 0 0 1 -5 -5 Z"/><path fill="${c.accent}" d="M54 27 H86 L42 69 H10 Z"/></g>
  <text x="136" y="95" font-family="${sans}" font-size="38" font-weight="700" fill="${c.ink}">zubra</text>
  <text x="72" y="168" font-family="${sans}" font-size="22" font-weight="600" letter-spacing="3" fill="${c.accent}">${esc(kicker.toUpperCase())}</text>
  ${lines}
  ${subLines}
  <text x="72" y="568" font-family="${mono}" font-size="22" fill="${c.muted}">${esc(url)}</text>
  ${card}
  <rect y="604" width="1200" height="26" fill="url(#stripes)"/>
</svg>
`;
}

const window = (x, y, w, h, label, body) => `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${c.card}" stroke="${c.line}" stroke-width="2"/>
    <circle cx="${x + 28}" cy="${y + 28}" r="6" fill="${c.line}"/><circle cx="${x + 48}" cy="${y + 28}" r="6" fill="${c.line}"/><circle cx="${x + 68}" cy="${y + 28}" r="6" fill="${c.line}"/>
    <text x="${x + w - 28}" y="${y + 34}" text-anchor="end" font-family="${mono}" font-size="16" fill="${c.muted}">${esc(label)}</text>
    ${body}
  </g>`;

const cards = {
  landing: frame({
    kicker: 'A compiler for web components',
    title: ['Write components', 'like HTML. Ship them', 'as the platform’s own.'],
    sub: [],
    url: 'zubra-js.github.io/zubra',
    card: window(740, 150, 396, 340, 'copy-button.zb', codeLines(source, 772, 232, 17, 32)),
  }),
  docs: frame({
    kicker: 'Documentation',
    title: ['Zubra docs'],
    sub: ['The guide, topics and reference for', 'HTML-first web components.'],
    url: 'zubra-js.github.io/zubra/docs',
    card: `<g>
    <rect x="740" y="150" width="396" height="340" rx="16" fill="${c.card}" stroke="${c.line}" stroke-width="2"/>
    ${['Guide', 'Beyond the browser', 'Coming from a framework', 'Topics', 'Reference'].map((t, i) => `<rect x="768" y="${178 + i * 60}" width="340" height="46" rx="10" fill="${i === 0 ? '#232738' : 'none'}"/><rect x="784" y="${194 + i * 60}" width="14" height="14" rx="4" fill="${i === 0 ? c.accent : c.line}"/><text x="814" y="${208 + i * 60}" font-family="${sans}" font-size="22" font-weight="${i === 0 ? 700 : 500}" fill="${i === 0 ? c.ink : c.muted}">${esc(t)}</text>`).join('\n    ')}
  </g>`,
  }),
  playground: frame({
    kicker: 'Playground',
    title: ['Try Zubra in', 'your browser.'],
    sub: ['Edit a .zb file, see the element it', 'compiles to. Nothing to install.'],
    url: 'zubra-js.github.io/zubra/playground',
    card: `<g>
    <rect x="640" y="150" width="496" height="340" rx="16" fill="${c.card}" stroke="${c.line}" stroke-width="2"/>
    <line x1="940" y1="150" x2="940" y2="490" stroke="${c.line}" stroke-width="2"/>
    <text x="664" y="186" font-family="${mono}" font-size="15" fill="${c.muted}">component.zb</text>
    ${codeLines(source.slice(2, 7), 664, 232, 13, 28)}
    <text x="964" y="186" font-family="${mono}" font-size="15" fill="${c.muted}">preview</text>
    <rect x="964" y="226" width="148" height="64" rx="12" fill="#4f5df5"/>
    <text x="1038" y="267" text-anchor="middle" font-family="${sans}" font-size="26" font-weight="600" fill="#ffffff">Copy</text>
    <text x="964" y="334" font-family="${mono}" font-size="14" fill="${c.muted}">&lt;copy-button&gt;</text>
    <text x="964" y="360" font-family="${mono}" font-size="14" fill="${c.muted}">a standard element</text>
  </g>`,
  }),
};

for (const [name, svg] of Object.entries(cards)) {
  writeFileSync(join(here, `${name}.svg`), svg);
  execFileSync('rsvg-convert', ['-w', '1200', '-h', '630', '-o', join(here, `${name}.png`), join(here, `${name}.svg`)]);
}
console.log('wrote', Object.keys(cards).map((n) => `brand/og/${n}.png`).join(', '));
