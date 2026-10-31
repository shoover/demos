/* Paintbox: the paint program, shared by the Mac app and the web page. A host (mac/host.js, web/host.js) loads
   first as window.paintboxHost and owns the menus, files, the clipboard and the color picker. It drives the
   picture through window.paintbox, and this calls the host back with stateChanged and editColor. */
(() => {
'use strict';
const $ = s => document.querySelector(s);
const host = window.paintboxHost;
if (!host) throw new Error('Paintbox needs a host: load host.js before paintbox.js');
const shortcut = cmd => {
  for (const m of PaintboxMenus.forHost(host.name)) for (const it of m.items) if (it.cmd === cmd && it.key) return PaintboxMenus.keyLabel(it.key, host.mac);
  return null;
};
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; };
const g2 = c => c.getContext('2d', { willReadFrequently: true });

/* ---------- state ---------- */
const TOOLS = [
  ['freeselect', 'Free-Form Select', 'Selects a free-form part of the picture to move, copy, or edit.'],
  ['select', 'Select', 'Selects a rectangular part of the picture to move, copy, or edit.'],
  ['eraser', 'Eraser/Color Eraser', 'Erases with the background color. Right-click erases only the foreground color.'],
  ['fill', 'Fill With Color', 'Fills an enclosed area with the current drawing color.'],
  ['picker', 'Pick Color', 'Picks up a color from the picture for drawing.'],
  ['magnifier', 'Magnifier', 'Changes the magnification. Right-click to return to normal size.'],
  ['pencil', 'Pencil', 'Draws a free-form line one pixel wide.'],
  ['brush', 'Brush', 'Draws using a brush with the selected shape and size.'],
  ['airbrush', 'Airbrush', 'Draws using an airbrush of the selected size.'],
  ['text', 'Text', 'Inserts text into the picture. Drag to make a text box.'],
  ['line', 'Line', 'Draws a straight line with the selected line width. Shift draws at 45° angles.'],
  ['curve', 'Curve', 'Draws a curve. Drag the line, then drag twice to bend it.'],
  ['rect', 'Rectangle', 'Draws a rectangle with the selected fill style. Shift draws a square.'],
  ['polygon', 'Polygon', 'Draws a polygon. Click to add corners; double-click to finish.'],
  ['ellipse', 'Ellipse', 'Draws an ellipse with the selected fill style. Shift draws a circle.'],
  ['roundrect', 'Rounded Rectangle', 'Draws a rounded rectangle with the selected fill style.']
];
const TOOL_HINT = Object.fromEntries(TOOLS.map(t => [t[0], t[2]]));
const DEFAULT_PALETTE = [
  '#000000','#808080','#800000','#808000','#008000','#008080','#000080','#800080','#808040','#004040','#0080ff','#004080','#8000ff','#804000',
  '#ffffff','#c0c0c0','#ff0000','#ffff00','#00ff00','#00ffff','#0000ff','#ff00ff','#ffff80','#00ff80','#80ffff','#8080ff','#ff0080','#ff8040'
];
const BRUSHES = [['c',7],['c',4],['c',1],['s',8],['s',5],['s',2],['/',8],['/',5],['/',2],['\\',8],['\\',5],['\\',2]];
const BRUSH_NAMES = { c: 'Round', s: 'Square', '/': 'Slanted', '\\': 'Back-slanted' };
const ERASERS = [4, 6, 8, 10];
const AIRS = [4, 7, 11];
const MAGNIFICATIONS = [1, 2, 6, 8];
const ZOOM_STEPS = [1, 2, 4, 6, 8];
const LARGE_SIZE = 4, GRID_MIN_ZOOM = 4;
const BOX_RADIUS = { rect: 0, ellipse: Infinity, roundrect: 10 };

const S = {
  tool: 'pencil', prevTool: 'pencil', fg: '#000000', bg: '#ffffff', palette: DEFAULT_PALETTE.slice(),
  lineW: 1, brush: 1, eraser: 2, air: 0, fillMode: 0, selTransparent: false, textOpaque: false,
  grid: false, dirty: false,
  font: { family: 'Arial, Helvetica, sans-serif', size: 16, b: false, i: false, u: false }
};
const view = { tools: true, colors: true, status: true };
const cv = $('#cv'), ctx = g2(cv), ov = $('#ov'), octx = ov.getContext('2d');
const ws = $('#ws'), stage = $('#stage'), selEl = $('#sel'), tbox = $('#tbox'), ta = $('#ta'), marq = $('#marq');
let W = 0, H = 0, zoom = 1;
let modal = 0; // open dialogs and the bitmap viewer; they block every command

/* ---------- canvas size, zoom ---------- */
function setSize(w, h) {
  W = cv.width = Math.max(1, Math.min(8000, w | 0)); H = cv.height = Math.max(1, Math.min(8000, h | 0));
  ov.width = W; ov.height = H; ctx.imageSmoothingEnabled = false;
  applyZoom(); showSize();
}
function resizeCanvas(w, h) {
  const old = mk(W, H); g2(old).drawImage(cv, 0, 0);
  setSize(w, h); ctx.fillStyle = S.bg; ctx.fillRect(0, 0, W, H); ctx.drawImage(old, 0, 0);
}
function applyZoom() {
  const pw = W * zoom + 'px', ph = H * zoom + 'px';
  for (const el of [cv, ov]) { el.style.width = pw; el.style.height = ph; }
  const gl = $('#gridlay');
  gl.style.width = pw; gl.style.height = ph; gl.style.backgroundSize = zoom + 'px ' + zoom + 'px';
  gl.hidden = !(S.grid && zoom >= GRID_MIN_ZOOM);
  if (sel) placeSel();
  if (tb) layoutText();
}
function setZoom(z, focus) {
  commitText();
  z = Math.max(1, Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], z));
  const cx = focus ? focus[0] : (ws.scrollLeft + ws.clientWidth / 2) / zoom;
  const cy = focus ? focus[1] : (ws.scrollTop + ws.clientHeight / 2) / zoom;
  zoom = z; applyZoom();
  ws.scrollLeft = cx * z - ws.clientWidth / 2; ws.scrollTop = cy * z - ws.clientHeight / 2;
  if (S.tool === 'magnifier') renderOptions();
  const gridKey = shortcut('grid');
  hint(z === 1 ? 'Normal size.' : 'Zoom ' + z + '×.' + (z >= GRID_MIN_ZOOM && !S.grid
    ? (gridKey ? ' Press ' + gridKey + ' to show the grid.' : ' Choose View ▸ Show Grid to show the grid.') : ''));
  syncState();
}
function zoomStep(dir) {
  const next = dir > 0 ? ZOOM_STEPS.find(v => v > zoom) : ZOOM_STEPS.slice().reverse().find(v => v < zoom);
  if (next) setZoom(next);
}

