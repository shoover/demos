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
// A held key or a hammered button must not start a move before the previous one has
// landed, so the throttle is a property of the slide rather than of any one input
// device. Every input path funnels through applyMove.
const INPUT_THROTTLE_MS = SLIDE_MS * 1.5;
const SAVE_INTERVAL_MS = 5000;
const SAVE_LATENCY_CAPACITY = 256;
const SAVE_METRICS_REFRESH_MS = 1000;
const STATS_REFRESH_MS = 250;
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

const elements = {
  status: document.getElementById("status"),
  panel: document.getElementById("panel"),
  main: document.querySelector("main"),
  score: document.getElementById("score"),
  help: document.getElementById("help"),
  message: document.getElementById("message"),
  stats: document.getElementById("stats"),
  boardWrap: document.getElementById("board-wrap"),
  board: document.getElementById("board"),
  grid: document.getElementById("grid"),
  tiles: document.getElementById("tiles"),
  overlay: document.getElementById("overlay"),
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

/* Frame rate --------------------------------------------------------------- */

const frameRate = {
  value: 0,
  frames: 0,
  windowStart: 0,

  sample(now) {
    this.frames += 1;
    const elapsed = now - this.windowStart;
    if (elapsed >= 500) {
      this.value = (this.frames * 1000) / elapsed;
      this.frames = 0;
      this.windowStart = now;
    }
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

function paintScore() {
  elements.score.textContent =
    `Score: ${count(game.score)}  |  Moves: ${count(game.moves)}  |  Best: ${count(game.best)}`;
}

function paintStats(playSeconds) {
  elements.stats.textContent =
    `FPS: ${frameRate.value.toFixed(0)}` +
    ` | Play time: ${playSeconds.toFixed(0)}s` +
    ` | Save p50/90/99: ${saver.summary()}`;
}

function setMessage(text) {
  elements.message.textContent = text;
}

function paintHelp() {
  elements.help.textContent = compactMedia.matches
    ? "Swipe to move. R restarts."
    : "Keyboard: arrows/WASD, swipe, R to restart";
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
  paintSettled({ appeared: new Set(spawned) });
  paintScore();
  setMessage("New game. Use arrow keys, WASD, or the buttons.");
  playTime.set(0, false);
  saver.save(game, 0);
}

function applyMove(direction) {
  const now = performance.now();
  if (!acceptingInput || now - lastMoveAt < INPUT_THROTTLE_MS) {
    return;
  }

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
  setMessage(game.gameOver ? GAME_OVER_MESSAGE : "");
  const playSeconds = playTime.elapsed();
  playTime.set(playSeconds, !game.gameOver);
  if (result.bestChanged) {
    saveBestScore(game.best);
  }
  saver.save(game, playSeconds);
}

/* Input -------------------------------------------------------------------- */

const KEYS = new Map([
  ["arrowup", "up"], ["w", "up"],
  ["arrowdown", "down"], ["s", "down"],
  ["arrowleft", "left"], ["a", "left"],
  ["arrowright", "right"], ["d", "right"],
  ["r", "restart"],
]);

window.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  const action = KEYS.get(event.key.toLowerCase());
  if (!action) {
    return;
  }
  event.preventDefault();
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
  // click the browser synthesizes from it.
  if (event.touches.length !== 1 || event.target.closest("button")) {
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

for (const direction of ["up", "down", "left", "right"]) {
  document.getElementById(direction).addEventListener("click", () => applyMove(direction));
}
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
 * Draw the pieces worth sharing -- the score line, then the board with the message
 * and stats under it -- so the buttons and help text between them are left out.
 *
 * Type comes off the panel itself rather than from numbers written down here, so the
 * shared image cannot end up in a different face or size than the page it is of.
 */
function renderShareImage() {
  const boardSize = SHARE_CELL * SIZE + SHARE_TILE_GAP * (SIZE - 1);
  const panelStyle = getComputedStyle(elements.score);
  const font = `${panelStyle.fontSize} ${panelStyle.fontFamily}`;
  const lineHeight = Math.round(parseFloat(panelStyle.fontSize) * 1.5);
  const lines = [
    elements.score.textContent,
    elements.message.textContent,
    elements.stats.textContent,
  ];

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  context.font = font;
  const width = Math.max(
    boardSize,
    ...lines.map((line) => context.measureText(line).width)
  );
  const height = lineHeight + SHARE_GAP + boardSize + SHARE_GAP + lineHeight * 2;

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
  text(lines[1], y);
  y += lineHeight;
  text(lines[2], y);
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
  playTime.set(saved.playSeconds, saved.moves > 0 && !saved.gameOver);
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
    setMessage(`Saved game restored.${game.gameOver ? ` ${GAME_OVER_MESSAGE}` : ""}`);
    paintScore();
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
  frameRate.sample(now);

  const playSeconds = playTime.elapsed();
  // acceptingInput doubles as "startup succeeded": with the recovery overlay up, an
  // interval save would quietly overwrite the very state the user is being asked about.
  if (acceptingInput) {
    saver.saveIfDue(game, playSeconds);
  }
  saver.refreshMetrics(now);
  if (now - lastStatsPaint >= STATS_REFRESH_MS) {
    lastStatsPaint = now;
    paintStats(playSeconds);
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
