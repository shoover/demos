/* Paintbox's menus, shared by the hosts: the Mac app builds its menu bar from them and the web page draws its own.
   Each item names a command. A host runs the commands it owns (files, the clipboard) and sends the rest to
   paintbox.cmd. `enabled` and `checked` name flags of the page state (pageState in paintbox.js); every item is
   disabled while a dialog is open. `key` is the shortcut, Mod meaning Command on a Mac and Control elsewhere;
   `webKey` replaces it in a browser, which keeps some shortcuts for itself (null: none). `only` limits an item
   to one host. */
window.PaintboxMenus = (() => {
'use strict';
const MENUS = [
  ['File', [
    { label: 'New', cmd: 'new', key: 'Mod+N', webKey: null },
    { label: 'Open…', cmd: 'open', key: 'Mod+O' },
    { label: 'Open Link…', cmd: 'openLink', enabled: 'linksAvailable' },
    '-',
    { label: 'Close', cmd: 'close', key: 'Mod+W', only: 'mac' },
    { label: 'Save', cmd: 'save', key: 'Mod+S' },
    { label: 'Save As…', cmd: 'saveAs', key: 'Mod+Shift+S' },
    '-',
    { label: 'Copy Link', cmd: 'copyLink', enabled: 'linksAvailable' }]],
  ['Edit', [
    { label: 'Undo', cmd: 'undo', key: 'Mod+Z', enabled: 'canUndo' },
    { label: 'Redo', cmd: 'redo', key: 'Mod+Shift+Z', enabled: 'canRedo' },
    '-',
    { label: 'Cut', cmd: 'cut', key: 'Mod+X', enabled: 'hasSelection' },
    { label: 'Copy', cmd: 'copy', key: 'Mod+C', enabled: 'hasSelection' },
    { label: 'Paste', cmd: 'paste', key: 'Mod+V' },
    { label: 'Clear Selection', cmd: 'del', enabled: 'hasSelection' },
    { label: 'Select All', cmd: 'selectAll', key: 'Mod+A' }]],
  ['View', [
    { label: 'Tool Box', cmd: 'toggleTools', key: 'Mod+T', webKey: null, checked: 'toolBox' },
    { label: 'Color Box', cmd: 'toggleColors', key: 'Mod+L', webKey: null, checked: 'colorBox' },
    { label: 'Status Bar', cmd: 'toggleStatus', checked: 'statusBar' },
    '-',
    { label: 'Zoom In', cmd: 'zoomIn', key: 'Mod+=' },
    { label: 'Zoom Out', cmd: 'zoomOut', key: 'Mod+-' },
    { label: 'Actual Size', cmd: 'zoom1', key: 'Mod+0', checked: 'actualSize' },
    { label: 'Large Size', cmd: 'zoom4', checked: 'largeSize' },
    '-',
    { label: 'Show Grid', cmd: 'grid', key: 'Mod+G', enabled: 'gridAvailable', checked: 'grid' },
    { label: 'View Bitmap', cmd: 'viewBitmap', key: 'Mod+F' },
    '-',
    { label: 'Enter Full Screen', cmd: 'fullScreen', key: 'Ctrl+Mod+F', only: 'mac' }]],
  ['Image', [
    { label: 'Flip Horizontal', cmd: 'fh' },
    { label: 'Flip Vertical', cmd: 'fv' },
    { label: 'Rotate 90° Right', cmd: 'r90' },
    { label: 'Rotate 180°', cmd: 'r180' },
    { label: 'Rotate 90° Left', cmd: 'r270' },
    '-',
    { label: 'Stretch…', cmd: 'stretch' },
    { label: 'Invert Colors', cmd: 'invert', key: 'Mod+I' },
    { label: 'Attributes…', cmd: 'attrs', key: 'Mod+E' },
    { label: 'Clear Image', cmd: 'clear', key: 'Mod+Shift+N', webKey: null },
    '-',
    { label: 'Draw Opaque', cmd: 'opaque', checked: 'opaque' }]],
  ['Colors', [
    { label: 'Edit Colors…', cmd: 'editColors' },
    { label: 'Swap Colors', cmd: 'swap' },
    { label: 'Reset Palette', cmd: 'resetPalette' }]],
  ['Help', [
    { label: 'Keyboard Shortcuts', cmd: 'shortcuts', key: 'Mod+?' },
    { label: 'About Paintbox', cmd: 'about', only: 'web' }]]
];
const HOSTS = ['mac', 'web'];

// The menus as one host shows them: [{ title, items: [{ label, cmd, key, enabled, checked } | { separator: true }] }].
function forHost(host) {
  if (!HOSTS.includes(host)) throw new Error('Unknown host: ' + host);
  return MENUS.map(([title, items]) => {
    const out = [];
    for (const it of items) {
      if (it === '-') { if (out.length && !out[out.length - 1].separator) out.push({ separator: true }); continue; }
      if (it.only && it.only !== host) continue;
      const key = host === 'web' && 'webKey' in it ? it.webKey : it.key;
      out.push({ label: it.label, cmd: it.cmd, key: key || null, enabled: it.enabled || null, checked: it.checked || null });
    }
    if (out.length && out[out.length - 1].separator) out.pop();
    return { title, items: out };
  });
}

// A shortcut as a person reads it: ⇧⌘S on a Mac, Ctrl+Shift+S elsewhere.
// Each in its platform's order: ⌃⌥⇧⌘ on a Mac, Ctrl+Alt+Shift elsewhere.
const MAC_MODS = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' };
const PC_MODS = { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
function keyLabel(spec, mac) {
  const parts = spec.split('+'), key = parts.pop(), names = mac ? MAC_MODS : PC_MODS;
  const mods = Object.keys(names).filter(m => parts.includes(m));
  if (mods.length !== parts.length) throw new Error('Bad shortcut: ' + spec);
  const k = key.length === 1 ? key.toUpperCase() : key;
  return mac ? mods.map(m => names[m]).join('') + k : [...mods.map(m => names[m]), k].join('+');
}

return { forHost, keyLabel };
})();