/* ---------- undo ---------- */
const undoS = [], redoS = [];
const UNDO_LEVELS = 50, UNDO_BYTES = 512 * 2 ** 20;
const snap = () => ({ w: W, h: H, img: ctx.getImageData(0, 0, W, H) });
function pushUndo() {
  undoS.push(snap()); redoS.length = 0;
  let bytes = undoS.reduce((n, s) => n + s.img.data.length, 0);
  while (undoS.length > 1 && (undoS.length > UNDO_LEVELS || bytes > UNDO_BYTES)) bytes -= undoS.shift().img.data.length;
}
function clearUndo() { undoS.length = 0; redoS.length = 0; }
function restore(s) { if (s.w !== W || s.h !== H) setSize(s.w, s.h); ctx.putImageData(s.img, 0, 0); }
function undo() {
  if (tb) { cancelText(); return; }
  if (poly) { poly = null; clearOv(); return; }
  if (curve) { curve = null; clearOv(); return; }
  if (sel) { if (sel.lifted) commitSel(); else { hideSel(); return; } }
  if (!undoS.length) { hint('Nothing to undo.'); return; }
  redoS.push(snap()); restore(undoS.pop()); changed();
}
function redo() {
  commitAll();
  if (!redoS.length) { hint('Nothing to redo.'); return; }
  undoS.push(snap()); restore(redoS.pop()); changed();
}

/* ---------- status bar ---------- */
const hintEl = $('#hint'), xyEl = $('#xy'), whEl = $('#wh');
const IDLE = 'For Help, choose Help ▸ Keyboard Shortcuts.';
function hint(t) { hintEl.textContent = t || TOOL_HINT[S.tool] || IDLE; }
// Size of what is being drawn, else of the selection, else of the picture.
function showSize(w, h) { whEl.textContent = w != null ? w + '×' + h : sel ? sel.w + '×' + sel.h : W + '×' + H + ' px'; }
function changed() { S.dirty = true; showSize(); syncState(); }

/* ---------- colors ---------- */
function showColors() {
  $('#fgc').style.background = S.fg; $('#bgc').style.background = S.bg;
  if (tb) layoutText();
  if (sel && S.selTransparent) selView();
}
function buildPalette() {
  const p = $('#palette'); p.replaceChildren();
  S.palette.forEach((col, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sw'; b.style.background = col;
    b.setAttribute('aria-label', 'Color ' + col); b.title = 'Click: foreground · Right-click: background · Double-click: edit';
    b.addEventListener('click', () => { editIdx = -1; S.fg = S.palette[i]; showColors(); });
    b.addEventListener('contextmenu', e => { e.preventDefault(); S.bg = S.palette[i]; showColors(); });
    b.addEventListener('dblclick', () => editColor(i));
    p.append(b);
  });
}
// The host's color picker edits the foreground color, and the palette swatch it was opened from if any.
let editIdx = -1;
function editColor(i) { editIdx = i; host.editColor(i >= 0 ? S.palette[i] : S.fg); }
function setEditedColor(hex) {
  if (editIdx >= 0) {
    S.palette[editIdx] = hex;
    const b = $('#palette').children[editIdx]; b.style.background = hex; b.setAttribute('aria-label', 'Color ' + hex);
  }
  S.fg = hex; showColors();
}
$('#current').addEventListener('click', swapColors);
function swapColors() { [S.fg, S.bg] = [S.bg, S.fg]; showColors(); }

/* ---------- tools & options UI ---------- */
const toolBtns = {};
const icons = {};
function buildTools() {
  const box = $('#tools');
  for (const [id, label] of TOOLS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tool'; b.title = label; b.setAttribute('aria-label', label); b.setAttribute('aria-pressed', 'false');
    icons[id] = mk(16, 16); drawIcon(g2(icons[id]), id); b.append(icons[id]);
    b.addEventListener('click', () => selectTool(id));
    b.addEventListener('pointerenter', () => { hintEl.textContent = TOOL_HINT[id]; });
    b.addEventListener('pointerleave', () => hint());
    toolBtns[id] = b; box.append(b);
  }
}
const cursorFor = {};
function makeCursor(id, hx, hy) {
  const c = mk(32, 32), g = g2(c);
  g.imageSmoothingEnabled = false; g.drawImage(icons[id], 0, 0, 16, 16, 0, 0, 16, 16);
  return 'url(' + c.toDataURL() + ') ' + hx + ' ' + hy + ', crosshair';
}
function stageCursor() {
  const t = S.tool;
  if (!cursorFor.fill) { cursorFor.fill = makeCursor('fill', 1, 13); cursorFor.picker = makeCursor('picker', 1, 14); cursorFor.pencil = makeCursor('pencil', 1, 14); }
  stage.style.cursor = t === 'magnifier' ? 'zoom-in' : t === 'eraser' ? 'none' : cursorFor[t] || 'crosshair';
}
// Pick Color and Magnifier are one-shot tools: after use they hand back to the tool chosen before them.
const ONE_SHOT = new Set(['picker', 'magnifier']);
function selectTool(t) {
  if (t !== S.tool) {
    commitAll();
    if (ONE_SHOT.has(t) && !ONE_SHOT.has(S.tool)) S.prevTool = S.tool;
    S.tool = t;
  }
  for (const id in toolBtns) toolBtns[id].setAttribute('aria-pressed', String(id === S.tool));
  renderOptions(); stageCursor(); hint(); clearOv();
}
function renderOptions() {
  const box = $('#opts'); box.replaceChildren(); box.className = 'opts';
  const t = S.tool;
  const add = (pressed, label, w, h, draw, onpick) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'opt'; b.title = label; b.setAttribute('aria-label', label); b.setAttribute('aria-pressed', String(pressed));
    if (typeof draw === 'string') b.textContent = draw;
    else { const c = mk(w, h), g = g2(c); draw(g, pressed ? '#ffffff' : '#000000', w, h); c.style.width = w + 'px'; c.style.height = h + 'px'; b.append(c); }
    b.addEventListener('click', () => { onpick(); renderOptions(); });
    box.append(b);
  };
  const opaqueIcons = (getter, setter, what) => {
    const blob = g => { g.fillStyle = '#2357c8'; fillRows(g, boxRows(3, 6, 15, 18, Infinity, Infinity), 6, 18); g.fillStyle = '#c8261e'; g.fillRect(20, 8, 9, 9); };
    add(!getter(), 'Opaque ' + what, 34, 20, (g, ink) => {
      g.fillStyle = '#ffffff'; g.fillRect(9, 3, 16, 14); g.fillStyle = ink; polyline(g, rectPts(9, 3, 24, 16), P1, true); blob(g);
    }, () => setter(false));
    add(getter(), 'Transparent ' + what, 34, 20, (g, ink) => { g.fillStyle = ink; dashed(g, rectPts(9, 3, 24, 16), true); blob(g); }, () => setter(true));
  };
  switch (t) {
    case 'select': case 'freeselect':
      opaqueIcons(() => S.selTransparent, setSelTransparent, 'selection');
      break;
    case 'text':
      opaqueIcons(() => !S.textOpaque, v => { S.textOpaque = !v; if (tb) layoutText(); }, 'text background');
      break;
    case 'eraser':
      ERASERS.forEach((s, i) => add(S.eraser === i, 'Eraser ' + s + ' px', 34, 13, (g, ink) => { g.fillStyle = ink; g.fillRect(17 - s / 2, 6.5 - s / 2 | 0, s, s); }, () => { S.eraser = i; }));
      break;
    case 'brush':
      box.className = 'opts grid3';
      BRUSHES.forEach(([k, s], i) => add(S.brush === i, BRUSH_NAMES[k] + ' brush ' + s + ' px', 11, 11, (g, ink) => { g.fillStyle = ink; stamp(g, brushSpans(i), 5, 5); }, () => { S.brush = i; }));
      break;
    case 'airbrush':
      AIRS.forEach((r, i) => add(S.air === i, 'Airbrush size ' + (i + 1), 30, 24, (g, ink) => {
        g.fillStyle = ink; let seed = 7 + i * 13; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        for (let k = 0; k < r * 5; k++) { const a = rnd() * 6.283, d = Math.sqrt(rnd()) * r; g.fillRect(Math.round(15 + Math.cos(a) * d), Math.round(12 + Math.sin(a) * d), 1, 1); }
      }, () => { S.air = i; }));
      break;
    case 'line': case 'curve':
      [1, 2, 3, 4, 5].forEach(w => add(S.lineW === w, 'Line width ' + w, 32, 9, (g, ink) => { g.fillStyle = ink; g.fillRect(2, 4 - Math.floor((w - 1) / 2), 28, w); }, () => { S.lineW = w; }));
      break;
    case 'rect': case 'ellipse': case 'roundrect': case 'polygon':
      ['Outline', 'Outline with fill', 'Fill without outline'].forEach((label, i) => add(S.fillMode === i, label, 32, 12, (g, ink) => {
        if (i > 0) { g.fillStyle = '#808080'; g.fillRect(4, 2, 24, 8); }
        if (i < 2) { g.fillStyle = ink; polyline(g, rectPts(3, 1, 28, 10), P1, true); }
      }, () => { S.fillMode = i; }));
      [1, 2, 3, 4, 5].forEach(w => add(S.lineW === w, 'Outline width ' + w, 32, 7, (g, ink) => { g.fillStyle = ink; g.fillRect(4, 3 - Math.floor((w - 1) / 2), 24, w); }, () => { S.lineW = w; }));
      break;
    case 'magnifier':
      MAGNIFICATIONS.forEach(z => add(zoom === z, 'Zoom ' + z + '×', 0, 0, z + '×', () => setZoom(z)));
      break;
  }
}
function brushSpans(i) {
  const [k, s] = BRUSHES[i];
  return k === 'c' ? spansCircle(s) : k === 's' ? spansSquare(s) : spansSlash(s, k === '\\');
}
const lineSpans = w => w <= 2 ? spansSquare(w) : spansCircle(w);

