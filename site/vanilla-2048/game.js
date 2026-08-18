/**
 * Everything that touches the page: painting, animation, input, and localStorage.
 * board.js holds the rules and knows nothing about any of this.
 */

import { SIZE, Game, SaveError, decodeSavedState } from "./board.js";
import { abbreviate, count, formatDuration, scoreLine, scoreTitle } from "./format.js";
import { binGame } from "./stats.js";

const BEST_SCORE_KEY = "vanilla-2048.bestScore";
// The best score reached in a game that was played on from an earlier state. A separate
// key rather than a second field beside the first, so the scores already stored under
// that one keep the meaning they were written with: every one of them was reached before
// a game could rewrite its own history, which is exactly what the clean track holds.
const BEST_REPLAYED_SCORE_KEY = "vanilla-2048.bestReplayedScore";
// The largest tile ever landed, split across the same two tracks as the scores above and
// stored the same way: a key each, beside the game rather than inside it, so a saved
// board is bounded by figures that outlive it.
const BEST_TILE_KEY = "vanilla-2048.bestTile";
const BEST_REPLAYED_TILE_KEY = "vanilla-2048.bestReplayedTile";
const GAME_STATE_KEY = "vanilla-2048.gameState.v1";

const SLIDE_MS = 100;
// The burst a tile makes on arrival, at the imgui demo's numbers: it keeps these as two
// 0.12s constants, one per kind, which happen to be equal.
const BURST_MS = 120;
const APPEAR_FROM = 0.6;
const MERGE_PEAK = 1.08;
// The next-move indicator's arrival: a longer, softer version of a tile's burst, over a
// tenth of a cell, so scrubbing reads as motion without flickering.
const INDICATOR_MS = 180;
const INDICATOR_NUDGE = 0.1;
// A held key or a hammered button must not start a move before the previous one has
// landed, so the throttle is a property of the slide rather than of any one input
// device. Every input path funnels through applyMove.
const INPUT_THROTTLE_MS = SLIDE_MS * 1.5;
const SAVE_INTERVAL_MS = 5000;
const SAVE_LATENCY_CAPACITY = 256;
const SAVE_METRICS_REFRESH_MS = 1000;
const STATS_REFRESH_MS = 250;
// Long enough that a clean window is a solid run of frames rather than a handful, short
// enough that a hitch is still on screen a moment after it was felt. Doubles as the
// longest gap that can be called a dropped frame at all, for the reason given in sample:
// thirty missed refreshes is already a different kind of problem than jank.
const FRAME_WINDOW_MS = 500;
const MIN_SWIPE_DISTANCE = 36;

// Also what the stylesheet starts --cell at, until the first measurement lands. The
// board grows to fill the smaller of the width and the height it is given, up to this.
// The cap is the imgui demo's: dropping it bought 12px on a phone, where the board was
// already within a cell's width of the screen, and only really showed up on a desktop
// window, where it made this demo's board half again the size of the one it mirrors.
const MAX_CELL = 92;
// Tiles stop shrinking here and the board is allowed to outgrow a very short viewport:
// an unreadable board is worse than a clipped one.
const MIN_CELL = 36;
const DESKTOP_GAP = 8;
const COMPACT_GAP = 6;

const GAME_OVER_MESSAGE = "No moves left. Press R or New Game.";

// Which way the board moved, in cells, for the nudge the indicator arrives with.
const DIRECTION_STEPS = new Map([
  ["up", [0, -1]], ["down", [0, 1]], ["left", [-1, 0]], ["right", [1, 0]],
]);

const elements = {
  status: document.getElementById("status"),
  panel: document.getElementById("panel"),
  main: document.querySelector("main"),
  scoreLine: document.getElementById("score-line"),
  progressLine: document.getElementById("progress-line"),
  playTimeLabel: document.getElementById("play-time"),
  help: document.getElementById("help"),
  stats: document.getElementById("stats"),
  boardWrap: document.getElementById("board-wrap"),
  board: document.getElementById("board"),
  grid: document.getElementById("grid"),
  tiles: document.getElementById("tiles"),
  overlay: document.getElementById("overlay"),
  nextMove: document.getElementById("next-move"),
  newGame: document.getElementById("new-game"),
  newGameConfirm: document.getElementById("new-game-confirm"),
  confirmNewGame: document.getElementById("confirm-new-game"),
  undo: document.getElementById("undo"),
  timeTravel: document.getElementById("time-travel"),
  timeline: document.getElementById("timeline"),
  scrubber: document.getElementById("scrubber"),
  stepBack: document.getElementById("step-back"),
  stepForward: document.getElementById("step-forward"),
  latest: document.getElementById("latest"),
  playFromHere: document.getElementById("play-from-here"),
  timelineLabel: document.getElementById("timeline-label"),
  graph: document.getElementById("graph"),
  statsPanel: document.getElementById("stats-panel"),
  chart: document.getElementById("chart"),
  chartReadout: document.getElementById("chart-readout"),
};

const compactMedia = window.matchMedia(
  document.getElementById("compact-styles").media
);

/**
 * Whether a popup is up, which is the same question as whether play is stopped.
 *
 * Two of them are opened to read something -- where the game has been, or how it got
 * there -- and the third asks whether the game may be thrown away. All three cover the
 * board they are about. Playing on underneath is a move made against a board that cannot
 * be seen, or a move added to a game being asked about, so the game waits: the clock
 * stops, the d-pad goes flat, and the board is drawn back the same way it is when the
 * past is on screen. Nothing here refuses the history controls, which are what the
 * popups are for.
 */
function popupOpen() {
  return (
    !elements.timeline.hidden ||
    !elements.statsPanel.hidden ||
    !elements.newGameConfirm.hidden
  );
}

function setStatus(text, clearAfterMs) {
  elements.status.textContent = text;
  if (clearAfterMs) {
    setTimeout(() => {
      if (elements.status.textContent === text) {
        elements.status.textContent = "";
      }
    }, clearAfterMs);
  }
}

/* Storage ------------------------------------------------------------------ */

// Reading localStorage throws outright where site data is blocked -- a sandboxed
// iframe, Safari with cross-site storage off. Falling back to memory keeps the game
// playable there; it just forgets the board between reloads.
const storage = (() => {
  try {
    const probe = `${GAME_STATE_KEY}.probe`;
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    const values = new Map();
    return {
      getItem: (key) => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
  }
})();

/** One stored figure -- a best score or a best tile -- read back as a number. */
function loadBest(key, name) {
  const value = storage.getItem(key);
  if (value === null) {
    return 0;
  }
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new SaveError(`Invalid stored 2048 ${name}: ${value}`);
  }
  return Number(value);
}

/**
 * Write down the best figures the game has just raised.
 *
 * Which track they belong to, the game knows and this does not have to: a game plays
 * into one or the other, never both, so it is always that track's pair of keys.
 *
 * Both are written whichever of the two moved. They move independently -- a merge into a
 * new largest tile is rarely the move that takes the points lead -- and writing the pair
 * costs one more localStorage set than carrying which one it was down to here.
 */
function saveBests() {
  storage.setItem(
    game.replayed ? BEST_REPLAYED_SCORE_KEY : BEST_SCORE_KEY,
    String(game.ownBest)
  );
  storage.setItem(
    game.replayed ? BEST_REPLAYED_TILE_KEY : BEST_TILE_KEY,
    String(game.ownBestTile)
  );
}

/* Play time ---------------------------------------------------------------- */

// Runs from the first move until the board locks, and pauses with the tab.
const playTime = {
  seconds: 0,
  startedAt: null,
  enabled: false,

  elapsed() {
    if (this.startedAt === null) {
      return this.seconds;
    }
    return this.seconds + (performance.now() - this.startedAt) / 1000;
  },

  set(seconds, enabled) {
    this.seconds = seconds;
    this.startedAt = null;
    this.enabled = enabled;
    this.sync();
  },

  sync() {
    if (this.startedAt !== null) {
      this.seconds += (performance.now() - this.startedAt) / 1000;
      this.startedAt = null;
    }
    if (this.enabled && document.visibilityState === "visible") {
      this.startedAt = performance.now();
    }
  },
};

document.addEventListener("visibilitychange", () => playTime.sync());

/**
 * Whether the clock should be running for the game as it now stands.
 *
 * Asked of the newest state rather than of the state on screen, because the clock
 * belongs to the game and not to the board being looked at: it runs whenever the game
 * is under way, however far back the scrubber has been left.
 *
 * A popup stops it, because a popup stops play: what is being looked at then is the
 * history or the graph, and neither is the game running.
 */
function clockRuns() {
  return game.latest.moves > 0 && !game.latest.gameOver && !popupOpen();
}

/* Saving ------------------------------------------------------------------- */

