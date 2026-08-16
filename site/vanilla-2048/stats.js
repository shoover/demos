/**
 * The game as a graph reads it: the timeline and its undo tallies, binned along an axis
 * of moves.
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
 * Bin a timeline into at most `maxBins` columns along the moves axis.
 *
 * Two series come out of each bin, because two different questions are being asked of
 * the same span of moves. Points are a running total, so the bin's figure is the highest
 * it reached -- taking anything else would draw a line that dips where the game only ever
 * climbed. Undos are events, so the bin's figure is how many times play was taken back
 * inside it; summing is the only reading that survives a bin holding twenty moves.
 *
 * Bins are contiguous and every one of them holds at least one state: the timeline's
 * states are one move apart, so a span of moves cannot have a hole in it. Nothing here
 * has to draw around a bin that has no data.
 *
 * `undos` is keyed by the move play resumed at, which board.js guarantees is a move the
 * timeline still carries. A key outside it is a bug in that guarantee rather than a shape
 * to absorb, so it throws.
 */
export function binGame(timeline, undos, maxBins = MAX_BINS) {
  if (timeline.length === 0) {
    throw new Error("Cannot graph an empty 2048 timeline");
  }
  if (!Number.isSafeInteger(maxBins) || maxBins < 1) {
    throw new Error(`Invalid 2048 graph bin count: ${maxBins}`);
  }

  const firstMove = timeline[0].moves;
  const lastMove = timeline[timeline.length - 1].moves;
  // Inclusive of both ends: the opening board is move 0 and is a column of the graph like
  // any other -- it is where the points line starts from.
  const span = lastMove - firstMove + 1;
  const width = Math.ceil(span / maxBins);
  const bins = Array.from({ length: Math.ceil(span / width) }, (unused, index) => ({
    from: firstMove + index * width,
    to: Math.min(lastMove, firstMove + (index + 1) * width - 1),
    points: 0,
    undos: 0,
  }));

  const binOf = (move) => {
    if (move < firstMove || move > lastMove) {
      throw new Error(`2048 move ${move} is outside the timeline being graphed`);
    }
    return bins[Math.floor((move - firstMove) / width)];
  };

  for (const state of timeline) {
    const bin = binOf(state.moves);
    bin.points = Math.max(bin.points, state.score);
  }
  for (const [move, undone] of undos) {
    binOf(move).undos += undone;
  }

  return {
    bins,
    firstMove,
    lastMove,
    binWidth: width,
    // The two scales the graph is drawn against, and the one figure worth saying in
    // words: what the game is worth is already on the score line, how often it has been
    // taken back is not anywhere else.
    maxPoints: Math.max(...bins.map((bin) => bin.points)),
    maxUndos: Math.max(...bins.map((bin) => bin.undos)),
    totalUndos: bins.reduce((sum, bin) => sum + bin.undos, 0),
  };
}