/* ---------- overlay helpers ---------- */
function clearOv() { octx.clearRect(0, 0, W, H); }
function showMarq(x0, y0, x1, y1) {
  const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0) + 1, h = Math.abs(y1 - y0) + 1;
  marq.style.left = x * zoom + 'px'; marq.style.top = y * zoom + 'px';
  marq.style.width = w * zoom + 'px'; marq.style.height = h * zoom + 'px'; marq.hidden = false;
  showSize(w, h);
}
function hideMarq() { marq.hidden = true; showSize(); }

/* ---------- selection ---------- */
// sel.c holds the selected pixels. Until it is lifted (moved, transformed, deleted) the picture under it is untouched.
let sel = null;
function makeSel(x, y, w, h, path) {
  const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(W, x + w), y1 = Math.min(H, y + h);
  if (x1 - x0 < 1 || y1 - y0 < 1) return;
  w = x1 - x0; h = y1 - y0;
  const c = mk(w, h), g = g2(c); g.drawImage(cv, x0, y0, w, h, 0, 0, w, h);
  let lp = null;
  if (path) {
    lp = path.map(p => [p[0] - x0, p[1] - y0]);
    const m = mk(w, h), mg = g2(m); mg.fillStyle = '#000'; fillPoly(mg, lp); polyline(mg, lp, P1, true);
    g.globalCompositeOperation = 'destination-in'; g.drawImage(m, 0, 0); g.globalCompositeOperation = 'source-over';
  }
  sel = { x: x0, y: y0, w, h, c, path: lp, sx: x0, sy: y0, lifted: false };
  selView(); selEl.hidden = false;
}
// Lifting cuts the selection out of the picture (leaving the background color) unless keep is set.
function lift(keep) {
  if (!sel || sel.lifted) return;
  pushUndo();
  if (!keep) {
    ctx.fillStyle = S.bg;
    if (sel.path) { const p = sel.path.map(q => [q[0] + sel.sx, q[1] + sel.sy]); fillPoly(ctx, p); polyline(ctx, p, P1, true); }
    else ctx.fillRect(sel.sx, sel.sy, sel.w, sel.h);
  }
  sel.lifted = true; changed();
}
// Draw opaque off: pixels of the background color in the selection are see-through.
function keyed() {
  if (!S.selTransparent) return sel.c;
  const c = mk(sel.w, sel.h), g = g2(c); g.drawImage(sel.c, 0, 0);
  const id = g.getImageData(0, 0, sel.w, sel.h), d = id.data, [r, gg, b] = hexRgb(S.bg);
  for (let i = 0; i < d.length; i += 4) if (d[i] === r && d[i + 1] === gg && d[i + 2] === b) d[i + 3] = 0;
  g.putImageData(id, 0, 0); return c;
}
function stampSel() { ctx.drawImage(keyed(), sel.x, sel.y); }
function selView() {
  const v = selEl.querySelector('canvas'); v.width = sel.w; v.height = sel.h;
  const g = g2(v); g.clearRect(0, 0, sel.w, sel.h); g.drawImage(keyed(), 0, 0); placeSel();
}
function placeSel() {
  selEl.style.left = sel.x * zoom + 'px'; selEl.style.top = sel.y * zoom + 'px';
  selEl.style.width = sel.w * zoom + 'px'; selEl.style.height = sel.h * zoom + 'px';
  showSize();
}
function setSelTransparent(v) {
  S.selTransparent = v; if (sel) selView();
  hint(v ? 'Background-colored pixels in the selection are now see-through.' : 'Selection is opaque.');
}
function hideSel() { sel = null; selEl.hidden = true; showSize(); }
function commitSel() {
  if (!sel) return;
  if (sel.lifted) { stampSel(); changed(); }
  hideSel();
}
function deleteSel() {
  if (!sel) return;
  if (!sel.lifted) lift(); else changed();
  hideSel();
}
function copySel(cut) {
  if (!sel) return null;
  const c = mk(sel.w, sel.h); g2(c).drawImage(sel.c, 0, 0);
  if (cut) deleteSel();
  hint(cut ? 'Cut to the clipboard.' : 'Copied to the clipboard.');
  return c;
}
// Pasting enlarges the picture when needed and floats the pasted pixels at the top left of the view.
function pasteCanvas(src) {
  commitAll(); selectTool('select'); pushUndo();
  if (src.width > W || src.height > H) resizeCanvas(Math.max(W, src.width), Math.max(H, src.height));
  const x = Math.min(Math.max(0, Math.floor(ws.scrollLeft / zoom)), Math.max(0, W - src.width));
  const y = Math.min(Math.max(0, Math.floor(ws.scrollTop / zoom)), Math.max(0, H - src.height));
  const c = mk(src.width, src.height); g2(c).drawImage(src, 0, 0);
  sel = { x, y, w: c.width, h: c.height, c, path: null, sx: x, sy: y, lifted: true };
  selView(); selEl.hidden = false; changed();
  hint('Pasted. Drag the selection to place it, then click outside it.');
}
function selectAll() { commitAll(); selectTool('select'); makeSel(0, 0, W, H); }