/** Persists game state and reports how long the writes take. */
const saver = {
  lastSaveTime: 0,
  lastState: null,
  latencies: [],
  percentiles: null,
  lastMetricsRefresh: 0,

  /** Restart the interval without writing: storage already holds this state. */
  defer() {
    this.lastSaveTime = performance.now();
  },

  save(game, playSeconds) {
    const startedAt = performance.now();
    const serialized = game.encode(playSeconds);
    storage.setItem(GAME_STATE_KEY, serialized);
    this.latencies.push(performance.now() - startedAt);
    if (this.latencies.length > SAVE_LATENCY_CAPACITY) {
      this.latencies.shift();
    }
    this.lastSaveTime = performance.now();
    this.lastState = serialized;
  },

  /**
   * Interval save, skipped when the snapshot would be byte-identical.
   *
   * Play time is the only field that moves without a move being made, so once the
   * board is finished -- or merely idle, since the play clock pauses with the tab --
   * the interval save would rewrite the same bytes until the tab closes.
   */
  saveIfDue(game, playSeconds) {
    if (performance.now() - this.lastSaveTime < SAVE_INTERVAL_MS) {
      return;
    }
    if (game.encode(playSeconds) === this.lastState) {
      this.defer();
      return;
    }
    this.save(game, playSeconds);
  },

  refreshMetrics(now) {
    if (now - this.lastMetricsRefresh < SAVE_METRICS_REFRESH_MS) {
      return;
    }
    this.lastMetricsRefresh = now;

    const samples = this.latencies.slice().sort((a, b) => a - b);
    if (samples.length === 0) {
      this.percentiles = null;
      return;
    }
    const percentile = (fraction) => {
      const position = (samples.length - 1) * fraction;
      const lower = Math.floor(position);
      const upper = Math.ceil(position);
      const weight = position - lower;
      return samples[lower] * (1 - weight) + samples[upper] * weight;
    };
    this.percentiles = [percentile(0.5), percentile(0.9), percentile(0.99)];
  },

  summary() {
    if (this.percentiles === null) {
      return "collecting";
    }
    return `${this.percentiles.map((ms) => ms.toFixed(0)).join("/")} ms`;
  },
};

/* Frame timing -------------------------------------------------------------- */

/**
 * The frame rate over the last window, and the longest single gap inside it.
 *
 * Both, because they fail differently and neither implies the other. The rate catches a
 * loop running slower than the display throughout; the worst gap catches one frame the
 * page missed, which a mean over thirty frames averages away. Read together they
 * separate the two cases a single figure runs together: 33 ms worst against 60 fps is
 * the odd dropped frame, where 33 ms worst against 30 fps is every frame arriving late
 * and a different problem entirely. That pair is not hypothetical -- it is what an
 * iPhone playing on the d-pad needed to tell a normal interaction hitch from a
 * half-rate loop, and the rate alone could not say which.
 *
 * They share one window and one anchor. Sampling them separately looks equivalent and
 * is not: the reading restarts on a parked loop, so two windows started from the same
 * clock drift apart, and a hitch then lands inside one and outside the other.
 */
const frameTiming = {
  fps: 0,
  worstMs: 0,
  frames: 0,
  windowWorst: 0,
  windowStart: 0,
  previous: null,

  sample(now) {
    // A gap at least as long as the window itself is the loop having been parked, not a
    // frame the page missed: rAF stops for a hidden tab, and for anything else that
    // suspends the page -- an occluded window, a paused debugger, a sleeping machine.
    // None of those announce themselves reliably (a backgrounded tab throttles to about
    // one frame a second, and headless Chromium does it without firing
    // visibilitychange), so the length of the gap is what rules them out. The window it
    // lands in cannot be characterised either way, so the reading restarts on it.
    if (this.previous === null || now - this.previous >= FRAME_WINDOW_MS) {
      this.previous = now;
      this.windowStart = now;
      this.windowWorst = 0;
      this.frames = 0;
      return;
    }
    // Counted after the anchor check, so the frame that opens a window is the interval's
    // near end rather than one of the frames inside it: over the window, frames counted
    // and intervals elapsed are then the same number, which is what makes the rate exact
    // at a locked refresh instead of one frame light.
    this.frames += 1;
    this.windowWorst = Math.max(this.windowWorst, now - this.previous);
    this.previous = now;
    const elapsed = now - this.windowStart;
    if (elapsed >= FRAME_WINDOW_MS) {
      this.fps = (this.frames * 1000) / elapsed;
      this.worstMs = this.windowWorst;
      this.frames = 0;
      this.windowWorst = 0;
      this.windowStart = now;
    }
  },

  summary() {
    if (this.worstMs === 0) {
      return "collecting";
    }
    return `${this.worstMs.toFixed(1)} ms`;
  },
};

/* Painting ----------------------------------------------------------------- */

let cellSize = MAX_CELL;
let gapSize = DESKTOP_GAP;

function tileClass(value) {
  return value > 2048 ? "beyond" : `v${value}`;
}

function fontSizeFor(value) {
  if (value < 128) {
    return cellSize * 0.5;
  }
  return value < 1024 ? cellSize * 0.43 : cellSize * 0.36;
}

function tileElement(value, cell) {
  const element = document.createElement("div");
  element.className = "tile";
  element.style.transform = translation(rowOf(cell), colOf(cell));

  const face = document.createElement("div");
  face.className = `tile-face ${tileClass(value)}`;
  face.style.fontSize = `${fontSizeFor(value)}px`;
  face.textContent = String(value);

  element.append(face);
  return element;
}

const rowOf = (cell) => Math.floor(cell / SIZE);
const colOf = (cell) => cell % SIZE;

