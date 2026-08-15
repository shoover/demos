/**
 * Everything that touches the page: painting, animation, input, and localStorage.
 * board.js holds the rules and knows nothing about any of this.
 */

import { SIZE, Game, SaveError, decodeSavedState } from "./board.js";

const BEST_SCORE_KEY = "vanilla-2048.bestScore";
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
  score: document.getElementById("score"),
  playTimeLabel: document.getElementById("play-time"),
  help: document.getElementById("help"),
  stats: document.getElementById("stats"),
  boardWrap: document.getElementById("board-wrap"),
  board: document.getElementById("board"),
  grid: document.getElementById("grid"),
  tiles: document.getElementById("tiles"),
  overlay: document.getElementById("overlay"),
  nextMove: document.getElementById("next-move"),
  timeTravel: document.getElementById("time-travel"),
  timeline: document.getElementById("timeline"),
  scrubber: document.getElementById("scrubber"),
  stepBack: document.getElementById("step-back"),
  stepForward: document.getElementById("step-forward"),
  latest: document.getElementById("latest"),
  timelineLabel: document.getElementById("timeline-label"),
};

const compactMedia = window.matchMedia(
  document.getElementById("compact-styles").media
);

const count = (value) => value.toLocaleString("en-US");

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

function loadBestScore() {
  const value = storage.getItem(BEST_SCORE_KEY);
  if (value === null) {
    return 0;
  }
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new SaveError(`Invalid stored 2048 best score: ${value}`);
  }
  return Number(value);
}

