/* Paintbox raster engine: aliased, pixel-exact drawing that only ever calls fillRect on a 2D context,
   plus the 16×16 tool icons drawn with it. No DOM access, so tests can load it on its own. */
'use strict';

/* ---------- brushes, lines, polygons ---------- */
const P1 = [[0, 0, 1]];
function spansSquare(s) { const o = -Math.floor((s - 1) / 2), a = []; for (let i = 0; i < s; i++) a.push([o, o + i, s]); return a; }
function spansCircle(d) {
  if (d <= 2) return spansSquare(d);
  const c = (d - 1) / 2, rr = (d / 2 - 0.25) ** 2, o = -Math.floor(c), a = [];
  for (let j = 0; j < d; j++) {
    let x0 = -1, x1 = -1;
    for (let i = 0; i < d; i++) if ((i - c) ** 2 + (j - c) ** 2 <= rr) { if (x0 < 0) x0 = i; x1 = i; }
    if (x0 >= 0) a.push([o + x0, o + j, x1 - x0 + 1]);
  }
  return a;
}
function spansSlash(s, back) { const o = -Math.floor((s - 1) / 2), a = []; for (let i = 0; i < s; i++) a.push([o + i, o + (back ? i : s - 1 - i), 1]); return a; }
function stamp(c, sp, x, y) { for (let i = 0; i < sp.length; i++) { const s = sp[i]; c.fillRect(x + s[0], y + s[1], s[2], 1); } }
function walk(x0, y0, x1, y1, cb) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let e = dx + dy;
  for (;;) {
    cb(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * e;
    if (e2 >= dy) { e += dy; x0 += sx; }
    if (e2 <= dx) { e += dx; y0 += sy; }
  }
}
function line(c, sp, x0, y0, x1, y1) { walk(x0, y0, x1, y1, (x, y) => stamp(c, sp, x, y)); }
function polyline(c, pts, sp, closed) {
  const n = pts.length;
  if (n === 1) { stamp(c, sp, Math.round(pts[0][0]), Math.round(pts[0][1])); return; }
  for (let i = 0; i < n - 1; i++) line(c, sp, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
  if (closed && n > 2) line(c, sp, pts[n - 1][0], pts[n - 1][1], pts[0][0], pts[0][1]);
}
function fillPoly(c, pts) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  const n = pts.length;
  for (let y = Math.ceil(minY); y <= Math.floor(maxY); y++) {
    const yc = y + 0.001, xs = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if ((a[1] <= yc) !== (b[1] <= yc)) xs.push(a[0] + (yc - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.ceil(xs[k]), xb = Math.floor(xs[k + 1]);
      if (xb >= xa) c.fillRect(xa, y, xb - xa + 1, 1);
    }
  }
}
function rectPts(x0, y0, x1, y1) { return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }
function bezier(p0, c1, c2, p3) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const n = Math.max(2, Math.ceil((d(p0, c1) + d(c1, c2) + d(c2, p3)) / 1.5)), a = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    a.push([u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0],
            u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1]]);
  }
  return a;
}
function dashed(c, pts, closed) {
  let k = 0; const n = pts.length;
  const seg = (a, b) => walk(a[0], a[1], b[0], b[1], (x, y) => { if (((k++) >> 1) % 2 === 0) c.fillRect(x, y, 1, 1); });
  for (let i = 0; i < n - 1; i++) seg(pts[i], pts[i + 1]);
  if (closed) seg(pts[n - 1], pts[0]);
}