/* ---------- image operations ---------- */
function xform(src, kind) {
  const w = src.width, h = src.height, rot = kind === 'r90' || kind === 'r270';
  const c = mk(rot ? h : w, rot ? w : h), g = g2(c); g.imageSmoothingEnabled = false;
  if (kind === 'fh') { g.translate(w, 0); g.scale(-1, 1); }
  else if (kind === 'fv') { g.translate(0, h); g.scale(1, -1); }
  else if (kind === 'r90') { g.translate(h, 0); g.rotate(Math.PI / 2); }
  else if (kind === 'r180') { g.translate(w, h); g.rotate(Math.PI); }
  else if (kind === 'r270') { g.translate(0, w); g.rotate(-Math.PI / 2); }
  g.drawImage(src, 0, 0); return c;
}
function invert(src) {
  const c = mk(src.width, src.height), g = g2(c); g.drawImage(src, 0, 0);
  const id = g.getImageData(0, 0, c.width, c.height), d = id.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }
  g.putImageData(id, 0, 0); return c;
}
function stretch(src, sx, sy) {
  const c = mk(Math.round(src.width * sx), Math.round(src.height * sy)), g = g2(c);
  g.imageSmoothingEnabled = false; g.drawImage(src, 0, 0, c.width, c.height); return c;
}
// Applies to the selection when there is one, else to the whole picture.
function imageOp(fn) {
  finishPoly(); finishCurve(); commitText();
  if (sel) {
    lift();
    sel.c = fn(sel.c); sel.w = sel.c.width; sel.h = sel.c.height; sel.path = null;
    selView(); changed();
  } else {
    pushUndo();
    const src = mk(W, H); g2(src).drawImage(cv, 0, 0);
    const out = fn(src); setSize(out.width, out.height); ctx.drawImage(out, 0, 0); changed();
  }
}

/* ---------- text tool ---------- */
let tb = null;
const fontCss = z => (S.font.i ? 'italic ' : '') + (S.font.b ? 'bold ' : '') + (S.font.size * z) + 'px ' + S.font.family;
const lineH = () => Math.round(S.font.size * 1.2);
function openText(x, y, w, h) {
  tb = { x, y, w: Math.max(8, w), h: Math.max(lineH(), h) };
  ta.value = ''; tbox.hidden = false; $('#fontbar').hidden = false; layoutText();
  ta.focus(); setTimeout(() => { if (tb) ta.focus(); }, 0);
  hint('Type your text. Click outside the box to place it.');
}
function layoutText() {
  tbox.style.left = tb.x * zoom + 'px'; tbox.style.top = tb.y * zoom + 'px';
  tbox.style.width = tb.w * zoom + 'px'; tbox.style.height = tb.h * zoom + 'px';
  ta.style.font = fontCss(zoom); ta.style.lineHeight = lineH() * zoom + 'px';
  ta.style.textDecoration = S.font.u ? 'underline' : 'none';
  ta.style.color = S.fg; tbox.style.background = S.textOpaque ? S.bg : 'transparent';
}
function wrapLines(g, text, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/); let cur = '';
    for (const word of words) {
      const test = cur + word;
      if (g.measureText(test).width <= maxW || !cur) { cur = test; continue; }
      out.push(cur.replace(/\s+$/, '')); cur = word.replace(/^\s+/, '');
      while (g.measureText(cur).width > maxW && cur.length > 1) {
        let k = cur.length; while (k > 1 && g.measureText(cur.slice(0, k)).width > maxW) k--;
        out.push(cur.slice(0, k)); cur = cur.slice(k);
      }
    }
    out.push(cur);
  }
  return out;
}
// Text is rendered once, then thresholded to the foreground color so the picture stays hard-edged.
function commitText() {
  if (!tb) return;
  const text = ta.value, box = tb;
  tb = null; tbox.hidden = true; $('#fontbar').hidden = true; ta.blur();
  if (!text.trim()) { hint(); return; }
  pushUndo();
  const c = mk(box.w, box.h), g = g2(c);
  g.font = fontCss(1); g.textBaseline = 'top'; g.fillStyle = S.fg;
  const lh = lineH(), off = Math.round((lh - S.font.size) / 2);
  wrapLines(g, text, box.w).forEach((ln, i) => {
    const y = i * lh + off; g.fillText(ln, 0, y);
    if (S.font.u && ln) g.fillRect(0, y + Math.round(S.font.size * 0.95), Math.ceil(g.measureText(ln).width), Math.max(1, Math.round(S.font.size / 14)));
  });
  const id = g.getImageData(0, 0, c.width, c.height), d = id.data, [r, gg, b] = hexRgb(S.fg);
  for (let i = 0; i < d.length; i += 4) { if (d[i + 3] >= 110) { d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255; } else d[i + 3] = 0; }
  g.putImageData(id, 0, 0);
  if (S.textOpaque) { ctx.fillStyle = S.bg; ctx.fillRect(box.x, box.y, box.w, box.h); }
  ctx.drawImage(c, box.x, box.y); changed(); hint();
}
function cancelText() { tb = null; tbox.hidden = true; $('#fontbar').hidden = true; ta.blur(); hint(); }
ta.addEventListener('input', () => {
  if (!tb) return;
  const need = Math.ceil(ta.scrollHeight / zoom);
  if (need > tb.h) { tb.h = Math.min(H - tb.y, need); layoutText(); }
});
(function fontbarInit() {
  const fs = $('#fSize');
  for (const v of [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72]) { const o = document.createElement('option'); o.value = v; o.textContent = v; fs.append(o); }
  fs.value = S.font.size;
  const refocus = () => { if (tb) { layoutText(); ta.focus(); } };
  $('#fFamily').addEventListener('change', e => { S.font.family = e.target.value; refocus(); });
  fs.addEventListener('change', e => { S.font.size = +e.target.value; if (tb) tb.h = Math.max(tb.h, lineH()); refocus(); });
  for (const [id, k] of [['#fB', 'b'], ['#fI', 'i'], ['#fU', 'u']]) {
    const b = $(id);
    b.addEventListener('pointerdown', e => e.preventDefault());
    b.addEventListener('click', () => { S.font[k] = !S.font[k]; b.setAttribute('aria-pressed', String(S.font[k])); refocus(); });
  }
})();

