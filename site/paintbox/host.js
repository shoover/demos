/* Paintbox in a web browser: draws the window's title bar and menu bar from the shared menus, opens pictures
   that are chosen or dropped, saves by downloading PNG or JPEG files, shares pictures as links,
   and uses the browser's clipboard and color picker. */
window.paintboxHost = (() => {
'use strict';
const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
const MAC = /Mac|iPhone|iPad/.test(navigator.userAgentData ? navigator.userAgentData.platform : navigator.platform);
const MENUS = PaintboxMenus.forHost('web');
const keyLabel = spec => PaintboxMenus.keyLabel(spec, MAC);
// Commands a focused text field (the text tool, a dialog's fields) takes for itself.
const EDIT = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
const FORMATS = [{ name: 'PNG', type: 'image/png', ext: 'png' }, { name: 'JPEG', type: 'image/jpeg', ext: 'jpg' }];
let app = null;
// The open picture: its name without extension, the format to save it in, and whether it has been named (by
// opening a file Paintbox can write, or by saving). Save asks for a name first, like Save As.
const doc = { name: 'untitled', format: FORMATS[0], named: false };

/* ---------- window chrome ---------- */
const titleEl = el('div', 'name');
const fsBtn = el('button', 'tbtn');
{
  const icon = el('canvas'); icon.width = icon.height = 16; icon.setAttribute('aria-hidden', 'true');
  drawIcon(icon.getContext('2d'), 'brush');
  fsBtn.type = 'button'; fsBtn.title = 'Full screen'; fsBtn.setAttribute('aria-label', 'Full screen');
  fsBtn.innerHTML = '<svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true"><rect x="0.5" y="0.5" width="8" height="8" fill="none" stroke="currentColor"/><rect width="9" height="2" fill="currentColor"/></svg>';
  // Phones' browsers can't put a page in full screen.
  fsBtn.hidden = !document.documentElement.requestFullscreen;
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(err => app.hint('Full screen is not available: ' + err.message));
  });
  const bar = el('div', 'titlebar'); bar.append(icon, titleEl, fsBtn);
  const menubar = el('nav', 'menubar'); menubar.id = 'menubar'; menubar.setAttribute('aria-label', 'Menu bar');
  $('#win').prepend(bar, menubar);
}
function updateTitle(dirty) { titleEl.textContent = document.title = doc.name + (dirty ? '*' : '') + ' - Paintbox'; }

/* ---------- menus ---------- */
const flag = (st, k) => { if (!(k in st)) throw new Error('Page state lacks ' + k); return st[k]; };
function enabled(it, st) {
  if (st.modal) return false;
  if (st.editingText && EDIT.has(it.cmd)) return true;
  return !it.enabled || flag(st, it.enabled);
}
let openIdx = -1, openItems = [];
const tops = MENUS.map((m, idx) => {
  const wrap = el('div', 'mwrap'), b = el('button', 'mtop', m.title);
  b.type = 'button'; b.setAttribute('aria-haspopup', 'true'); b.setAttribute('aria-expanded', 'false');
  // Opening a menu leaves the focus where it was, so Edit commands still reach the text being typed.
  b.addEventListener('pointerdown', e => e.preventDefault());
  b.addEventListener('click', () => { if (openIdx === idx) closeMenus(); else showMenu(idx); });
  b.addEventListener('pointerenter', () => { if (openIdx >= 0 && openIdx !== idx) showMenu(idx); });
  b.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown') return;
    e.preventDefault(); showMenu(idx);
    const first = openItems.find(o => !o.btn.disabled); if (first) first.btn.focus();
  });
  wrap.append(b); $('#menubar').append(wrap);
  return { wrap, b };
});
function showMenu(idx) {
  closeMenus(); openIdx = idx;
  const { wrap, b } = tops[idx], m = el('div', 'menu');
  m.setAttribute('role', 'menu'); b.setAttribute('aria-expanded', 'true');
  for (const it of MENUS[idx].items) {
    if (it.separator) { m.append(el('div', 'msep')); continue; }
    const btn = el('button', 'mi'), mark = el('span');
    btn.type = 'button'; btn.setAttribute('role', it.checked ? 'menuitemcheckbox' : 'menuitem');
    btn.append(mark, el('span', null, it.label), el('span', 'key', it.key ? keyLabel(it.key) : ''));
    btn.addEventListener('pointerdown', e => e.preventDefault());
    btn.addEventListener('click', () => { closeMenus(); run(it.cmd); });
    openItems.push({ it, btn, mark }); m.append(btn);
  }
  m.addEventListener('keydown', e => {
    const list = openItems.filter(o => !o.btn.disabled).map(o => o.btn), i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenus(); b.focus(); }
  });
  wrap.append(m); refreshMenu(app.state());
  const r = m.getBoundingClientRect(), vw = document.documentElement.clientWidth;
  if (r.right > vw - 8) m.style.left = Math.min(0, vw - 8 - r.right) + 'px';
}
function refreshMenu(st) {
  for (const { it, btn, mark } of openItems) {
    btn.disabled = !enabled(it, st);
    if (it.checked) { const on = flag(st, it.checked); mark.textContent = on ? '✓' : ''; btn.setAttribute('aria-checked', String(on)); }
  }
}
function closeMenus() {
  if (openIdx < 0) return;
  tops[openIdx].b.setAttribute('aria-expanded', 'false');
  tops[openIdx].wrap.querySelector('.menu').remove();
  openIdx = -1; openItems = [];
}
document.addEventListener('pointerdown', e => { if (!e.target.closest('#menubar')) closeMenus(); });