/** Board position of a tile, in fractional cells so a slide can stop between them. */
function translation(row, col) {
  const step = cellSize + gapSize;
  return `translate(${col * step}px, ${row * step}px)`;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

/** How big a tile is drawn part way through its burst. */
function burstScale(kind, t) {
  // A spawn grows in from 60% size rather than popping from nothing.
  if (kind === "appear") {
    return APPEAR_FROM + (1 - APPEAR_FROM) * easeOutCubic(t);
  }
  // A merge nudges past full size and settles back, so it reads as an arrival.
  return t < 0.5
    ? 1 + (MERGE_PEAK - 1) * easeOutCubic(t / 0.5)
    : MERGE_PEAK - (MERGE_PEAK - 1) * easeOutCubic((t - 0.5) / 0.5);
}

// Tile faces mid-burst. Repainting the board clears it: every entry points at an
// element the repaint is about to drop.
let bursts = [];

/** Paint the board as it now stands, bursting merges and springing in new tiles. */
function paintSettled({ merged = new Set(), appeared = new Set() } = {}) {
  const startedAt = performance.now();
  const tiles = [];
  bursts = [];

  for (let cell = 0; cell < SIZE * SIZE; cell += 1) {
    const value = game.cells[rowOf(cell)][colOf(cell)];
    if (!value) {
      continue;
    }
    const element = tileElement(value, cell);
    tiles.push(element);

    const kind = appeared.has(cell) ? "appear" : merged.has(cell) ? "merge" : null;
    if (kind !== null) {
      const face = element.firstElementChild;
      // Placed before the first paint, so a spawn is never briefly drawn full size.
      face.style.transform = `scale(${burstScale(kind, 0)})`;
      bursts.push({ face, kind, startedAt });
    }
  }
  elements.tiles.replaceChildren(...tiles);
}

/** Grow the bursting tiles one frame further, and drop each as it settles. */
function stepBursts(now) {
  if (bursts.length === 0) {
    return;
  }
  bursts = bursts.filter(({ face, kind, startedAt }) => {
    const progress = (now - startedAt) / BURST_MS;
    if (progress >= 1) {
      face.style.transform = "";
      return false;
    }
    face.style.transform = `scale(${burstScale(kind, progress)})`;
    return true;
  });
}

/**
 * Paint the pre-move board, ready to be walked to where the move put it.
 *
 * A merge shows both tiles converging on the same square; the tile the move spawned is
 * held back by paintSettled until they land.
 */
function paintSliding(slidingTiles) {
  const painted = slidingTiles.map((tile) => tileElement(tile.value, tile.from));
  elements.tiles.replaceChildren(...painted);
  return painted.map((element, index) => ({
    element,
    from: slidingTiles[index].from,
    to: slidingTiles[index].to,
  }));
}

/**
 * What the state on screen is worth and how far it got, and what has ever been reached.
 *
 * The whole of its line: the clock and the move count have their own below, which is
 * what leaves this one room for a best carrying a replayed one beside it.
 *
 * An asterisk is the whole of what marks a game that has been played on from an earlier
 * state, and there is deliberately no counterpart on a clean one: a score with nothing
 * beside it is a score, which is what it was before any of this existed. The best line
 * carries the replayed track in brackets after the clean one, and carries it only once
 * there is one -- a player who has never taken a move back never sees a bracket.
 *
 * Both readings are built in format.js, out of numbers and nothing else: what the line
 * says is a question about wording and width, which is worth being able to test without
 * a page. The game is handed over whole because its own property names are the ones the
 * two formatters ask for.
 */
function paintScore() {
  elements.scoreLine.textContent = scoreLine(game);
  // The line trades exact digits for width -- and, on the replayed track, a tile for it
  // -- so the reading with nothing left out is put back on hover. What the asterisk is
  // short for rides along in it: the move it names is the one thing the mark itself
  // cannot say, and the line has no room to say it either.
  elements.scoreLine.title = scoreTitle(game);
}

// Refused while the past is on screen, since a move can only be made from the latest
// state: a live-looking d-pad over a board that will not budge is the wrong signal.
const dpadButtons = [...document.querySelectorAll("#dpad button")];

/**
 * Draw the scrubber against the timeline as it now stands.
 *
 * The slider is indexed by timeline position but labelled by move count, because the
 * two part company once the oldest states are trimmed away: position 0 is then some
 * move other than the first.
 */
function paintTimeline() {
  const lastIndex = game.timeline.length - 1;
  // A game one state long has nowhere to scrub to, but a range whose ends meet parks
  // its marker at the left and is then thrown to the right by the first move. So the
  // slider is given a move it cannot be dragged along instead: the marker stands where
  // the newest state always stands, and the first move leaves it exactly there.
  const span = Math.max(lastIndex, 1);
  const position = lastIndex === 0 ? span : game.cursor;
  elements.scrubber.max = String(span);
  elements.scrubber.value = String(position);
  elements.scrubber.disabled = lastIndex === 0;
  elements.scrubber.style.setProperty("--scrub", `${(position / span) * 100}%`);
  elements.stepBack.disabled = game.cursor === 0;
  elements.stepForward.disabled = game.atLatest;
  elements.latest.disabled = game.atLatest;
  elements.playFromHere.disabled = game.atLatest;
  // Off while the past is on screen, and off on an opening board, which has no move
  // behind it to take back.
  elements.undo.disabled = !game.atLatest || game.cursor === 0;
  // Two different readings, so two different words for them. At the latest state the
  // number is how many moves have been played, and reads as a total; scrubbed back it is
  // which move is on screen, one of a set, and needs that set beside it to mean anything.
  // The label ends its line, with nothing to its right, so the two forms can be as wide
  // as they like without pushing anything out of place.
  // Abbreviated at the latest state, where it sits on the progress line beside the
  // clock and has to stay short; exact while scrubbing, where it stands alone below
  // the board and a player paging through history wants the real move number.
  elements.timelineLabel.textContent = game.atLatest
    ? `Moves: ${abbreviate(game.moves)}`
    : `Move ${count(game.moves)}/${count(game.latest.moves)}`;
  elements.board.classList.toggle("past", !game.atLatest);
  elements.board.classList.toggle("paused", popupOpen());
  for (const button of dpadButtons) {
    button.disabled = !game.atLatest || popupOpen();
  }
  paintNextMove();
}

/**
 * Show or hide the scrubbing controls.
 *
 * A popup rather than a line of the panel: they are wanted occasionally and are as wide
 * as the panel, while every other line there earns its height in every game. What is
 * always up is the move the board is on, and the clock that opens this.
 *
 * Opening hands focus to the slider, which is what was asked for; closing hands it back
 * to the clock, but only if it was still inside -- a click elsewhere on the page has
 * already put focus where that click meant it to go.
 */
function setTimelineOpen(open) {
  if (open && !elements.statsPanel.hidden) {
    setStatsOpen(false);
  }
  elements.timeline.hidden = !open;
  elements.timeTravel.setAttribute("aria-expanded", String(open));
  if (open) {
    elements.scrubber.focus();
  } else if (elements.timeline.contains(document.activeElement)) {
    elements.timeTravel.focus();
  }
  syncPlayState();
}

/**
 * Stop or take up play, now that a popup has opened or closed.
 *
 * The clock is set from the same question everything else asks -- clockRuns -- and from
 * the seconds already elapsed, so a pause costs nothing and a resume picks up where the
 * game left off. The panel is repainted through paintTimeline rather than paintPanel,
 * which would clear whatever the game currently has to say: opening a popup is not news
 * and must not swallow the news already on screen.
 */
function syncPlayState() {
  playTime.set(playTime.elapsed(), clockRuns());
  paintTimeline();
}

/**
 * Put the popup away and the newest state back on the board.
 *
 * Looking at an earlier board is what the popup is open for, so leaving one behind when
 * it closes would leave the game somewhere it cannot be played from with nothing on
 * screen to say why. Dismissing is how you get back to playing.
 */
function closeTimeline() {
  setTimelineOpen(false);
  showState(game.timeline.length - 1);
}

// The indicator on its way in, or null once it has arrived. The element is part of the
// page rather than painted per state, so one reference outlives every repaint.
let indicator = null;

/**
 * Point the indicator at the move played from the state on screen, and start it in.
 *
 * Restarted even when the arrow is already pointing that way, so scrubbing through a
 * run of moves in one direction reads as a move per state rather than as one arrow
 * sitting still.
 */
function paintNextMove() {
  const direction = game.nextDirection;
  elements.nextMove.hidden = direction === null;
  // The direction is the only class the element carries, so it can simply replace
  // whatever the state before it left there.
  elements.nextMove.className = direction ?? "";
  indicator = direction === null ? null : { direction, startedAt: performance.now() };
  // Placed before the first paint, so the arrow is never drawn at rest and then moved.
  stepIndicator(performance.now());
}

/**
 * Draw the indicator back to where it settles.
 *
 * It lands a little past its resting place, along the axis it points down, and eases
 * back -- the same overshoot a merging tile makes, and the same reason: an arrival
 * reads as one. A still arrow says which way; the recoil says a move happened.
 * Animated from the frame loop next to the slides and the bursts, for the reason
 * given over stepSlide.
 */
function stepIndicator(now) {
  if (indicator === null) {
    return;
  }
  const progress = (now - indicator.startedAt) / INDICATOR_MS;
  if (progress >= 1) {
    elements.nextMove.style.transform = "";
    indicator = null;
    return;
  }
  const [dx, dy] = DIRECTION_STEPS.get(indicator.direction);
  const distance = cellSize * INDICATOR_NUDGE * (1 - easeOutCubic(progress));
  elements.nextMove.style.transform = `translate(${dx * distance}px, ${dy * distance}px)`;
}

// Up on the score line rather than down among the readings: it is what the game has got
// to, like the score and the move beside it, and not a measurement of the page.
//
// "Time" rather than "Play time", which is what it is called everywhere it is discussed:
// the label sits third of four on a line that was already wrapping on a phone, and what
// a clock beside a score is measuring is not in much doubt.
function paintPlayTime(playSeconds) {
  elements.playTimeLabel.textContent = `Time: ${formatDuration(playSeconds)}`;
}

function paintStats() {
  elements.stats.textContent =
    `FPS: ${frameTiming.fps.toFixed(0)}` +
    ` | Worst: ${frameTiming.summary()}` +
    ` | Save p50/90/99: ${saver.summary()}`;
}

/* Stats graph --------------------------------------------------------------- */

// The gutter is what the two scale labels need; the rest is the smallest margin that
// keeps a mark off the edge it is drawn against.
const CHART_GUTTER = 34;
const CHART_PAD_RIGHT = 4;
const CHART_PAD_TOP = 6;
// The moves axis is labelled under the bars, on its own line.
const CHART_PAD_BOTTOM = 14;
// Between the lanes: wide enough that a tall bar and a low line never touch, which is
// what keeps them reading as separate scales rather than one.
const CHART_LANE_GAP = 8;
// The share of the plot each lane gets, top to bottom, after the gaps are taken out.
// The total is the line being read across the whole game, so it is the tallest; the
// gains are the series with something to say in every bin, so they are close behind;
// undos are the sparsest mark and the smallest story.
const CHART_LANES = { points: 0.44, gained: 0.32, undos: 0.24 };
const CHART_LABEL_SIZE = 11;
const CHART_LABEL_COLOR = "#9fb3c8";
const CHART_AXIS_COLOR = "rgba(255, 255, 255, 0.14)";
// Fainter than the baselines: the gridlines are there to be read against, not followed.
const CHART_GRID_COLOR = "rgba(255, 255, 255, 0.07)";
// Gridlines per lane, near enough: a round step landing about this many rules up is
// enough to read a height off and few enough that the marks stay the thing being seen.
// Two, because a lane is a third of a short popup: at three the labels touch.
const CHART_GRID_STEPS = 2;
const CHART_HOVER_COLOR = "rgba(255, 255, 255, 0.08)";
// A bar keeps a 2px gap from its neighbours, and never disappears: a bin with one undo
// in it is a mark worth seeing at any bin width.
const CHART_BAR_GAP = 2;
const CHART_MIN_MARK = 1;
const CHART_BAR_RADIUS = 2;
const CHART_LINE_WIDTH = 2;
// A game one state long is one bin, and a line through one point draws nothing. The
// single bin is marked instead, at a size that reads as a point rather than as a tile.
const CHART_POINT_RADIUS = 3;

// Which bin the pointer is over, or null. Kept beside the geometry the last paint used,
// because the pointer arrives in canvas pixels and only that paint knows what they mean.
let hoveredBin = null;
let chartGeometry = null;

/** The bin under a canvas x, or null when the pointer is outside the plot. */
function binAt(x) {
  if (chartGeometry === null) {
    return null;
  }
  const { plotLeft, binPixels, binCount } = chartGeometry;
  const index = Math.floor((x - plotLeft) / binPixels);
  return index < 0 || index >= binCount ? null : index;
}

/**
 * The graph in words: the whole game, or the bin being pointed at.
 *
 * Both readings name their span of moves first, so pointing at a bin swaps one sentence
 * for another of the same shape rather than adding one.
 */
function chartReadout(stats) {
  // The one place a figure here is not a bare number: "1 undos" reads as a bug in a line
  // that is otherwise plain English.
  const undos = (total) => `${count(total)} ${total === 1 ? "undo" : "undos"}`;
  const bin = hoveredBin === null ? null : stats.bins[hoveredBin];
  if (bin === null) {
    return (
      `Moves ${count(stats.firstMove)}-${count(stats.lastMove)}` +
      `  |  ${count(stats.maxPoints)} points` +
      `  |  ${undos(stats.totalUndos)}`
    );
  }
  const span =
    bin.from === bin.to
      ? `Move ${count(bin.from)}`
      : `Moves ${count(bin.from)}-${count(bin.to)}`;
  // A bin says what was gained in it as well as what the game stood at, because that is
  // the difference between the two series and the reason both are drawn.
  return (
    `${span}  |  ${count(bin.points)} points` +
    `  |  +${count(bin.gained)}  |  ${undos(bin.undos)}`
  );
}

/**
 * Draw the game against the moves it took: the running total as a line, the points each
 * span gained as bars under it, and the undos as bars under those.
 *
 * Three lanes rather than three scales on one axis. The series answer different
 * questions in different units -- a running total, a rate, a count of events -- and
 * drawing them over each other on a shared axis is the one way of putting them together
 * that is read wrong every time: whichever series is scaled to fit looks like it crosses
 * the others. Stacked lanes give each its own baseline and its own label, and keep the
 * axis they genuinely share, which is the moves along the bottom.
 *
 * Every lane is linear, the total's included. A log lane was the right answer when the
 * total was the only points series there was: a game doubles its way up, and on a linear
 * axis the whole of the early game is flat against the baseline. But it buys that at the
 * far end, where a running total spends the rest of a long game pinned against its own
 * peak -- past the first quarter of the moves, a log lane is a horizontal line. The gains
 * lane is what now carries the early game, doubling by doubling, and it carries the late
 * game too; with that drawn, the total is wanted for the one thing a total is good for,
 * which is its shape, and a linear lane draws that honestly at both ends.
 *
 * Colours come off the legend swatches rather than being written down here, the way the
 * share image takes its tile colours off the board: the stylesheet stays the one place a
 * colour is chosen, and the legend cannot end up naming a colour the canvas is not
 * drawing.
 *
 * Cheap enough to run from paintPanel on every move -- a hundred bins is a hundred line
 * segments -- so nothing has to work out whether the graph has gone stale.
 */
function paintChart() {
  if (elements.statsPanel.hidden) {
    return;
  }
  const canvas = elements.chart;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  // The backing store is the display's pixels, and is resized only when it has to be:
  // assigning to width or height reallocates and clears it, and this runs on every move.
  const ratio = window.devicePixelRatio || 1;
  const [pixelWidth, pixelHeight] = [Math.round(width * ratio), Math.round(height * ratio)];
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext("2d");
  // Set every paint rather than once, since a resize drops it: everything below this is
  // drawn in CSS pixels and lands on the display's own.
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  // Binned from the history, not the timeline: the timeline is capped, so binning it
  // would draw the newest thousand moves and call them the game.
  const stats = binGame(game.history);
  // The bin under the pointer need not have survived: taking moves back shortens the
  // axis, and the bin that was being read can simply be gone. The pointer is not tracked
  // between repaints, so there is nothing to re-derive it from -- the graph goes back to
  // reading out the whole game until the pointer moves and names a bin that exists.
  if (hoveredBin !== null && hoveredBin >= stats.bins.length) {
    hoveredBin = null;
  }
  const plotLeft = CHART_GUTTER;
  const plotRight = width - CHART_PAD_RIGHT;
  const plotBottom = height - CHART_PAD_BOTTOM;
  const binPixels = (plotRight - plotLeft) / stats.bins.length;
  chartGeometry = { plotLeft, binPixels, binCount: stats.bins.length };

  // The lanes, stacked top to bottom, each given its share of what the gaps leave over.
  const names = Object.keys(CHART_LANES);
  const laneRoom = plotBottom - CHART_PAD_TOP - CHART_LANE_GAP * (names.length - 1);
  const lanes = {};
  let laneTop = CHART_PAD_TOP;
  for (const [index, name] of names.entries()) {
    // The last lane is measured from the bottom rather than given its share, so the
    // rounding the ones above it leave over lands inside it instead of pushing its
    // baseline past the plot and out from under the axis labels.
    const bottom =
      index === names.length - 1
        ? plotBottom
        : laneTop + Math.round(laneRoom * CHART_LANES[name]);
    lanes[name] = { top: laneTop, bottom, height: bottom - laneTop };
    laneTop = bottom + CHART_LANE_GAP;
  }

  const centre = (index) => plotLeft + (index + 0.5) * binPixels;
  /**
   * Where a value sits in its lane, measured from that lane's own baseline.
   *
   * A lane whose series is worth nothing -- a game that has scored nothing, one nothing
   * has been taken back in -- has no scale to draw against. Its marks sit on the
   * baseline, which is where a zero belongs; nothing here is guessing at a range it
   * does not have.
   */
  const heightIn = (lane, value, max) =>
    max === 0 ? 0 : (value / max) * (lane.height - CHART_LABEL_SIZE / 2);
  const pointsAt = (points) =>
    lanes.points.bottom - heightIn(lanes.points, points, stats.maxPoints);

  const font = getComputedStyle(elements.panel).fontFamily;
  const label = (text, x, y, align) => {
    context.fillStyle = CHART_LABEL_COLOR;
    context.font = `${CHART_LABEL_SIZE}px ${font}`;
    context.textAlign = align;
    context.textBaseline = "middle";
    context.fillText(text, x, y);
  };

  // The bin being pointed at, behind everything: a band rather than a crosshair, since
  // what is being read off it is a span of moves and not a single one.
  if (hoveredBin !== null) {
    context.fillStyle = CHART_HOVER_COLOR;
    context.fillRect(plotLeft + hoveredBin * binPixels, CHART_PAD_TOP, binPixels, plotBottom - CHART_PAD_TOP);
  }

  // One baseline per lane: three rules are enough to say where each series is measured
  // from, and the marks are what the eye should be following.
  context.fillStyle = CHART_AXIS_COLOR;
  for (const lane of Object.values(lanes)) {
    context.fillRect(plotLeft, lane.bottom, plotRight - plotLeft, 1);
  }

  /**
   * Label a lane's peak, and rule the round steps below it.
   *
   * A lane says what its top is worth, and says nothing when it is empty rather than
   * labelling a scale it does not have. None of them says what its bottom is worth:
   * every baseline is zero, they are drawn, and the lanes are close enough together
   * that a zero on one sits against the next lane's figure and is read as part of it.
   *
   * The steps are what makes a linear lane readable: without them an even rise says
   * nothing about how much was scored. A step landing under the peak's own label is
   * dropped rather than printed over it.
   */
  const scaleLane = (lane, max, at) => {
    if (max === 0) {
      return;
    }
    const peakY = lane.bottom - heightIn(lane, max, max);
    label(abbreviate(max), plotLeft - 6, peakY, "right");
    const rough = max / CHART_GRID_STEPS;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
    const normalised = rough / magnitude;
    const step = (normalised >= 5 ? 5 : normalised >= 2 ? 2 : 1) * magnitude;
    for (let value = step; value < max; value += step) {
      const y = at(value);
      if (Math.abs(y - peakY) < CHART_LABEL_SIZE) {
        continue;
      }
      context.fillStyle = CHART_GRID_COLOR;
      context.fillRect(plotLeft, y, plotRight - plotLeft, 1);
      label(abbreviate(value), plotLeft - 6, y, "right");
    }
  };

  scaleLane(lanes.points, stats.maxPoints, pointsAt);
  // The lower two lanes are short enough that a peak label and a step would crowd each
  // other, so they get the figure that says what the lane is worth and no rules.
  if (stats.maxGained > 0) {
    label(abbreviate(stats.maxGained), plotLeft - 6, lanes.gained.top + CHART_LABEL_SIZE / 2, "right");
  }
  if (stats.maxUndos > 0) {
    label(count(stats.maxUndos), plotLeft - 6, lanes.undos.top + CHART_LABEL_SIZE / 2, "right");
  }
  label(count(stats.firstMove), plotLeft, plotBottom + CHART_PAD_BOTTOM / 2 + 2, "left");
  label(count(stats.lastMove), plotRight, plotBottom + CHART_PAD_BOTTOM / 2 + 2, "right");

  /**
   * A lane of bars, rounded at the end the data reaches and square where it meets its
   * baseline -- which is what keeps a one-move bar from reading as a dot floating over
   * the axis. A bin worth nothing draws nothing; a bin worth anything at all draws a
   * mark, however thin the bin is.
   */
  const barWidth = Math.max(CHART_MIN_MARK, binPixels - CHART_BAR_GAP);
  const bars = (lane, max, value) => {
    for (const [index, bin] of stats.bins.entries()) {
      const amount = value(bin);
      if (amount === 0) {
        continue;
      }
      const barHeight = Math.max(CHART_MIN_MARK, heightIn(lane, amount, max));
      const radius = Math.min(CHART_BAR_RADIUS, barWidth / 2, barHeight / 2);
      context.beginPath();
      context.roundRect(
        centre(index) - barWidth / 2, lane.bottom - barHeight, barWidth, barHeight,
        [radius, radius, 0, 0]
      );
      context.fill();
    }
  };

  // Bars first, so a line that dips into a gap is drawn over them rather than under.
  context.fillStyle = paintedColor("swatch gained");
  bars(lanes.gained, stats.maxGained, (bin) => bin.gained);
  context.fillStyle = paintedColor("swatch undos");
  bars(lanes.undos, stats.maxUndos, (bin) => bin.undos);

  context.strokeStyle = paintedColor("swatch points");
  context.fillStyle = context.strokeStyle;
  context.lineWidth = CHART_LINE_WIDTH;
  context.lineJoin = "round";
  context.lineCap = "round";
  if (stats.bins.length === 1) {
    context.beginPath();
    context.arc(centre(0), pointsAt(stats.bins[0].points), CHART_POINT_RADIUS, 0, Math.PI * 2);
    context.fill();
  } else {
    context.beginPath();
    for (const [index, bin] of stats.bins.entries()) {
      context.lineTo(centre(index), pointsAt(bin.points));
    }
    context.stroke();
  }

  elements.chartReadout.textContent = chartReadout(stats);
}

/**
 * Show or hide the graph.
 *
 * It shares its anchor with the move history, so opening one puts the other away -- and
 * puts the newest state back on the board with it, which is what dismissing the history
 * has always meant.
 */
function setStatsOpen(open) {
  if (open && !elements.timeline.hidden) {
    closeTimeline();
  }
  elements.statsPanel.hidden = !open;
  elements.graph.setAttribute("aria-expanded", String(open));
  // Whatever was under the pointer belonged to the last time it was open.
  hoveredBin = null;
  syncPlayState();
  paintChart();
}

// What the game currently has to say, or "" when it has nothing. Kept here rather than
// read back off the line it is painted into, because that line is only showing it while
// there is something to show.
let message = "";

function setMessage(text) {
  message = text;
  paintHelp();
}

/**
 * Say what the state on screen is, after `prefix` where there is news to go with it.
 *
 * Nothing is said about viewing the past or about which move came next: the arrow over
 * the board, the tiles drawn back, and the flat d-pad say all of it without prose.
 */
function paintMessage(prefix = "") {
  const state = game.gameOver ? GAME_OVER_MESSAGE : "";
  setMessage([prefix, state].filter(Boolean).join(" "));
}

function instructions() {
  return compactMedia.matches
    ? "Swipe to move. R restarts."
    : "Keyboard: arrows/WASD, swipe, [ and ] scrub, R to restart";
}

/**
 * Paint the line under the controls: what the game has to say, or how to play it.
 *
 * One line rather than two, because the two were never both worth reading at once. The
 * instructions are what a fresh board needs and are the same words every game; a
 * message is news, and news is worth the more prominent line while it lasts. Every
 * message clears itself -- the next move paints an empty one -- so the instructions
 * come back on their own, and the panel's height never moves either way.
 */
function paintHelp() {
  elements.help.textContent = message || instructions();
}

/**
 * Draw everything that reports the state the game is now in: the board, and the panel
 * lines that say what it is worth, where it sits, and what there is to say about it.
 *
 * `burst` is how the board arrived, in paintSettled's terms; left off, it is drawn at
 * rest. Every path that changes which state is on screen ends here, so none of them can
 * repaint three quarters of the page and leave the fourth saying something else.
 */
function repaint(burst, prefix = "") {
  paintSettled(burst);
  paintPanel(prefix);
}

/**
 * The panel lines alone, for the one caller that must not touch the board: a move paints
 * the tiles where they started and walks them over, so repainting the board here would
 * drop them on their destinations a slide early.
 */
function paintPanel(prefix = "") {
  paintScore();
  paintTimeline();
  paintMessage(prefix);
  // A no-op unless the graph is open, and the graph is of the whole game rather than of
  // the state on screen: a move extends it, and taking one back puts a bar on it.
  paintChart();
}

/* Sizing ------------------------------------------------------------------- */

/**
 * Fit the board to whatever the rest of the panel leaves over.
 *
 * The cell is the quantum: the board size follows from it, so the MIN_CELL floor can
 * never leave the drawn board wider than the space measured for it. Nothing here can
 * feed back into the measurement, because the panel's height minus the board's is the
 * same number whatever size the board is.
 */
function resizeBoard() {
  const gap = compactMedia.matches ? COMPACT_GAP : DESKTOP_GAP;
  const mainStyle = getComputedStyle(elements.main);
  const panelStyle = getComputedStyle(elements.panel);
  const frameWidth =
    elements.panel.offsetWidth -
    elements.panel.clientWidth +
    parseFloat(panelStyle.paddingLeft) +
    parseFloat(panelStyle.paddingRight);

  const availableWidth =
    elements.main.clientWidth -
    parseFloat(mainStyle.paddingLeft) -
    parseFloat(mainStyle.paddingRight) -
    frameWidth;
  const chromeHeight = elements.panel.offsetHeight - elements.board.offsetHeight;
  const availableHeight =
    elements.main.clientHeight -
    parseFloat(mainStyle.paddingTop) -
    parseFloat(mainStyle.paddingBottom) -
    chromeHeight;

  const target = Math.min(availableWidth, availableHeight);
  const cell = Math.max(
    MIN_CELL,
    Math.min(MAX_CELL, Math.floor((target - gap * (SIZE - 1)) / SIZE))
  );
  if (cell === cellSize && gap === gapSize) {
    return;
  }

  cellSize = cell;
  gapSize = gap;
  document.documentElement.style.setProperty("--cell", `${cell}px`);
  document.documentElement.style.setProperty("--gap", `${gap}px`);
  landSlide();
  paintSettled();
}

/* Moves -------------------------------------------------------------------- */

// The move in flight: the tiles travelling, and the repaint that lands them. Kept so a
// new game or a resize can land it early rather than leave tiles mid-board.
let slide = null;
// -Infinity so the first move of a board is never held back by the throttle.
let lastMoveAt = -Infinity;
let acceptingInput = false;

function startSlide(tiles, settle) {
  slide = { tiles, settle, startedAt: performance.now() };
}

/**
 * Walk the travelling tiles one frame further, and land them when they arrive.
 *
 * The frame loop moves them itself rather than handing the job to a CSS transition or
 * the animation API. Both of those are motion the browser owns, and a browser is
 * entitled to decide it would rather not: an embedded webview, a host stylesheet with
 * a reduced-motion override, a paused compositor. When that happened the move simply
 * teleported. This is also how the imgui demo animates -- it interpolates the tiles
 * itself on every frame it draws -- so the two now share an easing curve as well as a
 * duration.
 */
function stepSlide(now) {
  if (slide === null) {
    return;
  }
  const progress = (now - slide.startedAt) / SLIDE_MS;
  if (progress >= 1) {
    landSlide();
    return;
  }
  const eased = easeInOutCubic(progress);
  for (const { element, from, to } of slide.tiles) {
    element.style.transform = translation(
      rowOf(from) + (rowOf(to) - rowOf(from)) * eased,
      colOf(from) + (colOf(to) - colOf(from)) * eased
    );
  }
}

function landSlide() {
  if (slide === null) {
    return;
  }
  const { settle } = slide;
  slide = null;
  settle();
}

/**
 * Write down what a change to the live game leaves behind: the clock's reading, the best
 * figures if either moved, and the game itself.
 *
 * The clock is read before it is set, so the seconds stored are the ones the change
 * happened at rather than a fresh zero, and whether it keeps running is asked of the
 * game rather than assumed: the same call has to start it on the first move and stop it
 * on the last.
 */
function commitChange(bestChanged = false) {
  const playSeconds = playTime.elapsed();
  playTime.set(playSeconds, clockRuns());
  if (bestChanged) {
    saveBests();
  }
  saver.save(game, playSeconds);
}

/**
 * Show or hide the question New Game asks.
 *
 * Opening hands focus to the answer that was asked for: the press that opened this was a
 * press for a new game, and the one that lands on the focused button confirms it. Closing
 * hands focus back to the button that asked, but only if it was still inside -- a press
 * elsewhere on the page has already put focus where that press meant it to go.
 */
function setConfirmOpen(open) {
  elements.newGameConfirm.hidden = !open;
  if (open) {
    elements.confirmNewGame.focus();
  } else if (elements.newGameConfirm.contains(document.activeElement)) {
    elements.newGame.focus();
  }
  syncPlayState();
}

/**
 * New Game, pressed. Ask first if there is a game to lose.
 *
 * Only a game that has been played is worth a question. A board still on its opening two
 * tiles has nothing to discard, and a finished one has nothing left to play -- the
 * game-over line asks for this very press, so a question in front of it would charge two
 * presses for the only thing left to do.
 *
 * Pressed again while the question is up, it puts the question away, exactly as the clock
 * and the graph close the popups they open. The answer is in the popup, where what it
 * costs is written down.
 */
function requestNewGame() {
  if (game.latest.moves === 0 || game.latest.gameOver) {
    startNewGame();
    return;
  }
  setConfirmOpen(elements.newGameConfirm.hidden);
}

function startNewGame() {
  const spawned = game.reset();
  slide = null;
  lastMoveAt = -Infinity;
  // Every control in it is about to be disabled: a new game has nowhere to scrub to.
  setTimelineOpen(false);
  // Answered, whether or not it was ever asked: startup begins a game without one.
  setConfirmOpen(false);
  // Just the news: the line it is standing in already says how to play, and saying it
  // again in fewer words would be the one thing this message costs.
  repaint({ appeared: new Set(spawned) }, "New game.");
  // The clock starts over with the board rather than carrying the last game's seconds
  // across; commitChange picks the zero straight back up.
  playTime.set(0, false);
  commitChange();
}

/**
 * Show the state at a timeline position, and say which one it is.
 *
 * The tiles the move landed burst as they would have when it was played: the merges
 * swell and settle, the tile it spawned springs in. A state looks the same whichever
 * way it was reached, so stepping back plays the burst of the state arrived at rather
 * than unwinding the one left behind -- what is being shown is a board and the move
 * that made it, not a move running in reverse.
 *
 * No slide, though, which is the one part of a move left to play mode: a drag along the
 * slider crosses dozens of states in the time a single slide would take, while a burst
 * is over in a frame or two and never leaves a tile between cells. A slide still in
 * flight is landed first, so it cannot finish over the state seeked to.
 *
 * The move that reaches the newest state again is not saved from here; the interval
 * save picks the cursor up, which keeps a drag from writing storage once per stop.
 */
function showState(index) {
  if (!acceptingInput) {
    return;
  }
  landSlide();
  game.seek(index);
  repaint(game.arrival);
}

/**
 * Take up the game again from the state at `index`, dropping what it had gone on to do.
 *
 * Nothing here has to turn play back on: the board un-dims and the d-pad comes back by
 * themselves, because everything that was refusing input was reading atLatest, and the
 * state resumed at has just become the newest one.
 *
 * The board bursts as it would have when the move that reached it was played, which is
 * how every other landing on a state is drawn -- and here it is also the only thing on
 * screen that moves, since the tiles are already the ones being resumed from.
 *
 * `describe` is called after the fact, so it reads the game as it now stands.
 */
function playFrom(index, describe) {
  if (!acceptingInput) {
    return;
  }
  landSlide();
  const discarded = game.playFrom(index);
  if (discarded === 0) {
    return;
  }
  repaint(game.arrival, describe(discarded));
  // Always, rather than on a reported change: the fork is what carried the clean best
  // score and tile across to the replayed track, and that is a write whether or not it
  // moved either number.
  commitChange(true);
}

function applyMove(direction) {
  const now = performance.now();
  // Refused while a popup is up, wherever the move came from: the arrow keys and a swipe
  // reach the board from anywhere on the page, and the board is what the popup is
  // covering. Closing it is how play is taken up again.
  if (!acceptingInput || popupOpen() || now - lastMoveAt < INPUT_THROTTLE_MS) {
    return;
  }

  // Refused, silently, while an earlier state is on screen: move() knows not to play
  // from one, and the board already looks like something that cannot be played.
  const result = game.move(direction);
  if (result === null) {
    return;
  }

  lastMoveAt = now;
  landSlide();
  startSlide(paintSliding(result.slidingTiles), () =>
    paintSettled({
      merged: result.mergedCells,
      appeared: new Set([result.spawnedCell]),
    })
  );

  paintPanel();
  commitChange(result.bestChanged || result.bestTileChanged);
}

/* Input -------------------------------------------------------------------- */

/**
 * Report what the browser is doing with touches and page zoom, in the status line.
 *
 * Turned on with ?touchdebug=1 and off otherwise, because the thing being diagnosed --
 * a phone zooming itself mid-game -- cannot be reproduced in an automated browser:
 * native pinch and double-tap zoom come from the platform's own gesture recognisers,
 * which synthetic touch events do not drive. So the page has to say what it saw.
 *
 * What to read: `gesture*` lines mean the platform called it a pinch. A `viewport
 * scale` line with no gesture before it means it was a double-tap instead. Either way
 * the touchstart lines above it name the elements the fingers landed on, and the
 * touch-action in force there, which is what decides whether zoom was allowed.
 */
function startTouchDebug() {
  const lines = [];
  const say = (text) => {
    lines.push(text);
    while (lines.length > 7) {
      lines.shift();
    }
    elements.status.textContent = lines.join("\n");
  };

  const scale = () =>
    window.visualViewport ? window.visualViewport.scale.toFixed(2) : "?";

  // The browser intersects touch-action up the ancestor chain, so the value that
  // governs a touch is the first restrictive one above it, not the target's own.
  const governing = (element) => {
    for (let node = element; node instanceof Element; node = node.parentElement) {
      const value = getComputedStyle(node).touchAction;
      if (value !== "auto") {
        return `${node.id || node.className || node.tagName.toLowerCase()}=${value}`;
      }
    }
    return "auto";
  };

  const describe = (touch) => {
    const element = touch.target instanceof Element ? touch.target : null;
    if (element === null) {
      return "?";
    }
    const name = element.id || element.className || element.tagName.toLowerCase();
    return `${name}(${governing(element)})`;
  };

  for (const type of ["touchstart", "touchend"]) {
    document.addEventListener(type, (event) => {
      const touched = [...event.changedTouches].map(describe).join(" ");
      say(`${type} n=${event.touches.length} ${touched}`);
    }, { passive: true, capture: true });
  }

  // Safari only. These firing at all means the platform read a pinch.
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, (event) => {
      say(`${type} scale=${Number(event.scale || 0).toFixed(2)}`);
    }, { passive: true, capture: true });
  }

  if (window.visualViewport) {
    let last = window.visualViewport.scale;
    window.visualViewport.addEventListener("resize", () => {
      const current = window.visualViewport.scale;
      if (Math.abs(current - last) > 0.01) {
        say(`ZOOM ${last.toFixed(2)} -> ${current.toFixed(2)}`);
        last = current;
      }
    });
  }

  say(`touch debug on, scale=${scale()}`);
}

