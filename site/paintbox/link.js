/* Links to Paintbox pictures, shared by the hosts: a link holds the picture in its fragment, which browsers don't
   send to the server. Only the fragment matters, so a link from any copy of the web page, or the fragment alone,
   opens anywhere. The fragment is v1. and then base64url of these bytes, raw-deflated: the width and height (16
   bits each), the number of colors less one (8 bits), each color's red, green and blue, then the rows of pixels.
   A row packs each pixel's color number into as few bits as the colors need (1, 2, 4 or 8), starting at the high
   bits of each byte, and is stored as its difference (XOR) from the row above, as in PNG. */
window.PaintboxLink = (() => {
'use strict';
const VERSION = 'v1.';
// Firefox's longest address; Chrome takes twice that.
const MAX_ADDRESS = 2 ** 20;
const bitsFor = colors => colors <= 2 ? 1 : colors <= 4 ? 2 : colors <= 16 ? 4 : 8;
// A reason a link can't be made or read that a person can act on. Any other failure is a bug.
class LinkError extends Error {}

// Raw deflate came to WebKit with Safari 16.4, which an un-updated macOS 11 lacks.
function available() {
  try { new CompressionStream('deflate-raw'); new DecompressionStream('deflate-raw'); return true; } catch (e) { return false; }
}
const pipe = (bytes, stream) => new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer().then(b => new Uint8Array(b));
function toBase64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const fromBase64url = t => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));

// Resolves to the fragment without its #, or null when the picture has more than 256 colors.
function encode({ width, height, data }) {
  const colors = new Map(), rgb = [], idx = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < idx.length; p++, i += 4) {
    if (data[i + 3] !== 255) throw new Error('The picture has a see-through pixel at ' + p % width + ',' + Math.floor(p / width));
    const c = data[i] << 16 | data[i + 1] << 8 | data[i + 2];
    let k = colors.get(c);
    if (k === undefined) {
      if (colors.size === 256) return Promise.resolve(null);
      colors.set(c, k = colors.size); rgb.push(data[i], data[i + 1], data[i + 2]);
    }
    idx[p] = k;
  }
  const bits = bitsFor(colors.size), per = 8 / bits, rowBytes = Math.ceil(width / per), start = 5 + rgb.length;
  const bytes = new Uint8Array(start + rowBytes * height);
  bytes.set([width >> 8, width & 255, height >> 8, height & 255, colors.size - 1, ...rgb]);
  for (let y = 0, p = 0; y < height; y++)
    for (let x = 0; x < width; x++, p++) bytes[start + y * rowBytes + Math.floor(x / per)] |= idx[p] << 8 - bits - x % per * bits;
  // Back to front, so each row is XORed with the row above as it was before.
  for (let i = bytes.length - 1; i >= start + rowBytes; i--) bytes[i] ^= bytes[i - rowBytes];
  return pipe(bytes, new CompressionStream('deflate-raw')).then(z => VERSION + toBase64url(z));
}
function decode(fragment) {
  // atob throws right away, so it goes inside the chain with the failures that come later.
  return Promise.resolve(fragment.slice(VERSION.length)).then(fromBase64url).then(z => pipe(z, new DecompressionStream('deflate-raw'))).then(bytes => {
    const width = bytes[0] << 8 | bytes[1], height = bytes[2] << 8 | bytes[3], n = bytes[4] + 1, start = 5 + 3 * n;
    const bits = bitsFor(n), per = 8 / bits, rowBytes = Math.ceil(width / per), mask = (1 << bits) - 1;
    if (!width || !height || bytes.length !== start + rowBytes * height) throw new Error('Sizes don’t add up');
    for (let i = start + rowBytes; i < bytes.length; i++) bytes[i] ^= bytes[i - rowBytes];
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0, p = 0; y < height; y++) for (let x = 0; x < width; x++, p++) {
      const k = bytes[start + y * rowBytes + Math.floor(x / per)] >> 8 - bits - x % per * bits & mask;
      if (k >= n) throw new Error('A pixel has color ' + (k + 1) + ' of ' + n);
      data.set(bytes.subarray(5 + 3 * k, 8 + 3 * k), p * 4); data[p * 4 + 3] = 255;
    }
    return new ImageData(data, width, height);
  });
}

// The fragment of a link, or of a fragment on its own, with or without its #; null when it isn't a picture's.
function fragmentOf(text) {
  const t = text.trim(), i = t.indexOf('#'), f = i < 0 ? t : t.slice(i + 1);
  return f.startsWith(VERSION) ? f : null;
}
// Whether text is a link to a picture, as Paste decides. The Mac app makes the same test (isLink in main.swift).
const isLink = text => fragmentOf(text) !== null;
// Resolves to the picture in a link, or rejects with a LinkError.
function read(text) {
  const f = fragmentOf(text);
  if (!f) return Promise.reject(new LinkError('This isn’t a link to a Paintbox picture.'));
  return decode(f).catch(err => {
    // Inflating can fail with no message at all, and none of the messages are for a person.
    console.error('Paintbox link:', err);
    throw new LinkError('Could not read the picture in this link. It may have been cut short.');
  });
}
// Resolves to a link to the picture on the page at base, or rejects with a LinkError.
function write(img, base) {
  if (base.includes('#')) throw new Error('A link base has no fragment: ' + base);
  return encode(img).then(f => {
    if (!f) throw new LinkError('This picture has more than 256 colors, too many for a link. Save it to share it as a file.');
    if (base.length + 1 + f.length > MAX_ADDRESS) throw new LinkError('This picture is too detailed for a link. Save it to share it as a file.');
    return base + '#' + f;
  });
}

return { available, isLink, read, write, LinkError };
})();
