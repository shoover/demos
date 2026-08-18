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

// A clock reading, not a rollover into days: minutes and seconds stay two digits, and
// the hour just keeps growing past 99 rather than folding into a unit the score line's
// own abbreviate() would use. A stopwatch, not a score.
const pad2 = (value) => String(value).padStart(2, "0");

export const formatDuration = (totalSeconds) => {
  // Floored, not rounded: a stopwatch reads 0:00 through the whole first second, not
  // just up to its midpoint, and ticks over to 0:01 exactly when the second elapses.
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(seconds)}`
    : `${minutes}:${pad2(seconds)}`;
};

/**
 * The score line, whole: what the state on screen is worth and the largest tile it got
 * there with, then the same pair for the best game there has been.
 *
 * Two figures joined by a middot rather than two labelled fields, because a third label
 * is what the line has no room for -- "Score:" and "Best:" already share it with the
 * replayed track's bracket, and a fourth field is what pushed the move count onto a line
 * of its own in the first place. The middot rather than a slash: the line directly below
 * this one writes "Move 128/512", where the slash means "of", and the tile is not a
 * fraction of anything.
 *
 * The tile is printed in full while the score beside it is abbreviated. They are the
 * same kind of number only in the sense that both are integers: a tile is one of a dozen
 * names a player knows by sight, and "2k" is not what anyone calls the 2048 tile in the
 * game named after it. It also costs nothing to print whole -- four digits at the very
 * most, against the eight a score can run to.
 *
 * Every score on the line carries its tile, the replayed track's included: the bracket
 * holds a game, and a game is a pair here. Leaving it a bare score would have made the
 * one figure on the line that means something different from the figure beside it.
 *
 * The fields are divided by a single-spaced bar, which is what the readings line under
 * the board has always used. The pair costs the line width and this is where it comes
 * back from, but the two lines agreeing on their divider is worth having on its own --
 * the wide bar was only ever the header's own habit.
 */
export const scoreLine = ({
  score,
  topTile,
  replayed,
  best,
  bestTile,
  replayedBest,
  replayedBestTile,
}) =>
  `Score: ${abbreviate(score)}\u00b7${topTile}${replayed ? "*" : ""} | ` +
  `Best: ${abbreviate(best)}\u00b7${bestTile}` +
  (replayedBest > 0
    ? ` (${abbreviate(replayedBest)}\u00b7${replayedBestTile}*)`
    : "");

/**
 * The same reading with nothing left out, for the line's hover title: exact digits, the
 * tiles named in words rather than by position, and the one thing the line has no room
 * to say at all -- the move a replayed game was played on from.
 */
export const scoreTitle = ({
  score,
  topTile,
  replayed,
  replayedFrom,
  best,
  bestTile,
  replayedBest,
  replayedBestTile,
}) => {
  const played = replayed ? `, played on from move ${count(replayedFrom)}` : "";
  const replayedTrack =
    replayedBest > 0
      ? ` | Replayed best: ${count(replayedBest)} (top tile ${replayedBestTile})`
      : "";
  return (
    `Score: ${count(score)} (top tile ${topTile}${played}) | ` +
    `Best: ${count(best)} (top tile ${bestTile})${replayedTrack}`
  );
};
