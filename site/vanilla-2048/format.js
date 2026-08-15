/**
 * Pure text formatting for the numbers game.js paints into the status lines.
 *
 * Touches neither the DOM nor storage, so it runs -- and is tested -- under plain
 * node, the same way board.js's rules do.
 */

export const count = (value) => value.toLocaleString("en-US");

// The score line's own numbers, short enough that the line never wraps: a comma-grouped
// score can run to eight digits once a game has been replayed past a high best, and at
// that length the panel is narrower than the line on anything but a wide desktop. One
// decimal place, dropped when it would just be a trailing zero, is what keeps "10.1k"
// short and "10M" from reading as "10.0M".
const UNITS = [
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "k"],
];

export const abbreviate = (value) => {
  for (let i = 0; i < UNITS.length; i++) {
    const [threshold, suffix] = UNITS[i];
    if (value < threshold) {
      continue;
    }
    const scaled = Math.round((value / threshold) * 10) / 10;
    // A value close enough beneath a unit's threshold rounds up to 1000 of it -- 999999
    // reads as "1M", not "1000k" -- so a scaled value that hits that carries up to the
    // next unit rather than being printed as-is.
    if (scaled >= 1000 && i > 0) {
      const [biggerThreshold, biggerSuffix] = UNITS[i - 1];
      return `${Math.round((value / biggerThreshold) * 10) / 10}${biggerSuffix}`;
    }
    return `${scaled}${suffix}`;
  }
  return String(value);
};