if (new URLSearchParams(location.search).has("touchdebug")) {
  startTouchDebug();
}

const KEYS = new Map([
  ["arrowup", "up"], ["w", "up"],
  ["arrowdown", "down"], ["s", "down"],
  ["arrowleft", "left"], ["a", "left"],
  ["arrowright", "right"], ["d", "right"],
  ["r", "restart"],
  ["[", "back"], ["]", "forward"],
]);

window.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  if (event.key === "Escape" && !elements.timeline.hidden) {
    event.preventDefault();
    closeTimeline();
    return;
  }
  if (event.key === "Escape" && !elements.statsPanel.hidden) {
    event.preventDefault();
    setStatsOpen(false);
    elements.graph.focus();
    return;
  }
  // No answer is the answer: the game on the board is the one that keeps playing.
  if (event.key === "Escape" && !elements.newGameConfirm.hidden) {
    event.preventDefault();
    setConfirmOpen(false);
    return;
  }
  const action = KEYS.get(event.key.toLowerCase());
  if (!action) {
    return;
  }
  // A focused scrubber owns the arrow keys: they are how a slider is driven from the
  // keyboard, and its own input event brings the board along. Everything else -- WASD,
  // R, the bracket keys -- still plays from wherever focus happens to be.
  if (event.target === elements.scrubber && event.key.startsWith("Arrow")) {
    return;
  }
  event.preventDefault();
  if (action === "back" || action === "forward") {
    // Repeats deliberately, unlike a move: holding a bracket key rewinds or replays,
    // which is the point of a scrubber on a game hundreds of moves long.
    showState(game.cursor + (action === "forward" ? 1 : -1));
    return;
  }
  if (event.repeat) {
    return;
  }
  if (action === "restart") {
    requestNewGame();
  } else {
    applyMove(action);
  }
}, { passive: false });