/* ---------- drawing tools ---------- */
// Each tool gets down/move/up with the pixel position and the drag record d: d.fg and d.bg are the colors for
// the button pressed (swapped for the right button), d.btn is 0 for left and 1 for right, d.x0/d.y0 the start.
let poly = null, curve = null, airTimer = 0;
const constrainLine = (a, p) => {
  const dx = p[0] - a[0], dy = p[1] - a[1], ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
  return [Math.round(a[0] + Math.cos(ang) * len), Math.round(a[1] + Math.sin(ang) * len)];
};
const constrainBox = (a, p) => { const s = Math.max(Math.abs(p[0] - a[0]), Math.abs(p[1] - a[1])); return [a[0] + Math.sign(p[0] - a[0] || 1) * s, a[1] + Math.sign(p[1] - a[1] || 1) * s]; };
function drawPoly(c, pts, fg, bg) {
  const mode = S.fillMode;
  if (mode === 1) { c.fillStyle = bg; fillPoly(c, pts); }
  if (mode === 2) { c.fillStyle = fg; fillPoly(c, pts); polyline(c, pts, P1, true); return; }
  c.fillStyle = fg; polyline(c, pts, lineSpans(S.lineW), true);
}
const pixelAt = (x, y) => new Uint32Array(ctx.getImageData(x, y, 1, 1).data.buffer)[0];
function flood(x, y, hex) {
  const img = ctx.getImageData(0, 0, W, H), d = new Uint32Array(img.data.buffer);
  const t = d[y * W + x], v = hexPixel(hex);
  const st = [x, y];
  while (st.length) {
    const yy = st.pop(); let xx = st.pop(), i = yy * W + xx;
    while (xx >= 0 && d[i] === t) { xx--; i--; }
    xx++; i++;
    let up = false, dn = false;
    while (xx < W && d[i] === t) {
      d[i] = v;
      if (yy > 0) { if (d[i - W] === t) { if (!up) { st.push(xx, yy - 1); up = true; } } else up = false; }
      if (yy < H - 1) { if (d[i + W] === t) { if (!dn) { st.push(xx, yy + 1); dn = true; } } else dn = false; }
      xx++; i++;
    }
  }
  ctx.putImageData(img, 0, 0);
}
// Color eraser: within the eraser square along a to b, pixels of the foreground color become the background color.
function colorErase(d, a, b) {
  const s = ERASERS[S.eraser], o = -Math.floor((s - 1) / 2), px = new Uint32Array(d.img.data.buffer);
  const from = hexPixel(S.fg), to = hexPixel(S.bg);
  walk(a[0], a[1], b[0], b[1], (x, y) => {
    for (let j = Math.max(0, y + o); j < Math.min(H, y + o + s); j++)
      for (let i = Math.max(0, x + o); i < Math.min(W, x + o + s); i++) if (px[j * W + i] === from) px[j * W + i] = to;
  });
  ctx.putImageData(d.img, 0, 0, Math.min(a[0], b[0]) + o, Math.min(a[1], b[1]) + o, Math.abs(b[0] - a[0]) + s, Math.abs(b[1] - a[1]) + s);
}
const inside = p => p[0] >= 0 && p[1] >= 0 && p[0] < W && p[1] < H;
function spray(d) {
  const r = AIRS[S.air]; ctx.fillStyle = d.fg;
  for (let k = 0; k < Math.ceil(r * 1.3); k++) {
    const a = Math.random() * 6.2832, q = Math.sqrt(Math.random()) * r;
    ctx.fillRect(Math.round(d.p[0] + Math.cos(a) * q), Math.round(d.p[1] + Math.sin(a) * q), 1, 1);
  }
}
const freehand = spansFn => ({
  down(p, d) { pushUndo(); d.sp = spansFn(d); ctx.fillStyle = d.paint; stamp(ctx, d.sp, p[0], p[1]); d.last = p; },
  move(p, d) { ctx.fillStyle = d.paint; line(ctx, d.sp, d.last[0], d.last[1], p[0], p[1]); d.last = p; },
  up() { changed(); }
});
const eraseAll = freehand(() => spansSquare(ERASERS[S.eraser]));
const T = {
  pencil: freehand(() => P1),
  brush: freehand(() => brushSpans(S.brush)),
  eraser: {
    down(p, d) {
      if (!d.btn) { eraseAll.down(p, d); return; }
      pushUndo(); d.img = ctx.getImageData(0, 0, W, H); d.last = p; colorErase(d, p, p);
    },
    move(p, d) { if (!d.btn) { eraseAll.move(p, d); return; } colorErase(d, d.last, p); d.last = p; },
    up() { changed(); }
  },
  airbrush: {
    down(p, d) { pushUndo(); d.p = p; spray(d); clearInterval(airTimer); airTimer = setInterval(() => spray(d), 28); },
    move(p, d) { d.p = p; spray(d); },
    up() { clearInterval(airTimer); changed(); }
  },
  fill: {
    down(p, d) {
      if (!inside(p) || pixelAt(p[0], p[1]) === hexPixel(d.fg)) return;
      pushUndo(); flood(p[0], p[1], d.fg); changed();
    }
  },
  picker: {
    down(p, d) {
      if (!inside(p)) return;
      const px = ctx.getImageData(p[0], p[1], 1, 1).data, col = rgbHex(px[0], px[1], px[2]);
      if (d.btn === 0) S.fg = col; else S.bg = col;
      showColors(); selectTool(S.prevTool);
    }
  },
  // Click zooms in to Large Size, or back to normal size when zoomed in; the options box zooms directly.
  magnifier: {
    down(p, d) { const z = d.btn === 1 || zoom > 1 ? 1 : LARGE_SIZE; selectTool(S.prevTool); setZoom(z, p); }
  },
  line: {
    down(p, d) { d.end = p; this.move(p, d); },
    move(p, d) { d.end = d.shift ? constrainLine([d.x0, d.y0], p) : p; clearOv(); octx.fillStyle = d.fg; line(octx, lineSpans(S.lineW), d.x0, d.y0, d.end[0], d.end[1]); showSize(Math.abs(d.end[0] - d.x0) + 1, Math.abs(d.end[1] - d.y0) + 1); },
    up(p, d) { clearOv(); pushUndo(); ctx.fillStyle = d.fg; line(ctx, lineSpans(S.lineW), d.x0, d.y0, d.end[0], d.end[1]); changed(); }
  },
  curve: {
    down(p, d) {
      if (!curve) curve = { st: 0, p0: p, p3: p, c1: p, c2: p, fg: d.fg };
      else if (curve.st === 1) curve.c1 = curve.c2 = p;
      else curve.c2 = p;
      previewCurve();
    },
    move(p) { if (!curve) return; if (curve.st === 0) curve.p3 = p; else if (curve.st === 1) curve.c1 = curve.c2 = p; else curve.c2 = p; previewCurve(); },
    up() {
      if (!curve) return;
      if (curve.st === 0) { curve.c1 = curve.p0; curve.c2 = curve.p3; curve.st = 1; hint('Drag to bend the curve, then drag once more to finish it.'); }
      else if (curve.st === 1) { curve.st = 2; }
      else finishCurve();
    }
  },
  polygon: {
    down(p, d) {
      const now = performance.now();
      if (!poly) { poly = { pts: [p, p], fg: d.fg, bg: d.bg, t: now, last: p }; previewPoly(); return; }
      const near = (a, b, r) => Math.abs(a[0] - b[0]) <= r && Math.abs(a[1] - b[1]) <= r;
      const tol = Math.max(2, Math.ceil(5 / zoom));
      if ((now - poly.t < 450 && near(p, poly.last, tol)) || (poly.pts.length >= 3 && near(p, poly.pts[0], tol))) { d.done = true; finishPoly(); return; }
      poly.pts.push(p); poly.t = now; poly.last = p; previewPoly();
    },
    move(p, d) { if (d.done || !poly) return; poly.pts[poly.pts.length - 1] = d.shift ? constrainLine(poly.pts[poly.pts.length - 2], p) : p; previewPoly(); },
    up(p, d) { if (poly && !d.done) poly.last = poly.pts[poly.pts.length - 1]; }
  },
  select: {
    down(p, d) { d.end = p; showMarq(p[0], p[1], p[0], p[1]); },
    move(p, d) { d.end = p; showMarq(d.x0, d.y0, p[0], p[1]); },
    up(p, d) {
      hideMarq();
      const x0 = Math.min(d.x0, d.end[0]), y0 = Math.min(d.y0, d.end[1]), w = Math.abs(d.end[0] - d.x0) + 1, h = Math.abs(d.end[1] - d.y0) + 1;
      if (w > 1 || h > 1) makeSel(x0, y0, w, h, null);
    }
  },
  freeselect: {
    down(p, d) { d.pts = [p]; clearOv(); octx.fillStyle = '#000'; octx.fillRect(p[0], p[1], 1, 1); },
    move(p, d) { const l = d.pts[d.pts.length - 1]; if (l[0] === p[0] && l[1] === p[1]) return; octx.fillStyle = '#000'; line(octx, P1, l[0], l[1], p[0], p[1]); d.pts.push(p); },
    up(p, d) {
      clearOv();
      if (d.pts.length < 3) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const q of d.pts) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
      makeSel(x0, y0, x1 - x0 + 1, y1 - y0 + 1, d.pts);
    }
  },
  text: {
    down(p, d) { d.end = p; showMarq(p[0], p[1], p[0], p[1]); },
    move(p, d) { d.end = p; showMarq(d.x0, d.y0, p[0], p[1]); },
    up(p, d) {
      hideMarq();
      let x = Math.max(0, Math.min(d.x0, d.end[0])), y = Math.max(0, Math.min(d.y0, d.end[1]));
      let w = Math.abs(d.end[0] - d.x0) + 1, h = Math.abs(d.end[1] - d.y0) + 1;
      if (w < 12 && h < 12) { w = Math.min(220, W - x); h = lineH() * 2; }
      x = Math.min(x, Math.max(0, W - 8)); y = Math.min(y, Math.max(0, H - 8));
      openText(x, y, Math.min(w, W - x), Math.min(h, H - y));
    }
  }
};
const drawBox = (c, kind, d) => boxShape(c, [d.x0, d.y0], d.end, BOX_RADIUS[kind], S.fillMode, S.lineW, d.fg, d.bg);
for (const kind in BOX_RADIUS) {
  T[kind] = {
    down(p, d) { this.move(p, d); },
    move(p, d) { d.end = d.shift ? constrainBox([d.x0, d.y0], p) : p; clearOv(); drawBox(octx, kind, d); showSize(Math.abs(d.end[0] - d.x0) + 1, Math.abs(d.end[1] - d.y0) + 1); },
    up(p, d) { clearOv(); pushUndo(); drawBox(ctx, kind, d); changed(); }
  };
}
function previewCurve() { clearOv(); octx.fillStyle = curve.fg; polyline(octx, bezier(curve.p0, curve.c1, curve.c2, curve.p3), lineSpans(S.lineW), false); }
function finishCurve() {
  if (!curve) return;
  const c = curve; curve = null; clearOv(); pushUndo();
  ctx.fillStyle = c.fg; polyline(ctx, bezier(c.p0, c.c1, c.c2, c.p3), lineSpans(S.lineW), false); changed(); hint();
}
function previewPoly() { clearOv(); octx.fillStyle = poly.fg; polyline(octx, poly.pts, lineSpans(S.fillMode === 2 ? 1 : S.lineW), false); }
function finishPoly() {
  if (!poly) return;
  const p = poly; poly = null; clearOv();
  const pts = p.pts.filter((q, i, a) => i === 0 || q[0] !== a[i - 1][0] || q[1] !== a[i - 1][1]);
  if (pts.length < 2) return;
  pushUndo(); drawPoly(ctx, pts, p.fg, p.bg); changed();
}
function commitAll() { finishPoly(); finishCurve(); commitText(); commitSel(); }