function saveBestScore(value) {
  storage.setItem(BEST_SCORE_KEY, String(value));
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

// No move count here: the scrubber's own label shares this line and carries it, against
// the total the game has reached, which is more than this half ever said.
function paintScore() {
  elements.score.textContent =
    `Score: ${count(game.score)}  |  Best: ${count(game.best)}`;
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
  // Two different readings, so two different words for them. At the latest state the
  // number is how many moves have been played, and reads as a total; scrubbed back it is
  // which move is on screen, one of a set, and needs that set beside it to mean anything.
  // The label ends the score line, with nothing to its right, so the two forms can be as
  // wide as they like: the line wraps before anything is pushed out of place.
  elements.timelineLabel.textContent = game.atLatest
    ? `Moves: ${count(game.moves)}`
    : `Move ${count(game.moves)}/${count(game.latest.moves)}`;
  elements.board.classList.toggle("past", !game.atLatest);
  for (const button of dpadButtons) {
    button.disabled = !game.atLatest;
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
  elements.timeline.hidden = !open;
  elements.timeTravel.setAttribute("aria-expanded", String(open));
  if (open) {
    elements.scrubber.focus();
  } else if (elements.timeline.contains(document.activeElement)) {
    elements.timeTravel.focus();
  }
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
function paintPlayTime(playSeconds) {
  elements.playTimeLabel.textContent = `Play time: ${playSeconds.toFixed(0)}s`;
}

function paintStats() {
  elements.stats.textContent =
    `FPS: ${frameTiming.fps.toFixed(0)}` +
    ` | Worst: ${frameTiming.summary()}` +
    ` | Save p50/90/99: ${saver.summary()}`;
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

function startNewGame() {
  const spawned = game.reset();
  slide = null;
  lastMoveAt = -Infinity;
  // Every control in it is about to be disabled: a new game has nowhere to scrub to.
  setTimelineOpen(false);
  paintSettled({ appeared: new Set(spawned) });
  paintScore();
  paintTimeline();
  // Just the news: the line it is standing in already says how to play, and saying it
  // again in fewer words would be the one thing this message costs.
  setMessage("New game.");
  playTime.set(0, false);
  saver.save(game, 0);
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
  paintSettled(game.arrival);
  paintScore();
  paintTimeline();
  paintMessage();
}

function applyMove(direction) {
  const now = performance.now();
  if (!acceptingInput || now - lastMoveAt < INPUT_THROTTLE_MS) {
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

  paintScore();
  paintTimeline();
  paintMessage();
  const playSeconds = playTime.elapsed();
  playTime.set(playSeconds, !game.gameOver);
  if (result.bestChanged) {
    saveBestScore(game.best);
  }
  saver.save(game, playSeconds);
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
    startNewGame();
  } else {
    applyMove(action);
  }
}, { passive: false });

let touchStart = null;

elements.main.addEventListener("touchstart", (event) => {
  // Buttons handle their own taps: swallowing the touch here would cost them the
  // click the browser synthesizes from it. The popup is skipped whole, because
  // dragging the scrubber is a swipe by any measure taken here.
  if (event.touches.length !== 1 || event.target.closest("button, #timeline")) {
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
onPress(elements.stepBack, () => showState(game.cursor - 1));
onPress(elements.stepForward, () => showState(game.cursor + 1));
onPress(elements.timeTravel, () => {
  if (elements.timeline.hidden) {
    setTimelineOpen(true);
  } else {
    closeTimeline();
  }
});
elements.latest.addEventListener("click", () => showState(game.timeline.length - 1));
elements.scrubber.addEventListener("input", () =>
  showState(Number(elements.scrubber.value))
);

// Dismissed by a press anywhere else -- the board included, since a swipe there is a
// move rather than an accident. Not the clock, which has its own press to close, and
// not the popup itself. Escape closes it too; see the key handler.
document.addEventListener("pointerdown", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!elements.timeline.hidden && target?.closest("#timeline, #time-travel") === null) {
    closeTimeline();
  }
});
document.getElementById("new-game").addEventListener("click", startNewGame);
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
 * Draw the pieces worth sharing -- the score line, then the board with the stats and
 * whatever the game has to say under it -- so the buttons are left out.
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
  const belowBoard = [elements.stats.textContent, message].filter(Boolean);
  const lines = [elements.scoreLine.textContent, ...belowBoard];

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  context.font = font;
  const width = Math.max(
    boardSize,
    ...lines.map((line) => context.measureText(line).width)
  );
  const height =
    lineHeight + SHARE_GAP + boardSize + SHARE_GAP + lineHeight * belowBoard.length;

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
  text(lines[0], y);
  y += lineHeight + SHARE_GAP;
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
  const payload = {
    files: [file],
    title: "2048",
    text: `2048: ${count(game.score)} points in ${count(game.moves)} moves.`,
  };
  if (navigator.canShare && navigator.canShare(payload)) {
    await navigator.share(payload);
    return;
  }

  // No file sharing: desktop Chrome/Firefox never offer it, and every browser hides
  // the Web Share API on insecure origins -- which is what a phone hitting this page
  // over a LAN IP gets. Save the screenshot instead and name the reason, because
  // "insecure origin" is fixable by serving over localhost or https.
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
  consequence.textContent = "Starting fresh discards the saved game and the best score.";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Start fresh";
  button.addEventListener("click", () => {
    // Both keys: the saved score is validated against the best score, so clearing one
    // and keeping the other is how this state is reached.
    storage.removeItem(GAME_STATE_KEY);
    storage.removeItem(BEST_SCORE_KEY);
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

// Replaced by start() with the game that carries the stored best score. The empty
// stand-in is what the frame loop reads if the stored best score is itself rejected.
let game = new Game();

function restoreGame() {
  game = new Game({ best: loadBestScore() });
  const serialized = storage.getItem(GAME_STATE_KEY);
  if (serialized === null) {
    return false;
  }
  const saved = decodeSavedState(serialized, game.best);
  game.restore(saved);
  // The clock belongs to the game, not to the state being looked at: it runs whenever
  // the newest state is a game under way, however far back the scrubber was left.
  playTime.set(saved.playSeconds, game.latest.moves > 0 && !game.latest.gameOver);
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
    paintMessage("Saved game restored.");
    paintScore();
    paintTimeline();
    // At rest, unlike a state scrubbed to: reopening a save is not a move arriving,
    // however far back the state it opens on sits.
    paintSettled();
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
new ResizeObserver(resizeBoard).observe(elements.main);

// Only now is there a game to receive input, so a corrupt save leaves input off while
// the recovery overlay is up.
acceptingInput = start();
resizeBoard();
requestAnimationFrame(frame);