let touchStart = null;
// Whether the press now under way is the one that dismissed a popup. A press that puts a
// popup away is spent on doing that, and the swipe it begins is not also a move -- play
// was stopped when the finger went down, and closing a popup is how it is taken up, not
// something that happens halfway through a gesture.
//
// A flag rather than a question the swipe handler could ask for itself: touch delivers
// pointerdown before touchstart, so by the time a gesture is being recorded the popup it
// began over has already been closed.
let dismissingPress = false;

elements.main.addEventListener("touchstart", (event) => {
  // Buttons handle their own taps: swallowing the touch here would cost them the
  // click the browser synthesizes from it. The popup is skipped whole, because
  // dragging the scrubber is a swipe by any measure taken here.
  if (
    event.touches.length !== 1 ||
    dismissingPress ||
    event.target.closest("button, #timeline, #stats-panel")
  ) {
    touchStart = null;
    return;
  }
  touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
}, { passive: true });

elements.main.addEventListener("touchend", (event) => {
  if (touchStart === null || event.changedTouches.length === 0) {
    touchStart = null;
    return;
  }
  const dx = event.changedTouches[0].clientX - touchStart.x;
  const dy = event.changedTouches[0].clientY - touchStart.y;
  touchStart = null;

  const [absX, absY] = [Math.abs(dx), Math.abs(dy)];
  if (Math.max(absX, absY) < MIN_SWIPE_DISTANCE) {
    return;
  }
  if (absX > absY) {
    applyMove(dx > 0 ? "right" : "left");
  } else {
    applyMove(dy > 0 ? "down" : "up");
  }
}, { passive: true });