/* ---------- pointer handling ---------- */
let drag = null;
const pt = e => { const r = cv.getBoundingClientRect(); return [Math.floor((e.clientX - r.left) / zoom), Math.floor((e.clientY - r.top) / zoom)]; };
stage.addEventListener('contextmenu', e => e.preventDefault());
stage.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.button !== 2) return;
  if (drag) return;
  if (e.target.closest('#tbox')) return;
  e.preventDefault();
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  const btn = e.button === 2 || e.ctrlKey ? 1 : 0, p = pt(e); // Control-click is the Mac's right click
  const handle = e.target.closest('.handle');
  stage.setPointerCapture(e.pointerId);
  if (handle) { commitAll(); drag = { mode: 'resize', k: handle.dataset.k, id: e.pointerId, w: W, h: H }; return; }
  if (sel && e.target.closest('#sel')) {
    // Option-drag leaves a copy behind; Shift-drag smears copies along the way.
    drag = { mode: 'move', ox: p[0] - sel.x, oy: p[1] - sel.y, id: e.pointerId, copy: e.altKey, smear: e.shiftKey, moved: false };
    return;
  }
  if (tb) { commitText(); drag = { mode: 'none', id: e.pointerId }; return; }
  if (sel) commitSel();
  const fg = btn ? S.bg : S.fg, bg = btn ? S.fg : S.bg;
  drag = { mode: 'tool', tool: S.tool, btn, fg, bg, paint: S.tool === 'eraser' ? S.bg : fg, x0: p[0], y0: p[1], shift: e.shiftKey, id: e.pointerId };
  if (S.tool === 'eraser') clearOv();
  T[S.tool].down(p, drag, e);
  if (drag && drag.tool !== S.tool) drag.mode = 'none';
});
stage.addEventListener('pointermove', e => {
  const p = pt(e);
  xyEl.textContent = inside(p) ? p[0] + ', ' + p[1] : '';
  if (!drag) { hover(p); return; }
  if (e.pointerId !== drag.id) return;
  if (drag.mode === 'tool') { drag.shift = e.shiftKey; const tl = T[drag.tool]; if (tl.move) tl.move(p, drag); if (drag.tool === 'eraser') hover(p); }
  else if (drag.mode === 'move') {
    const x = p[0] - drag.ox, y = p[1] - drag.oy;
    if (x === sel.x && y === sel.y) return;
    if (!drag.moved) {
      drag.moved = true;
      if (!(drag.copy || drag.smear)) lift();
      else if (!sel.lifted) lift(true);
      else { pushUndo(); stampSel(); }
    } else if (drag.smear) stampSel();
    sel.x = x; sel.y = y; placeSel();
  }
  else if (drag.mode === 'resize') {
    drag.w = drag.k === 'b' ? W : Math.max(1, p[0]); drag.h = drag.k === 'r' ? H : Math.max(1, p[1]);
    showMarq(0, 0, drag.w - 1, drag.h - 1);
  }
});
const endDrag = e => {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag; drag = null;
  const p = pt(e);
  if (d.mode === 'tool' && T[d.tool].up) T[d.tool].up(p, d);
  else if (d.mode === 'move') { if (d.moved) changed(); }
  else if (d.mode === 'resize') { hideMarq(); if (d.w !== W || d.h !== H) { pushUndo(); resizeCanvas(d.w, d.h); changed(); } }
  if (e.type === 'pointercancel') clearInterval(airTimer);
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);
stage.addEventListener('lostpointercapture', endDrag);
stage.addEventListener('pointerleave', () => { if (!drag) { xyEl.textContent = ''; if (S.tool === 'eraser') clearOv(); } });
function hover(p) {
  if (S.tool !== 'eraser') return;
  clearOv();
  const s = ERASERS[S.eraser], o = -Math.floor((s - 1) / 2);
  octx.fillStyle = '#000'; polyline(octx, rectPts(p[0] + o, p[1] + o, p[0] + o + s - 1, p[1] + o + s - 1), P1, true);
  octx.fillStyle = S.bg; octx.fillRect(p[0] + o + 1, p[1] + o + 1, s - 2, s - 2);
}
// Command-scroll (Control-scroll off the Mac) zooms one step per notch; trackpads send many small deltas, so they are summed first.
let wheelSum = 0;
ws.addEventListener('wheel', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  wheelSum += e.deltaY;
  if (Math.abs(wheelSum) < 30) return;
  zoomStep(wheelSum < 0 ? 1 : -1); wheelSum = 0;
}, { passive: false });
ws.addEventListener('pointerdown', e => {
  if (e.target === ws) { if (tb) commitText(); else if (sel) commitSel(); }
});