/* ---------- commands ---------- */
const OWN = {
  new() { confirmDiscard().then(ok => { if (ok) { app.newImage(); setDoc('untitled', FORMATS[0], false); } }); },
  open() { confirmDiscard().then(ok => { if (ok) fileIn.click(); }); },
  save() { save(false); },
  saveAs() { save(true); },
  openLink: openLinkDialog,
  copyLink,
  cut() { copy(true); },
  copy() { copy(false); },
  paste,
  about
};
function run(cmd) {
  if (app.isEditingText() && EDIT.has(cmd)) editText(cmd);
  else if (OWN[cmd]) OWN[cmd]();
  else app.cmd(cmd);
}
// The menus edit a focused text field the way its own shortcuts would.
function editText(cmd) {
  if (cmd !== 'paste') { document.execCommand(cmd); return; }
  navigator.clipboard.readText().then(t => document.execCommand('insertText', false, t),
    err => app.hint('Could not read the clipboard: ' + err.message));
}
function setDoc(name, format, named) {
  doc.name = name; doc.format = format; doc.named = named;
  updateTitle(app.state().dirty);
}
// Asks to save unsaved changes; resolves to whether it is fine to go on and replace the picture.
function confirmDiscard() {
  if (!app.state().dirty) return Promise.resolve(true);
  return app.dialog('Paintbox', el('p', null, 'Save changes to ' + doc.name + '?'), [
    { label: 'Save', value: 'save', primary: true }, { label: 'Don’t Save', value: 'discard' }, { label: 'Cancel', value: null }
  ]).then(v => v === 'save' ? save(false) : v === 'discard');
}

/* ---------- files ---------- */
const fileIn = el('input'); fileIn.type = 'file'; fileIn.accept = 'image/*'; fileIn.hidden = true;
document.body.append(fileIn);
fileIn.addEventListener('change', () => { const f = fileIn.files[0]; fileIn.value = ''; if (f) openFile(f); });
function openFile(file) {
  if (!file.type.startsWith('image/')) { app.hint(file.name + ' is not a picture.'); return; }
  const url = URL.createObjectURL(file);
  app.openURL(url).then(ok => {
    URL.revokeObjectURL(url);
    if (!ok) return;
    const format = FORMATS.find(f => f.type === file.type);
    setDoc(file.name.replace(/\.[^.]+$/, ''), format || FORMATS[0], !!format);
  });
}
document.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
document.addEventListener('drop', e => {
  if (!e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) confirmDiscard().then(ok => { if (ok) openFile(f); });
});
// Resolves to whether the picture was saved.
function save(asking) {
  if (asking || !doc.named) return saveAsDialog().then(c => c ? download(c.name, c.format) : false);
  return download(doc.name, doc.format);
}
function download(name, format) {
  return fetch(app.exportImage(format.type)).then(r => r.blob()).then(blob => {
    const a = el('a'), file = name + '.' + format.ext;
    a.href = URL.createObjectURL(blob); a.download = file;
    document.body.append(a); a.click(); a.remove();
    // The browser reads the file after click() returns, so the URL has to outlive this call.
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    setDoc(name, format, true); app.markSaved(); app.hint('Saved ' + file + ' to your downloads.');
    return true;
  });
}
function saveAsDialog() {
  const box = el('div', 'saveas');
  const nameL = el('label', null, 'File name'), name = el('input'), typeL = el('label', null, 'Save as type'), type = el('select');
  name.id = nameL.htmlFor = 'saName'; name.type = 'text'; name.value = doc.name; name.spellcheck = false;
  type.id = typeL.htmlFor = 'saType';
  FORMATS.forEach((f, i) => { const o = el('option', null, f.name + ' (*.' + f.ext + ')'); o.value = i; type.append(o); });
  type.value = FORMATS.indexOf(doc.format);
  box.append(nameL, name, typeL, type);
  return app.dialog('Save As', box, [{ label: 'Save', value: 'ok', primary: true }, { label: 'Cancel', value: null }]).then(v => {
    if (v !== 'ok') return null;
    // A typed extension picks the format, as in Paint.
    const typed = name.value.trim(), m = typed.match(/\.(png|jpe?g)$/i);
    const format = m ? FORMATS[/png/i.test(m[1]) ? 0 : 1] : FORMATS[+type.value];
    const base = m ? typed.slice(0, -m[0].length) : typed;
    if (!base) { app.hint('Type a file name to save the picture.'); return null; }
    return { name: base, format };
  });
}