/* ---------- box shapes: rectangles, rounded rectangles, ellipses ---------- */
// Row spans [xa, xb] of the shape filling the inclusive pixel box x0..x1 × y0..y1, or null outside it.
// rx, ry are the corner radii: 0 for a rectangle, Infinity for an ellipse. A pixel is in when its center is,
// except that every row keeps its middle pixel(s) and the middle row(s) span the box, so the shape always
// reaches all four box edges.
function boxRows(x0, y0, x1, y1, rx, ry) {
  const left = x0, right = x1 + 1, top = y0, bottom = y1 + 1, mid = (x0 + x1) / 2;
  rx = Math.min(rx, (right - left) / 2); ry = Math.min(ry, (bottom - top) / 2);
  return y => {
    if (y < y0 || y > y1) return null;
    const yc = y + 0.5, dy = Math.max(0, top + ry - yc, yc - (bottom - ry));
    const inset = dy > 0.5 ? rx * (1 - Math.sqrt(1 - (dy / ry) ** 2)) : 0;
    const a = Math.ceil(left + inset - 0.5), b = Math.floor(right - inset - 0.5);
    return a <= b ? [a, b] : [Math.floor(mid), Math.ceil(mid)];
  };
}
function fillRows(c, rows, y0, y1) {
  for (let y = y0; y <= y1; y++) { const s = rows(y); if (s) c.fillRect(s[0], y, s[1] - s[0] + 1, 1); }
}
// Pixels of rows whose four neighbors are all inside too.
function interiorRow(rows, y) {
  const s = rows(y), u = rows(y - 1), d = rows(y + 1);
  if (!s || !u || !d) return null;
  const a = Math.max(s[0] + 1, u[0], d[0]), b = Math.min(s[1] - 1, u[1], d[1]);
  return a <= b ? [a, b] : null;
}
// Outline: outer minus the interior of inner (a copy of outer inset by the line width less one, or null when
// the line fills the shape). With inner === outer that is the 8-connected one-pixel border.
function strokeRows(c, outer, inner, y0, y1) {
  for (let y = y0; y <= y1; y++) {
    const o = outer(y); if (!o) continue;
    const i = inner && interiorRow(inner, y);
    if (!i) { c.fillRect(o[0], y, o[1] - o[0] + 1, 1); continue; }
    c.fillRect(o[0], y, i[0] - o[0], 1);
    c.fillRect(i[1] + 1, y, o[1] - i[1], 1);
  }
}
// Box shape between two corner points: mode 0 outline in fg, 1 outline in fg filled with bg, 2 filled with fg.
function boxShape(c, a, b, radius, mode, width, fg, bg) {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  const outer = boxRows(x0, y0, x1, y1, radius, radius);
  if (mode === 2) { c.fillStyle = fg; fillRows(c, outer, y0, y1); return; }
  if (mode === 1) { c.fillStyle = bg; fillRows(c, outer, y0, y1); }
  const k = width - 1, r = Math.max(0, radius - k);
  const inner = x1 - x0 >= 2 * k && y1 - y0 >= 2 * k ? boxRows(x0 + k, y0 + k, x1 - k, y1 - k, r, r) : null;
  c.fillStyle = fg; strokeRows(c, outer, inner, y0, y1);
}

/* ---------- colors ---------- */
const hex2 = v => v.toString(16).padStart(2, '0');
const rgbHex = (r, g, b) => '#' + hex2(r) + hex2(g) + hex2(b);
const hexRgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
// Opaque color as one ImageData pixel read through a (little-endian) Uint32Array.
const hexPixel = h => { const [r, g, b] = hexRgb(h); return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0; };