/* ---------- document ---------- */
const loadURL = url => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
// Opening or starting a picture replaces the document, so its undo history goes too.
function openImage(src, w, h) {
  commitAll(); clearUndo();
  setSize(w, h);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H); ctx.drawImage(src, 0, 0);
  S.dirty = false; setZoom(1, [0, 0]); hint();
}
function newImage() {
  commitAll(); clearUndo();
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  S.dirty = false; showSize(); hint();
}

/* ---------- dialogs ---------- */
function dialog(title, body, buttons) {
  return new Promise(res => {
    modal++; syncState();
    const back = document.createElement('div'); back.className = 'dlg-back';
    const d = document.createElement('div'); d.className = 'dlg'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-label', title);
    const hd = document.createElement('header'); const tt = document.createElement('span'); tt.textContent = title;
    const x = document.createElement('button'); x.className = 'tbtn'; x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Close');
    hd.append(tt, x);
    const bd = document.createElement('div'); bd.className = 'body'; bd.append(body);
    const ft = document.createElement('footer');
    const done = v => { back.remove(); modal--; document.removeEventListener('keydown', onKey, true); syncState(); res(v); };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
      else if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); e.stopPropagation(); const pb = buttons.find(b => b.primary); done(pb ? pb.value : null); }
    };
    for (const b of buttons) {
      const el = document.createElement('button'); el.type = 'button'; el.className = 'btn' + (b.primary ? ' primary' : ''); el.textContent = b.label;
      el.addEventListener('click', () => done(b.value)); ft.append(el);
    }
    x.addEventListener('click', () => done(null));
    back.addEventListener('pointerdown', e => { if (e.target === back) done(null); });
    document.addEventListener('keydown', onKey, true);
    d.append(hd, bd, ft); back.append(d); document.body.append(back);
    const first = bd.querySelector('input') || ft.querySelector('.primary');
    if (first) { first.focus(); if (first.select) first.select(); }
  });
}
function numberFields(rows) {
  const box = document.createElement('div'); box.className = 'field';
  for (const r of rows) {
    const l = document.createElement('label'); l.htmlFor = r.id; l.textContent = r.label;
    const i = document.createElement('input'); i.id = r.id; i.type = 'number'; i.min = r.min; i.max = r.max; i.value = r.value; i.inputMode = 'numeric';
    const u = document.createElement('span'); u.textContent = r.unit;
    box.append(l, i, u);
  }
  return box;
}
function attributesDialog() {
  commitAll();
  const f = numberFields([{ id: 'atW', label: 'Width', value: W, min: 1, max: 8000, unit: 'pixels' }, { id: 'atH', label: 'Height', value: H, min: 1, max: 8000, unit: 'pixels' }]);
  const wrap = document.createElement('div');
  const p = document.createElement('p'); p.textContent = 'New area is filled with the background color.'; p.style.color = 'var(--muted)'; p.style.marginTop = '10px';
  wrap.append(f, p);
  dialog('Attributes', wrap, [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: null }]).then(v => {
    if (v !== 'ok') return;
    const w = Math.round(+f.querySelector('#atW').value), h = Math.round(+f.querySelector('#atH').value);
    if (!(w >= 1 && h >= 1 && w <= 8000 && h <= 8000)) { hint('Width and height must be between 1 and 8000 pixels.'); return; }
    if (w !== W || h !== H) { pushUndo(); resizeCanvas(w, h); changed(); }
  });
}
function stretchDialog() {
  const f = numberFields([{ id: 'stH', label: 'Horizontal', value: 100, min: 1, max: 500, unit: '%' }, { id: 'stV', label: 'Vertical', value: 100, min: 1, max: 500, unit: '%' }]);
  dialog('Stretch', f, [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: null }]).then(v => {
    if (v !== 'ok') return;
    const sx = +f.querySelector('#stH').value / 100, sy = +f.querySelector('#stV').value / 100;
    if (!(sx > 0 && sy > 0 && sx <= 5 && sy <= 5)) { hint('Use percentages between 1 and 500.'); return; }
    imageOp(c => stretch(c, sx, sy));
  });
}
// Menu shortcuts come from the host's menus; the rest are keys and gestures the picture handles itself.
function shortcutsDialog() {
  const mod = host.mac ? '⌘' : 'Ctrl', alt = host.mac ? 'Option' : 'Alt';
  const rows = [];
  for (const m of PaintboxMenus.forHost(host.name))
    for (const it of m.items) if (it.key) rows.push([PaintboxMenus.keyLabel(it.key, host.mac), m.title + ' ▸ ' + it.label.replace(/…$/, '')]);
  rows.push(
    ['Delete', 'Clear the selection'], ['Arrow keys', 'Nudge the selection one pixel (with Shift, ten)'],
    ['X', 'Swap foreground and background colors'], [mod + '-scroll', 'Zoom in and out'],
    ['Esc', 'Cancel the polygon or curve in progress, or place the text'],
    [host.mac ? 'Right-click or Control-click' : 'Right-click', 'Draw with the background color; erase only the foreground color'],
    ['Shift while dragging', 'Straight 45° lines, squares and circles'],
    [alt + '-drag selection', 'Leave a copy behind while moving'], ['Shift-drag selection', 'Smear copies along the way']);
  const t = document.createElement('table'); t.className = 'keys';
  for (const [k, v] of rows) { const tr = t.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = v; }
  dialog('Keyboard Shortcuts', t, [{ label: 'OK', value: null, primary: true }]);
}
function viewBitmap() {
  commitAll();
  const v = document.createElement('div'); v.className = 'viewer'; v.title = 'Click or press any key to return';
  const cc = mk(W, H); g2(cc).drawImage(cv, 0, 0); v.append(cc);
  const close = e => { e.preventDefault(); e.stopPropagation(); v.remove(); modal--; document.removeEventListener('keydown', close, true); syncState(); };
  v.addEventListener('click', close); document.addEventListener('keydown', close, true);
  document.body.append(v); modal++;
}