/* ---------- links (shared/link.js) ---------- */
const addressBase = () => location.href.replace(/#.*$/, '');
const linkFailed = err => { if (!(err instanceof PaintboxLink.LinkError)) throw err; app.hint(err.message); };
function openLink(text) {
  return PaintboxLink.read(text).then(img => { app.openPicture(img); setDoc('untitled', FORMATS[0], false); }, linkFailed);
}
// Whether Paste takes text as a link: one to a picture, in a browser that can read links.
const pastableLink = text => app.state().linksAvailable && PaintboxLink.isLink(text);
// Paste opens a link on the clipboard, as Open Link would.
function pasteLink(text) {
  confirmDiscard().then(ok => ok && openLink(text));
}
function openLinkDialog() {
  confirmDiscard().then(ok => {
    if (!ok) return null;
    const body = el('div'), box = el('div', 'field link'), label = el('label', null, 'Link'), input = el('input');
    input.id = 'linkText'; input.type = 'url'; input.spellcheck = false; label.htmlFor = input.id;
    box.append(label, input);
    body.append(el('p', null, 'Paste a link to a Paintbox picture, from this page or from Paintbox for Mac.'), box);
    return app.dialog('Open Link', body, [{ label: 'Open', value: true, primary: true }, { label: 'Cancel', value: null }])
      .then(v => v && openLink(input.value));
  });
}
// A link in the address opens its picture, which then leaves the address so it can't go stale with the first change.
function openAddress() {
  const hash = location.hash;
  history.replaceState(history.state, '', addressBase());
  openLink(hash);
}
// Safari takes the clipboard only during the click, so the clipboard item waits on the link being made.
function copyLink() {
  if (!clipboardWrites()) { app.hint('This browser can’t put a link on the clipboard.'); return; }
  const link = PaintboxLink.write(app.picture(), addressBase());
  navigator.clipboard.write([new ClipboardItem({ 'text/plain': link.then(url => new Blob([url], { type: 'text/plain' })) })]).then(
    () => app.hint('Copied a link to this picture.'),
    err => link.then(() => app.hint('Could not copy the link: ' + err.message), linkFailed));
}
// A link pasted into the address bar of a page that is already open.
window.addEventListener('hashchange', () => {
  if (!location.hash) return;
  confirmDiscard().then(ok => { if (ok) openAddress(); else history.replaceState(history.state, '', addressBase()); });
});

/* ---------- clipboard ---------- */
// Browsers hand pictures to the clipboard only through the asynchronous Clipboard API.
const clipboardWrites = () => !!(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem);
function copy(cut) {
  if (!clipboardWrites()) { app.hint('This browser can’t put pictures on the clipboard.'); return; }
  const url = app.copySelection(cut);
  if (!url) return;
  navigator.clipboard.write([new ClipboardItem({ 'image/png': fetch(url).then(r => r.blob()) })])
    .catch(err => app.hint('Could not copy to the clipboard: ' + err.message));
}
function pasteBlob(blob) {
  const url = URL.createObjectURL(blob);
  app.pasteURL(url).then(() => URL.revokeObjectURL(url));
}
// The Paste command has to ask for the clipboard; the paste shortcut gets it with the paste event. A picture
// pastes into this one; a link to a picture opens it.
const NOTHING_TO_PASTE = 'There is no picture or link to a picture on the clipboard.';
function paste() {
  const viaKey = 'Press ' + keyLabel('Mod+V') + ' to paste.';
  if (!(navigator.clipboard && navigator.clipboard.read)) { app.hint(viaKey); return; }
  navigator.clipboard.read().then(items => {
    for (const it of items) {
      const type = it.types.find(t => t.startsWith('image/'));
      if (type) return it.getType(type).then(pasteBlob);
    }
    const text = items.find(it => it.types.includes('text/plain'));
    if (!text) { app.hint(NOTHING_TO_PASTE); return; }
    return text.getType('text/plain').then(b => b.text()).then(t => {
      if (pastableLink(t)) pasteLink(t); else app.hint(NOTHING_TO_PASTE);
    });
  }, () => app.hint('The browser didn’t allow reading the clipboard. ' + viaKey));
}
document.addEventListener('paste', e => {
  if (app.isEditingText() || app.state().modal) return;
  e.preventDefault();
  const item = [...e.clipboardData.items].find(i => i.kind === 'file' && i.type.startsWith('image/'));
  const text = e.clipboardData.getData('text/plain');
  if (item) pasteBlob(item.getAsFile());
  else if (pastableLink(text)) pasteLink(text);
  else app.hint(NOTHING_TO_PASTE);
});

/* ---------- keyboard ---------- */
const SHORTCUTS = [];
for (const m of MENUS) for (const it of m.items) {
  if (!it.key) continue;
  const parts = it.key.split('+'), key = parts.pop();
  SHORTCUTS.push({ cmd: it.cmd, key: key.length === 1 ? key.toUpperCase() : key,
    mod: parts.includes('Mod'), shift: parts.includes('Shift'), alt: parts.includes('Alt'), ctrl: parts.includes('Ctrl') });
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && openIdx >= 0) { closeMenus(); return; }
  const st = app.state();
  if (st.modal) return;
  // Off the Mac, Control is the menu shortcut key. Shift only counts for letters and digits: on other keys it
  // makes the character (? is Shift-/).
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key, letter = /^[A-Z0-9]$/.test(k);
  const mod = MAC ? e.metaKey : e.ctrlKey, ctrl = MAC && e.ctrlKey;
  const hit = SHORTCUTS.find(s => s.key === k && s.mod === mod && s.ctrl === ctrl && s.alt === e.altKey && (!letter || s.shift === e.shiftKey));
  // Pasting reads the clipboard in the paste event that follows the shortcut.
  if (!hit || hit.cmd === 'paste') return;
  if (st.editingText && EDIT.has(hit.cmd)) return;
  e.preventDefault(); closeMenus(); run(hit.cmd);
});