/* ---------- tool icons ---------- */
const IC = { k:'#000000', w:'#ffffff', g:'#808080', l:'#c0c0c0', d:'#404040', y:'#f2cf3a', o:'#8b4a14', p:'#ee9ab0', b:'#2357c8', c:'#a6d8f0', t:'#e7c493' };
function drawIcon(g, name) {
  const f = col => { g.fillStyle = IC[col]; };
  const shape = (pts, fill, ln = 'k') => { if (fill) { f(fill); fillPoly(g, pts); } if (ln) { f(ln); polyline(g, pts, P1, true); } };
  const box = (x0, y0, x1, y1, r, fill, ln = 'k') => {
    const rows = boxRows(x0, y0, x1, y1, r, r);
    if (fill) { f(fill); fillRows(g, rows, y0, y1); }
    if (ln) { f(ln); strokeRows(g, rows, rows, y0, y1); }
  };
  switch (name) {
    case 'select': f('k'); dashed(g, rectPts(1, 3, 14, 12), true); break;
    case 'freeselect': f('k'); dashed(g, [[7,1],[9,5],[14,5],[10,8],[12,13],[7,10],[2,13],[4,8],[1,5],[5,5]], true); break;
    case 'eraser':
      shape([[5,3],[14,3],[11,6],[2,6]], 'w');
      shape([[11,6],[14,3],[14,9],[11,12]], 'g');
      shape([[2,6],[11,6],[11,12],[2,12]], 'y'); break;
    case 'fill':
      shape([[8,1],[14,7],[8,13],[2,7]], 'w');
      f('k'); line(g, P1, 8, 1, 8, 6); g.fillRect(7, 6, 3, 2);
      f('b'); fillPoly(g, [[2,7],[0,10],[0,14],[2,14],[3,9]]); break;
    case 'picker':
      shape([[8,5],[10,7],[3,14],[1,14],[1,12]], 'w');
      shape([[7,6],[9,4],[11,6],[9,8]], 'k');
      box(9, 0, 15, 6, Infinity, 'd'); break;
    case 'magnifier':
      f('k'); line(g, spansCircle(3), 9, 9, 14, 14); f('o'); line(g, P1, 10, 10, 14, 14);
      box(0, 0, 10, 10, Infinity, 'c');
      f('w'); g.fillRect(3, 3, 2, 1); g.fillRect(3, 4, 1, 1); break;
    case 'pencil':
      shape([[4,8],[10,2],[13,5],[7,11]], 'y');
      shape([[10,2],[11,1],[14,4],[13,5]], 'l');
      shape([[11,1],[12,0],[15,3],[14,4]], 'p');
      shape([[4,8],[7,11],[1,14]], 't');
      f('k'); fillPoly(g, [[2,12],[3,13],[1,14]]); g.fillRect(1, 13, 2, 2); break;
    case 'brush':
      f('k'); line(g, spansCircle(3), 14, 1, 9, 6); f('o'); line(g, P1, 14, 1, 9, 6);
      shape([[6,7],[8,5],[10,7],[8,9]], 'l');
      shape([[6,7],[8,9],[5,13],[1,15],[2,11]], 'b'); break;
    case 'airbrush':
      shape([[6,6],[11,6],[11,14],[6,14]], 'l');
      f('w'); g.fillRect(8, 7, 1, 6);
      shape([[7,3],[10,3],[10,5],[7,5]], 'd');
      f('k'); g.fillRect(5, 4, 2, 1);
      for (const [x, y] of [[3,4],[1,3],[2,1],[0,5],[2,6],[4,2],[0,1],[3,7]]) g.fillRect(x, y, 1, 1); break;
    case 'text': {
      const s2 = spansSquare(2); f('k');
      line(g, s2, 2, 13, 7, 1); line(g, s2, 8, 1, 13, 13); line(g, s2, 5, 9, 10, 9);
      g.fillRect(1, 14, 4, 1); g.fillRect(11, 14, 4, 1); break; }
    case 'line': f('k'); line(g, P1, 2, 13, 13, 2); break;
    case 'curve': f('k'); polyline(g, bezier([2,13], [3,-1], [12,17], [13,2]), P1, false); break;
    case 'rect': box(1, 3, 14, 12, 0, null); break;
    case 'polygon': shape([[2,13],[4,3],[13,2],[9,8],[14,13]], null); break;
    case 'ellipse': box(1, 3, 14, 12, Infinity, null); break;
    case 'roundrect': box(1, 3, 14, 12, 4, null); break;
  }
}