/* ---------- commands (from the host's menus) ---------- */
function cmd(name) {
  if (modal) return;
  switch (name) {
    case 'undo': undo(); break;
    case 'redo': redo(); break;
    case 'del': deleteSel(); break;
    case 'selectAll': selectAll(); break;
    case 'toggleTools': view.tools = !view.tools; $('#toolbox').hidden = !view.tools; break;
    case 'toggleColors': view.colors = !view.colors; $('#colorbar').hidden = !view.colors; break;
    case 'toggleStatus': view.status = !view.status; $('#status').hidden = !view.status; break;
    case 'zoomIn': zoomStep(1); break;
    case 'zoomOut': zoomStep(-1); break;
    case 'zoom1': setZoom(1); break;
    case 'zoom4': setZoom(LARGE_SIZE); break;
    case 'grid': S.grid = !S.grid; applyZoom(); hint(S.grid ? 'Grid on.' : 'Grid off.'); break;
    case 'viewBitmap': viewBitmap(); break;
    case 'fh': case 'fv': case 'r90': case 'r180': case 'r270': imageOp(c => xform(c, name)); break;
    case 'stretch': stretchDialog(); break;
    case 'invert': imageOp(invert); break;
    case 'attrs': attributesDialog(); break;
    case 'clear':
      if (sel) { deleteSel(); break; }
      commitAll(); pushUndo(); ctx.fillStyle = S.bg; ctx.fillRect(0, 0, W, H); changed(); hint('Cleared. Undo brings it back.'); break;
    case 'opaque': setSelTransparent(!S.selTransparent); renderOptions(); break;
    case 'editColors': editColor(-1); break;
    case 'swap': swapColors(); break;
    case 'resetPalette': S.palette = DEFAULT_PALETTE.slice(); buildPalette(); break;
    case 'shortcuts': shortcutsDialog(); break;
    default: throw new Error('Unknown command: ' + name);
  }
  syncState();
}

/* ---------- keyboard ---------- */
// Command- and Control-key shortcuts belong to the host's menus; only plain keys are handled here.
document.addEventListener('keydown', e => {
  if (modal || e.metaKey || e.ctrlKey) return;
  const t = e.target;
  if (t.matches('input, textarea, select')) {
    if (t === ta && e.key === 'Escape') { e.preventDefault(); commitText(); }
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') { if (sel) { e.preventDefault(); deleteSel(); } return; }
  if (e.key === 'Escape') { if (poly) { poly = null; clearOv(); } else if (curve) { curve = null; clearOv(); } else if (sel) commitSel(); hint(); return; }
  if (sel && e.key.startsWith('Arrow')) {
    e.preventDefault(); lift();
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') sel.x -= step; if (e.key === 'ArrowRight') sel.x += step;
    if (e.key === 'ArrowUp') sel.y -= step; if (e.key === 'ArrowDown') sel.y += step;
    placeSel(); return;
  }
  if (e.key.toLowerCase() === 'x' && !e.altKey) swapColors();
});

/* ---------- host bridge ---------- */
const isEditingText = () => !!document.activeElement && document.activeElement.matches('input, textarea');
// The flags the host's menus are enabled and checked by (see shared/menus.js).
const LINKS = PaintboxLink.available();
function pageState() {
  return {
    canUndo: undoS.length > 0 || !!(sel || tb || poly || curve), canRedo: redoS.length > 0, hasSelection: !!sel,
    dirty: S.dirty, grid: S.grid, gridAvailable: zoom >= GRID_MIN_ZOOM, actualSize: zoom === 1, largeSize: zoom === LARGE_SIZE,
    opaque: !S.selTransparent, toolBox: view.tools, colorBox: view.colors, statusBar: view.status,
    editingText: isEditingText(), modal: modal > 0, linksAvailable: LINKS
  };
}
// Tells the host when the state changed. Coalesced, and sent only when something changed.
let syncQueued = false, lastState = '';
function syncState() {
  if (syncQueued) return;
  syncQueued = true;
  setTimeout(() => {
    syncQueued = false;
    const st = pageState(), json = JSON.stringify(st);
    if (json !== lastState) { lastState = json; host.stateChanged(st); }
  }, 0);
}
for (const type of ['pointerdown', 'pointerup', 'keydown', 'keyup', 'focusin', 'focusout']) document.addEventListener(type, syncState, true);

// Pictures come in as URLs (data: from the Mac app, blob: from the browser), which resolve to whether it worked, or
// as ImageData. picture() hands out ImageData too.
const app = window.paintbox = {
  cmd,
  state: pageState,
  hint,
  dialog,
  isEditingText,
  exportImage(type) { commitAll(); syncState(); return cv.toDataURL(type, 0.92); },
  copySelection(cut) { const c = copySel(cut); syncState(); return c && c.toDataURL('image/png'); },
  pasteURL(url) { return loadURL(url).then(img => { pasteCanvas(img); return true; }, () => { hint('Could not read the pasted picture.'); return false; }); },
  openURL(url) { return loadURL(url).then(img => { openImage(img, img.naturalWidth, img.naturalHeight); syncState(); return true; }, () => { hint('Could not open that picture.'); return false; }); },
  picture() { commitAll(); syncState(); return ctx.getImageData(0, 0, W, H); },
  openPicture(img) { const c = mk(img.width, img.height); g2(c).putImageData(img, 0, 0); openImage(c, c.width, c.height); syncState(); },
  newImage() { newImage(); syncState(); },
  markSaved() { S.dirty = false; syncState(); },
  setEditedColor
};

/* ---------- boot ---------- */
buildTools(); buildPalette(); showColors();
{
  const w0 = Math.max(160, Math.min(800, ws.clientWidth - 30)), h0 = Math.max(120, Math.min(560, ws.clientHeight - 30));
  setSize(w0, h0); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
}
selectTool('pencil');
// The host reads the first state in start; after that it hears only of changes.
lastState = JSON.stringify(pageState());
host.start(app);
})();