elements.main.addEventListener("touchcancel", () => {
  touchStart = null;
});

/**
 * Wire a button that gets tapped over and over: a d-pad arrow, a timeline step.
 *
 * The click covers mouse and keyboard. Touch cannot be left to the click the browser
 * would synthesise: tapping one button twice in a row is ordinary use here and iOS
 * reads it as a double tap, then zooms the page to fit the button -- 274px of the pad,
 * which is the 1.6x that kept happening. `touch-action` does not stop that on WebKit
 * whatever it is set to, but refusing the touch's own default does, and refusing it
 * also cancels the click, so the press has to be delivered from here.
 */
function onPress(button, press) {
  button.addEventListener("click", press);
  button.addEventListener("touchend", (event) => {
    event.preventDefault();
    press();
  }, { passive: false });
}

for (const direction of ["up", "down", "left", "right"]) {
  onPress(document.getElementById(direction), () => applyMove(direction));
}
// Pressed over and over as ordinary use -- back, and back again -- so it is wired like a
// d-pad arrow rather than like New Game, for the reason onPress gives.
onPress(elements.undo, () =>
  // The move taken back is the one after the state left on screen, which is the move
  // count as it now stands plus one.
  playFrom(game.cursor - 1, () => `Move ${count(game.moves + 1)} taken back.`)
);
onPress(elements.stepBack, () => showState(game.cursor - 1));
onPress(elements.stepForward, () => showState(game.cursor + 1));
onPress(elements.timeTravel, () => {
  if (elements.timeline.hidden) {
    setTimelineOpen(true);
  } else {
    closeTimeline();
  }
});
onPress(elements.graph, () => setStatsOpen(elements.statsPanel.hidden));

