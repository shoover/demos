/**
 * The game as a graph reads it: the score history and its undo tallies, binned along an
 * axis of moves.
 *
 * Touches neither the DOM nor storage, so it runs -- and is tested -- under plain node,
 * the same way board.js's rules and format.js's numbers do. game.js draws what this
 * returns and knows nothing about how the bins were arrived at.
 */

// The axis is a few hundred pixels wide and a game runs to a thousand states, so at some
// length a bin has to hold more than one move. A hundred is where that starts: below it
// every bin is one move and the line is the game itself, and at it a bin is still a
// couple of pixels wide rather than a smear.
export const MAX_BINS = 100;

/**
 * Bin a score history into at most `maxBins` columns along the moves axis.
 *
 * Three series come out of each bin, because three different questions are being asked
 * of the same span of moves.
 *
 * Points are a running total, so the bin's figure is the highest it reached -- taking
 * anything else would draw a line that dips where the game only ever climbed.
 *
 * Gained is what was scored inside the bin, which is the same figures read as a rate
 * rather than as a level. It is a separate series and not a way of drawing the first,
 * because a total answers "what is this game worth" and can only ever climb, while a
 * gain answers "what happened here" and is the only one of the two that varies once a
 * game is long: past the opening, a total spends the rest of the game near its own peak.
 *
 * Undos are events, so the bin's figure is how many times play was taken back inside it;
 * summing is the only reading that survives a bin holding twenty moves.
 *
 * Bins are contiguous and every one of them holds at least one entry: the history's
 * entries are one move apart, so a span of moves cannot have a hole in it. Nothing here
 * has to draw around a bin that has no data.
 */
export function binGame(history, maxBins = MAX_BINS) {
  if (history.length === 0) {
    throw new Error("Cannot graph an empty 2048 history");
  }
  if (!Number.isSafeInteger(maxBins) || maxBins < 1) {
    throw new Error(`Invalid 2048 graph bin count: ${maxBins}`);
  }

  const firstMove = history[0].moves;
  const lastMove = history[history.length - 1].moves;
  // Inclusive of both ends: the opening board is move 0 and is a column of the graph like
  // any other -- it is where the points line starts from.
  const span = lastMove - firstMove + 1;
  const width = Math.ceil(span / maxBins);
  const bins = Array.from({ length: Math.ceil(span / width) }, (unused, index) => ({
    from: firstMove + index * width,
    to: Math.min(lastMove, firstMove + (index + 1) * width - 1),
    points: 0,
    gained: 0,
    undos: 0,
  }));

  // One pass: a state carries every figure a bin is made of, so there is nothing to
  // cross-reference and no way for a count to name a move the history does not hold.
  // The gain is the one figure that is not on a state by itself -- it is the difference
  // between two of them -- so it is read against the state before it, and the first
  // state of all has nothing before it to have gained anything from.
  for (const [index, state] of history.entries()) {
    const bin = bins[Math.floor((state.moves - firstMove) / width)];
    bin.points = Math.max(bin.points, state.score);
    bin.gained += index === 0 ? 0 : state.score - history[index - 1].score;
    bin.undos += state.undos;
  }

  return {
    bins,
    firstMove,
    lastMove,
    binWidth: width,
    // The three scales the graph is drawn against, and the one figure worth saying in
    // words: what the game is worth is already on the score line, how often it has been
    // taken back is not anywhere else.
    maxPoints: Math.max(...bins.map((bin) => bin.points)),
    maxGained: Math.max(...bins.map((bin) => bin.gained)),
    maxUndos: Math.max(...bins.map((bin) => bin.undos)),
    totalUndos: bins.reduce((sum, bin) => sum + bin.undos, 0),
  };
}