/* ---------- colors ---------- */
const colorIn = el('input', 'offscreen'); colorIn.type = 'color'; colorIn.tabIndex = -1; colorIn.setAttribute('aria-hidden', 'true');
document.body.append(colorIn);
colorIn.addEventListener('input', () => app.setEditedColor(colorIn.value));

function about() {
  const b = el('div');
  b.append(el('div', 'about-mark', 'Paintbox'),
    el('p', null, 'A bitmap paint program in the classic style: sixteen tools, a 28-color palette, hard-edged pixels and no anti-aliasing.'),
    el('p', null, 'Pictures stay on this computer. Open reads a file you choose; Save downloads one. File ▸ Copy Link copies a link that holds the picture, in a part of the address browsers don’t send to the server, and File ▸ Open Link opens one, including links from Paintbox for Mac.'));
  app.dialog('About Paintbox', b, [{ label: 'OK', value: null, primary: true }]);
}

window.addEventListener('beforeunload', e => { if (app.state().dirty) e.preventDefault(); });

return {
  name: 'web',
  mac: MAC,
  start(a) { app = a; updateTitle(false); if (location.hash) openAddress(); },
  stateChanged(st) { updateTitle(st.dirty); if (openIdx >= 0) refreshMenu(st); },
  editColor(color) { colorIn.value = color; colorIn.showPicker(); }
};
})();
