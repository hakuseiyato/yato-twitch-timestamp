'use strict';
// app.css のトークンがコントラスト基準を満たすかを計算で確かめる / Checks app.css tokens against the contrast floor
const assert = require('assert');
const fs = require('fs');
const css = fs.readFileSync(require('path').resolve(__dirname, '../service/web/css/app.css'), 'utf8');
function block(re) { const m = css.match(re); assert.ok(m, 'block not found: ' + re); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[k] = v; return out; }
const dark = block(/:root\s*\{([\s\S]*?)\n\}/);
const light = block(/prefers-color-scheme:\s*light\)\s*\{\s*:root\s*\{([\s\S]*?)\}/);
function lum(hex) { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
function ratio(a, b) { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }
const TEXT = ['ink', 'ink-2', 'ink-3', 'accent', 'ok', 'warn', 'err', 'cand'];
const LINES = ['bar-top', 'cand', 'warn', 'accent-fill', 'rule'];
for (const [name, t] of [['dark', dark], ['light', light]]) {
  for (const k of ['paper', 'paper-2', 'paper-3', 'ink', 'ink-2', 'ink-3', 'accent', 'accent-fill', 'on-accent', 'ok', 'warn', 'err', 'cand', 'bar-top', 'bar-bot', 'bar-hover', 'focus', 'rule']) assert.ok(t[k], name + ' is missing --' + k);
  for (const bg of ['paper', 'paper-2', 'paper-3']) {
    for (const fg of TEXT) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name}: --${fg} on --${bg} = ${ratio(t[fg], t[bg]).toFixed(2)} < 4.5`);
    for (const ln of LINES) if (ln !== 'rule') assert.ok(ratio(t[ln], t[bg]) >= 3, `${name}: --${ln} on --${bg} = ${ratio(t[ln], t[bg]).toFixed(2)} < 3`);
  }
  assert.ok(ratio(t['on-accent'], t['accent-fill']) >= 4.5, name + ': --on-accent on --accent-fill');
  assert.ok(ratio(t['focus'], t['paper']) >= 3, name + ': --focus on --paper');
}
console.log('all tests passed');
