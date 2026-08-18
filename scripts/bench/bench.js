
/* Bench ---------------------------------------------------------------------- */

/**
 * The states this page exists to look at, and the one thing the demo cannot do for
 * itself: put a board that takes a thousand moves to reach on screen in one click.
 *
 * Each preset is a real save, decoded by the real validator into the real Game, and the
 * line above it is painted by the same two formatters the demo ships. Nothing here
 * reaches around any of that -- a state this rejects is a state the demo would reject
 * too, which is most of what makes the bench worth having.
 *
 * They are written into the live game rather than into storage and a reload, so the
 * bench still works where site data is blocked, which is exactly what an artifact frame
 * is. This file is appended to the concatenated modules, so the game it assigns to is
 * the module-scope one the frame loop reads.
 */
const BENCH_STATES = [
  {
    chip: "Fresh",
    note: "A new game. Nothing has been reached yet, so the best pair reads zero.",
    bests: { best: 0, replayedBest: 0, bestTile: 0, replayedBestTile: 0 },
    board: null,
  },
  {
    chip: "12k·1024",
    note: "Mid game, played straight through — the line's ordinary reading.",
    bests: { best: 12040, replayedBest: 0, bestTile: 1024, replayedBestTile: 0 },
    board: [
      [2, 4, 8, 16],
      [1024, 512, 256, 128],
      [2, 4, 8, 16],
      [0, 2, 4, 8],
    ],
    score: 12040,
    moves: 640,
    seconds: 1284,
  },
  {
    chip: "205k·4096*",
    note:
      "Played on from move 84, so the game carries the asterisk. The clean track it " +
      "forked from is the headline best; the replayed track it scores into is the " +
      "pair in the bracket, marked the same way the game is.",
    bests: { best: 200000, replayedBest: 205000, bestTile: 2048, replayedBestTile: 4096 },
    board: [
      [4096, 2048, 1024, 512],
      [8, 16, 32, 64],
      [4, 2, 8, 16],
      [0, 4, 2, 8],
    ],
    score: 205000,
    moves: 512,
    replayedFrom: 84,
    seconds: 5310,
  },
  {
    chip: "Widest",
    note:
      "Every figure at its longest at once. Past anything a real game reaches — it is " +
      "the save format's own ceiling, and the case the line is sized against: it must " +
      "not wrap, because the board is sized from what two header lines leave over.",
    bests: {
      best: 99999999,
      replayedBest: 99999999,
      bestTile: 8192,
      replayedBestTile: 8192,
    },
    board: [
      [8192, 4096, 2048, 1024],
      [512, 256, 128, 64],
      [32, 16, 8, 4],
      [2, 0, 2, 4],
    ],
    score: 99999999,
    moves: 9999,
    replayedFrom: 1234,
    seconds: 45296,
  },
];

/** One preset, in the shape the save format writes -- and the validator reads back. */
function benchSave(state) {
  return JSON.stringify({
    version: STATE_VERSION,
    timeline: [
      {
        board: state.board,
        score: state.score,
        moves: state.moves,
        game_over: false,
        direction: null,
      },
    ],
    // A one-state timeline is a timeline: its history opens on the move it holds and has
    // no gains after it, which is what a save trimmed to its newest state looks like.
    history: { from: state.moves, score: state.score, gains: [] },
    cursor: 0,
    replayed_from: state.replayedFrom ?? null,
    play_seconds: state.seconds,
  });
}

/**
 * Put a preset on screen, in place of whatever was being played.
 *
 * The panel's message line is left alone: it belongs to the game, the strip above
 * already says what was loaded, and saying it twice cost the board a third of a phone
 * screen.
 */
function loadBenchState(state) {
  landSlide();
  setTimelineOpen(false);
  game = new Game(state.bests);
  if (state.board === null) {
    const spawned = game.reset();
    playTime.set(0, false);
    repaint({ appeared: new Set(spawned) });
  } else {
    game.restore(decodeSavedState(benchSave(state), state.bests));
    playTime.set(state.seconds, false);
    repaint();
  }
  // The header grew a strip, so the board has less room than it was last measured for.
  resizeBoard();
}

const bench = document.getElementById("bench");
const benchStates = document.getElementById("bench-states");
const benchNote = document.getElementById("bench-note");
const benchButtons = BENCH_STATES.map((state) => {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = state.chip;
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", () => {
    loadBenchState(state);
    for (const other of benchButtons) {
      other.setAttribute("aria-pressed", String(other === button));
    }
    benchNote.textContent = state.note;
  });
  return button;
});
benchStates.replaceChildren(...benchButtons);

/**
 * The image the Share button makes, shown in the page instead of handed over.
 *
 * The demo's own button has nowhere to put the file inside an artifact frame, which
 * grants a page neither a download nor the Web Share API. The image is worth having here
 * regardless: it is drawn from the score line's own text, so it is where the line gets
 * checked against a canvas rather than against the DOM.
 */
const benchImage = document.getElementById("bench-image");
const benchImageFrame = document.getElementById("bench-image-frame");
const benchImageClose = document.getElementById("bench-image-close");

function closeBenchImage() {
  benchImage.hidden = true;
  benchImageFrame.querySelector("canvas")?.remove();
}

const benchShare = document.createElement("button");
benchShare.type = "button";
benchShare.textContent = "Share image";
benchShare.addEventListener("click", () => {
  const canvas = renderShareImage();
  // Drawn at SHARE_SCALE for a phone screen, so it is shown at the size it was composed
  // at rather than at its pixel count.
  canvas.style.width = `${canvas.width / SHARE_SCALE}px`;
  benchImageFrame.querySelector("canvas")?.remove();
  benchImageFrame.append(canvas);
  benchImage.hidden = false;
  benchImageClose.focus();
});
benchStates.append(benchShare);

benchImageClose.addEventListener("click", closeBenchImage);
benchImage.addEventListener("click", (event) => {
  if (event.target === benchImage) {
    closeBenchImage();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !benchImage.hidden) {
    closeBenchImage();
  }
});

document.querySelector("header").append(bench);
bench.hidden = false;