// Pointing at a bin reads it out, and taking the pointer away puts the whole game back.
// A repaint per bin crossed, which is what the band under the pointer costs; the graph
// is drawn from scratch on every move anyway.
elements.chart.addEventListener("pointermove", (event) => {
  const bin = binAt(event.offsetX);
  if (bin !== hoveredBin) {
    hoveredBin = bin;
    paintChart();
  }
});
elements.chart.addEventListener("pointerleave", () => {
  if (hoveredBin !== null) {
    hoveredBin = null;
    paintChart();
  }
});
elements.latest.addEventListener("click", () => showState(game.timeline.length - 1));
elements.playFromHere.addEventListener("click", () => {
  playFrom(
    game.cursor,
    (discarded) =>
      `Playing on from move ${count(game.moves)}. ${count(discarded)} discarded.`
  );
  // Not closeTimeline, which puts the newest state back on the board: the state on
  // screen has just become the newest one, and going back to playing is the point.
  setTimelineOpen(false);
});
elements.scrubber.addEventListener("input", () =>
  showState(Number(elements.scrubber.value))
);

// Dismissed by a press anywhere else -- the board included, which is the quickest way
// back to playing. Not the clock or the graph button, which have their own press to
// close, and not the popup itself. Escape closes them too; see the key handler.
//
// The press that dismisses does no more than that: it is recorded so the swipe it starts
// is not delivered as a move, since play was stopped for as long as the popup was up.
document.addEventListener("pointerdown", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  let dismissed = false;
  if (!elements.timeline.hidden && target?.closest("#timeline, #time-travel") === null) {
    closeTimeline();
    dismissed = true;
  }
  // The graph is dismissed the same way, and by the same press: nothing in it is a
  // control, so a press anywhere outside it is a press meant for the game.
  if (!elements.statsPanel.hidden && target?.closest("#stats-panel, #graph") === null) {
    setStatsOpen(false);
    dismissed = true;
  }
  // The question goes the same way, and this is also what keeps it from ever being up
  // beside either other popup: opening one is a press outside the other. Not a press on
  // New Game itself, which is a second press for a new game and closes the question by
  // itself -- dismissing it here would leave that press with nothing left to do.
  if (
    !elements.newGameConfirm.hidden &&
    target?.closest("#new-game-confirm, #new-game") === null
  ) {
    setConfirmOpen(false);
    dismissed = true;
  }
  dismissingPress = dismissed;
});
elements.newGame.addEventListener("click", requestNewGame);
elements.confirmNewGame.addEventListener("click", startNewGame);
document
  .getElementById("resume-game")
  .addEventListener("click", () => setConfirmOpen(false));
document.getElementById("share").addEventListener("click", () => {
  share().catch((error) => {
    if (error && error.name === "AbortError") {
      return;
    }
    console.error(error);
    setStatus(`Share failed: ${error && error.message ? error.message : error}`, 4000);
  });
});

/* Share -------------------------------------------------------------------- */

const SHARE_SCALE = 2;
const SHARE_PAD = 12;
const SHARE_GAP = 10;
const SHARE_CELL = 72;
const SHARE_TILE_GAP = 8;

// Colors are read back off the live elements rather than repeated here, so the
// stylesheet stays the only place a tile color is written down.
const colors = new Map();

function paintedColor(className) {
  if (!colors.has(className)) {
    const probe = document.createElement("div");
    probe.className = className;
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    document.body.append(probe);
    colors.set(className, getComputedStyle(probe).backgroundColor);
    probe.remove();
  }
  return colors.get(className);
}

function drawShareBoard(context, x, y) {
  const step = SHARE_CELL + SHARE_TILE_GAP;
  for (let cell = 0; cell < SIZE * SIZE; cell += 1) {
    const value = game.cells[Math.floor(cell / SIZE)][cell % SIZE];
    const left = x + (cell % SIZE) * step;
    const top = y + Math.floor(cell / SIZE) * step;

    context.fillStyle = value
      ? paintedColor(`tile-face ${tileClass(value)}`)
      : paintedColor("cell");
    context.beginPath();
    context.roundRect(left, top, SHARE_CELL, SHARE_CELL, 6);
    context.fill();

    if (!value) {
      continue;
    }
    const ratio = value < 128 ? 0.5 : value < 1024 ? 0.43 : 0.36;
    context.fillStyle = "#fff";
    context.font = `${SHARE_CELL * ratio}px ${getComputedStyle(elements.panel).fontFamily}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(String(value), left + SHARE_CELL / 2, top + SHARE_CELL / 2);
  }
}

/**
 * Draw the pieces worth sharing -- the two header lines, then the board with the stats
 * and whatever the game has to say under it -- so the buttons are left out.
 *
 * Above and below are both lists, and the layout counts them rather than knowing how
 * many there are, so the header growing a second line moved nothing here but the list
 * it is named in.
 *
 * The message is taken from the game rather than off the line it shares with the
 * instructions, so an image made on a quiet board carries no line at all instead of a
 * copy of the keyboard help.
 *
 * Type comes off the panel itself rather than from numbers written down here, so the
 * shared image cannot end up in a different face or size than the page it is of.
 */
function renderShareImage() {
  const boardSize = SHARE_CELL * SIZE + SHARE_TILE_GAP * (SIZE - 1);
  const panelStyle = getComputedStyle(elements.scoreLine);
  const font = `${panelStyle.fontSize} ${panelStyle.fontFamily}`;
  const lineHeight = Math.round(parseFloat(panelStyle.fontSize) * 1.5);
  const aboveBoard = [elements.scoreLine.textContent, elements.progressLine.textContent];
  const belowBoard = [elements.stats.textContent, message].filter(Boolean);
  const lines = [...aboveBoard, ...belowBoard];

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  context.font = font;
  const width = Math.max(
    boardSize,
    ...lines.map((line) => context.measureText(line).width)
  );
  const height =
    lineHeight * aboveBoard.length +
    SHARE_GAP +
    boardSize +
    SHARE_GAP +
    lineHeight * belowBoard.length;

  canvas.width = (width + SHARE_PAD * 2) * SHARE_SCALE;
  canvas.height = (height + SHARE_PAD * 2) * SHARE_SCALE;
  context.scale(SHARE_SCALE, SHARE_SCALE);
  context.fillStyle = getComputedStyle(elements.panel).backgroundColor;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const text = (line, y) => {
    context.fillStyle = panelStyle.color;
    context.font = font;
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillText(line, SHARE_PAD, y + lineHeight / 2);
  };

  let y = SHARE_PAD;
  for (const line of aboveBoard) {
    text(line, y);
    y += lineHeight;
  }
  y += SHARE_GAP;
  drawShareBoard(context, SHARE_PAD + (width - boardSize) / 2, y);
  y += boardSize + SHARE_GAP;
  for (const line of belowBoard) {
    text(line, y);
    y += lineHeight;
  }
  return canvas;
}

async function share() {
  const canvas = renderShareImage();
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error("Screenshot encoding failed"))),
      "image/png"
    );
  });

  const filename = `2048-score-${game.score}.png`;
  const file = new File([blob], filename, { type: "image/png" });
  // The image carries the asterisk on its own, since it is drawn from the score line as
  // it stands. This sentence is built here rather than read off the page, so it is the
  // one place the mark has to be repeated by hand.
  const replayed = game.replayed
    ? `, played on from move ${count(game.replayedFrom)}`
    : "";
  const payload = {
    files: [file],
    title: "2048",
    text:
      `2048: ${count(game.score)} points in ${count(game.moves)} moves${replayed}.`,
  };
  if (navigator.canShare && navigator.canShare(payload)) {
    await navigator.share(payload);
    return;
  }

  // No file sharing: desktop Chrome/Firefox never offer it, and every browser hides
  // the Web Share API on insecure origins -- which is what a phone hitting this page
  // over a LAN IP gets. Save the screenshot instead and name the reason, because
  // "insecure origin" is fixable by serving over localhost or https.
  //
  // Inert where this page is published as an Artifact: that viewer refuses a download a
  // page starts itself, so the link does nothing and the message below overstates what
  // happened. It works everywhere the demo is served from.
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  setStatus(
    window.isSecureContext
      ? `This browser cannot share files; saved ${filename}.`
      : `Sharing needs a secure origin (localhost or https); saved ${filename}.`,
    6000
  );
}

/* Recovery ----------------------------------------------------------------- */

/**
 * A save the validator rejects is a permanent dead end on its own: every reload reads
 * the same bad key and fails the same way. Say what is wrong and offer the one action
 * that clears it, rather than discarding the save silently.
 */
function reportCorruptState(reason) {
  const heading = document.createElement("strong");
  heading.textContent = "Saved game was corrupt.";
  const detail = document.createElement("small");
  detail.textContent = reason;
  const consequence = document.createElement("small");
  consequence.textContent =
    "Starting fresh discards the saved game, the best scores and the best tiles.";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Start fresh";
  button.addEventListener("click", () => {
    // All of them: the saved score is validated against whichever best score its game
    // was scoring into, so clearing one and keeping the others is how this state is
    // reached in the first place.
    storage.removeItem(GAME_STATE_KEY);
    storage.removeItem(BEST_SCORE_KEY);
    storage.removeItem(BEST_REPLAYED_SCORE_KEY);
    storage.removeItem(BEST_TILE_KEY);
    storage.removeItem(BEST_REPLAYED_TILE_KEY);
    location.reload();
  });

  elements.overlay.replaceChildren(
    heading,
    document.createElement("br"),
    detail,
    document.createElement("br"),
    consequence,
    document.createElement("br"),
    button
  );
  elements.overlay.hidden = false;
  setStatus(`Saved game was corrupt: ${reason}`);
}

/* Startup ------------------------------------------------------------------ */

// Replaced by start() with the game that carries the stored best figures. The empty
// stand-in is what the frame loop reads if one of those figures is itself rejected.
let game = new Game();

function restoreGame() {
  game = new Game({
    best: loadBest(BEST_SCORE_KEY, "best score"),
    replayedBest: loadBest(BEST_REPLAYED_SCORE_KEY, "replayed best score"),
    bestTile: loadBest(BEST_TILE_KEY, "best tile"),
    replayedBestTile: loadBest(BEST_REPLAYED_TILE_KEY, "replayed best tile"),
  });
  const serialized = storage.getItem(GAME_STATE_KEY);
  if (serialized === null) {
    return false;
  }
  // Only the scores bound the save. The tiles are read back off the boards it carries,
  // which is why they are not passed in: see Game.restore.
  const saved = decodeSavedState(serialized, {
    best: game.best,
    replayedBest: game.replayedBest,
  });
  game.restore(saved);
  // The restore can raise a best tile -- off a save written before tiles were tracked at
  // all, whose stored figure is a zero the boards disprove -- and the next thing the
  // player does may be to start a new game, which discards the only board that proved
  // it. So it is written down here rather than left to the first move that raises
  // something.
  saveBests();
  playTime.set(saved.playSeconds, clockRuns());
  return true;
}

/** Restore or begin a game. False means startup stalled on a corrupt save. */
function start() {
  let restored;
  try {
    restored = restoreGame();
  } catch (error) {
    if (!(error instanceof SaveError)) {
      throw error;
    }
    reportCorruptState(error.message);
    return false;
  }

  if (restored) {
    // At rest, unlike a state scrubbed to: reopening a save is not a move arriving,
    // however far back the state it opens on sits.
    //
    // A replayed game says so on the way in. The asterisk it reopens with is a mark
    // whose meaning has to be learned; the sentence beside it, once, is where it can be
    // learned from -- and the move it names is the one thing the mark cannot carry.
    repaint(
      undefined,
      game.replayed
        ? `Saved game restored, replayed from move ${count(game.replayedFrom)}.`
        : "Saved game restored."
    );
    saver.defer();
  } else {
    startNewGame();
  }
  return true;
}

function frame(now) {
  requestAnimationFrame(frame);
  // Before anything else: this runs in the same frame as the keypress that started the
  // move, so the tiles are placed for their first painted frame rather than after it.
  stepSlide(now);
  stepBursts(now);
  stepIndicator(now);
  frameTiming.sample(now);

  const playSeconds = playTime.elapsed();
  // acceptingInput doubles as "startup succeeded": with the recovery overlay up, an
  // interval save would quietly overwrite the very state the user is being asked about.
  if (acceptingInput) {
    saver.saveIfDue(game, playSeconds);
  }
  saver.refreshMetrics(now);
  if (now - lastStatsPaint >= STATS_REFRESH_MS) {
    lastStatsPaint = now;
    paintPlayTime(playSeconds);
    paintStats();
  }
}

let lastStatsPaint = 0;

elements.grid.replaceChildren(
  ...Array.from({ length: SIZE * SIZE }, () => {
    const cell = document.createElement("div");
    cell.className = "cell";
    return cell;
  })
);

paintHelp();
compactMedia.addEventListener("change", () => {
  paintHelp();
  resizeBoard();
});
// The chart is redrawn on its own rather than from inside resizeBoard, which returns
// early when the cell size has not moved: the play area can change width without the
// board changing size at all, and the graph is as wide as the panel either way.
new ResizeObserver(() => {
  resizeBoard();
  paintChart();
}).observe(elements.main);

// Only now is there a game to receive input, so a corrupt save leaves input off while
// the recovery overlay is up.
acceptingInput = start();
resizeBoard();
requestAnimationFrame(frame);
