/**
 * Everything that touches the page: painting, animation, input, and localStorage.
 * board.js holds the rules and knows nothing about any of this.
 */

import { SIZE, Game, SaveError, decodeSavedState, replaySpawns, topTileOf } from "./board.js";
import { abbreviate, count, formatDuration, scoreLine, scoreTitle } from "./format.js";
import { binGame } from "./stats.js";
import {
  ArchiveError,
  ENDED_DISCARDED,
  ENDED_GAME_OVER,
  ENDED_PLAYING,
  TREND_GAMES,
  addGame,
  archiveStats,
  decodeArchive,
  encodeArchive,
  gameTrend,
  isClean,
  isPlaying,
  milestones,
  summarize,
} from "./archive.js";

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
  pastGames: document.getElementById("past-games"),
  archivePanel: document.getElementById("archive-panel"),
  archiveTracks: document.getElementById("archive-tracks"),
  archivePlayed: document.getElementById("archive-played"),
  archiveScored: document.getElementById("archive-scored"),
  archiveReached: document.getElementById("archive-reached"),
  archiveTrend: document.getElementById("archive-trend"),
  archiveTrendReadout: document.getElementById("archive-trend-readout"),
  archiveList: document.getElementById("archive-list"),
  archiveGame: document.getElementById("archive-game"),
  archiveGameTitle: document.getElementById("archive-game-title"),
  archiveChart: document.getElementById("archive-chart"),
  archiveReadout: document.getElementById("archive-readout"),
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
    !elements.archivePanel.hidden ||
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

/* Archive ------------------------------------------------------------------- */

/**
 * The games that are over, and the moves of the ones that were recorded.
 *
 * Two stores, because the two records are read at different times and are three orders
 * of magnitude apart in size. The rows are small, are wanted all at once every time the
 * list is opened, and have to be readable wherever the game is -- so they sit in
 * localStorage beside the save, where reading them is a parse and nothing else. The
 * spawn logs are the moves themselves, are wanted one at a time and only when a row is
 * opened, and are bytes rather than text -- so they sit in IndexedDB, one record per
 * game, where a log can be fetched without the other nine hundred coming with it and a
 * byte costs a byte instead of the 1.33 base64 would charge.
 *
 * The split also decides what happens when only one of them works. IndexedDB is refused
 * in places localStorage is not, and a list that still lists is worth more than a replay
 * that never arrives: a row whose log cannot be stored is still a row, and says so.
 */
const ARCHIVE_KEY = "vanilla-2048.archive.v1";
// Which game the save in GAME_STATE_KEY is, so a reload can tell whether the game it
// finds is one the archive has already been told about. Kept beside the save rather than
// inside it for the reason the best scores are: it is bookkeeping about the game, not
// part of the board, and board.js has no business knowing this list exists.
const CURRENT_GAME_KEY = "vanilla-2048.currentGame";
// When the game in GAME_STATE_KEY was first played, beside the id that names it. Its own
// key rather than a field inside the save, for the same reason the id is: it is
// bookkeeping about the game rather than part of the board, and board.js has no business
// knowing this list exists.
const CURRENT_GAME_STARTED_KEY = "vanilla-2048.currentGameStarted";
const LOG_DB_NAME = "vanilla-2048";
const LOG_DB_VERSION = 1;
const LOG_STORE = "spawns";

// The archive as it stands, newest game first, and what went wrong reading it. A fault
// is reported in the panel where the list would have been: the game is entirely
// playable without its own history, so this must not reach the recovery overlay, which
// is for a save that leaves nothing to play.
let archive = [];
let archiveFault = null;

/** The id of the game being played, which the archive files its row under. */
let currentGameId = null;

/**
 * When the game being played was first moved, or null before its first move.
 *
 * The first move rather than the moment the board was dealt, which is the same question
 * the play clock answers and is answered the same way: a board sitting untouched is not a
 * game under way. Opening the page at midnight and playing at eight would otherwise file
 * a game that started at midnight and took eight minutes.
 *
 * Set once per game and never moved. A take-back can walk a game back to its first move
 * again, and that does not make it a new game or a later one.
 */
let currentGameStarted = null;

/** Note the first move of a game, so the archive can say when it began. */
function markGameStarted() {
  if (currentGameStarted !== null) {
    return;
  }
  currentGameStarted = Date.now();
  storage.setItem(CURRENT_GAME_STARTED_KEY, String(currentGameStarted));
}

/** The stored start time of the game in progress, or null where there is none. */
function loadGameStarted() {
  const value = storage.getItem(CURRENT_GAME_STARTED_KEY);
  if (value === null) {
    return null;
  }
  // A stored figure that is not a time is not a time to guess at: the game keeps playing
  // and its row says it does not know when it began, which is what a game finished
  // before this was recorded says too.
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

// Enough to tell a thousand games apart in one browser, which is the whole job: the id
// is a key into two local stores and is never seen by anyone. crypto.randomUUID would do
// it too, and is unavailable on exactly the insecure origins this demo is often served
// from -- so this asks for nothing rather than branching on what it was given.
const newGameId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function loadArchive() {
  try {
    archive = decodeArchive(storage.getItem(ARCHIVE_KEY));
    archiveFault = null;
  } catch (error) {
    if (!(error instanceof ArchiveError)) {
      throw error;
    }
    // The rows are left empty rather than partially recovered. Half an archive read past
    // a bad row is a set of figures computed over an unknown fraction of the games, and
    // there is nothing on screen that could say which fraction.
    archive = [];
    archiveFault = error.message;
  }
}

function persistArchive() {
  storage.setItem(ARCHIVE_KEY, encodeArchive(archive));
}

/* Spawn log store ----------------------------------------------------------- */

// Opened once and shared. Null resolves where IndexedDB is refused -- a sandboxed frame,
// a private window, a browser told to block site data -- which is the same known case
// the localStorage shim above handles, and is handled the same way: the feature that
// needs it goes quiet, and the row says the moves were not kept.
let logDatabase = null;

function openLogStore() {
  if (logDatabase === null) {
    logDatabase = new Promise((resolve) => {
      let request;
      try {
        request = indexedDB.open(LOG_DB_NAME, LOG_DB_VERSION);
      } catch {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => request.result.createObjectStore(LOG_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      // Another tab holding the old version open. Waiting for it would hang the panel on
      // a promise that may never settle, and the list does not need the logs to open.
      request.onblocked = () => resolve(null);
    });
  }
  return logDatabase;
}

/** Run `work` against the log store, or resolve `fallback` where there is no store. */
async function withLogStore(mode, work, fallback) {
  const database = await openLogStore();
  if (database === null) {
    return fallback;
  }
  return new Promise((resolve) => {
    const transaction = database.transaction(LOG_STORE, mode);
    const request = work(transaction.objectStore(LOG_STORE));
    transaction.onerror = () => resolve(fallback);
    transaction.onabort = () => resolve(fallback);
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Everything a finished game can be drawn from again: its spawns, and where it was
 * taken back.
 *
 * The spawns are stored as bytes rather than as the base64 the save carries, because
 * IndexedDB takes a typed array as it stands -- so the log costs exactly the one byte a
 * move it was designed to, and the third the save pays to be text is not paid twice.
 *
 * The undo positions ride along because they are the one thing replay cannot recover.
 * The log holds the line of play that survived, so a take-back leaves no trace in it;
 * the tallies were counted while the game was played, and if they are not written down
 * beside it the graph comes back with an empty lane under a legend that promises one.
 * They are here rather than on the archive row for the same reason the log is: the row
 * is read every time the list opens, and this is read when a game is opened.
 */
const storeGameRecord = (id, spawns, undos) =>
  withLogStore(
    "readwrite",
    (store) => store.put({ spawns: Uint8Array.from(spawns), undos }, id),
    undefined
  );

const readGameRecord = async (id) => {
  const record = await withLogStore("readonly", (store) => store.get(id), undefined);
  return record === undefined
    ? null
    : { spawns: Array.from(record.spawns), undos: record.undos };
};

/**
 * Drop the logs of games the archive no longer lists.
 *
 * A full reconcile rather than a delete beside each eviction: the rows are what say
 * which games exist, so anything in the store without a row is weight with nothing to
 * reach it by -- whether it was evicted past ARCHIVE_LIMIT, lost with a cleared archive,
 * or left by a build that wrote its rows somewhere else. It runs once per finished game,
 * against a list of keys, which is far too cheap to be worth being cleverer about.
 */
async function pruneSpawnLogs() {
  const kept = new Set(archive.map((row) => row.id));
  // The game being played has no row yet and its record is already being written, so it
  // is not an orphan -- it is the one record in the store whose game has not ended.
  // Without this the prune that follows one game ending deletes the next game's record
  // out from under it.
  kept.add(currentGameId);
  const stored = await withLogStore("readonly", (store) => store.getAllKeys(), []);
  const orphans = stored.filter((id) => !kept.has(id));
  if (orphans.length > 0) {
    await withLogStore(
      "readwrite",
      (store) => {
        for (const id of orphans.slice(0, -1)) {
          store.delete(id);
        }
        // The last one's request is the one the transaction is watched through; the rest
        // ride the same transaction and land with it.
        return store.delete(orphans[orphans.length - 1]);
      },
      undefined
    );
  }
}

/**
 * Write the game being played into the record store, under the id its row will carry.
 *
 * On the save's own cadence rather than every move. A move costs a byte and an
 * IndexedDB transaction costs a millisecond, so writing per move would spend a
 * millisecond to durably record one byte -- and buy nothing, because the log is already
 * inside the five-second save beside it and a reload restores from that.
 *
 * What it does buy is the window at the end of a game. archiveGame writes the row and
 * fires the record off without waiting, so a tab closed in between leaves a row claiming
 * moves that were never stored. Keeping the record current as the game is played closes
 * that: by the time a game ends, everything but its last few moves is already down.
 */
function storeLiveRecord() {
  if (game.spawns === null || game.latest.moves === 0) {
    return;
  }
  storeGameRecord(currentGameId, game.spawns, liveUndos());
}

/** The undo tallies as the archive stores them: sparse, keyed by the move taken back to. */
const liveUndos = () =>
  Object.fromEntries(
    game.history.filter((entry) => entry.undos > 0).map((entry) => [entry.moves, entry.undos])
  );

/**
 * Write the game as it now stands into the archive.
 *
 * How it ended is read off the board rather than passed in by the caller, which is what
 * keeps a row honest through the one sequence that would otherwise break it: a finished
 * game can be taken back into a playable one and played on, so a row filed once as over
 * would go on describing a game that is no longer over. Every path that can end a game
 * calls this, the row is filed under the game's id, and the newest telling replaces the
 * last -- so the archive holds what the game finally came to however many times it was
 * asked.
 *
 * A board still on its opening tiles is not a game and is not filed. Nothing was played,
 * so there is nothing the list could say about it that its absence does not.
 */
function archiveGame() {
  const latest = game.latest;
  if (latest.moves === 0) {
    return;
  }
  const row = summarize({
    id: currentGameId,
    startedAt: currentGameStarted,
    endedAt: Date.now(),
    ending: latest.gameOver ? ENDED_GAME_OVER : ENDED_DISCARDED,
    score: latest.score,
    // Off the newest board, not the one on screen: the game is what is being filed, and
    // the scrubber may well have been left somewhere in the middle of it.
    topTile: topTileOf(latest.cells),
    moves: latest.moves,
    undos: game.history.reduce((total, entry) => total + entry.undos, 0),
    seconds: playTime.elapsed(),
    replayedFrom: game.replayedFrom,
    recorded: game.spawns !== null,
  });
  archive = addGame(archive, row);
  persistArchive();
  if (game.spawns !== null) {
    // Not awaited: the archive row is what the list is made of and it is already
    // written, so the moves landing a beat later costs nothing on screen. Awaiting it
    // would put an IndexedDB round trip in front of the repaint that draws the game-over
    // board, which is the one frame of this that anybody sees. What makes that safe is
    // storeLiveRecord, which has been keeping this same record current all game: if this
    // write never lands, what is already stored is the game bar its last few moves.
    storeGameRecord(row.id, game.spawns, liveUndos()).then(pruneSpawnLogs);
  }
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
   * Interval save, skipped when the snapshot would be byte-identical. Reports whether it
   * wrote, which is what the record store hangs off: the moves are worth putting down
   * again exactly when the game they belong to was.
   *
   * Play time is the only field that moves without a move being made, so once the
   * board is finished -- or merely idle, since the play clock pauses with the tab --
   * the interval save would rewrite the same bytes until the tab closes.
   */
  saveIfDue(game, playSeconds) {
    if (performance.now() - this.lastSaveTime < SAVE_INTERVAL_MS) {
      return false;
    }
    if (game.encode(playSeconds) === this.lastState) {
      this.defer();
      return false;
    }
    this.save(game, playSeconds);
    return true;
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
  if (open && !elements.archivePanel.hidden) {
    setArchiveOpen(false);
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
function chartReadout(stats, hovered) {
  // The one place a figure here is not a bare number: "1 undos" reads as a bug in a line
  // that is otherwise plain English.
  const undos = (total) => `${count(total)} ${total === 1 ? "undo" : "undos"}`;
  const bin = hovered === null ? null : stats.bins[hovered];
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
 *
 * Takes its canvas and its binned game rather than reaching for the live ones, because
 * there are two graphs now: the one the game is drawing as it is played, and the one an
 * archived game is redrawn into when its row is opened. They are the same picture of the
 * same kind of thing, so they are the same code -- a second implementation would agree
 * with this one right up until the day one of them was changed.
 *
 * Returns the geometry the paint used, which is what turns a pointer position into the
 * bin under it. Only the live graph has a use for it; the archived one is not hovered.
 */
/**
 * A canvas cleared and ready to draw on, in CSS pixels, at the display's own resolution.
 *
 * Shared by both graphs in the panel, which are different pictures with identical
 * plumbing: measure the element, size the backing store to the device, scale the context
 * so everything above this can be written in the units the stylesheet is in.
 */
function chartContext(canvas) {
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
  return { context, width, height };
}

/** Write one of a graph's labels, in the panel's own face. */
function chartLabel(context, text, x, y, align) {
  context.fillStyle = CHART_LABEL_COLOR;
  context.font = `${CHART_LABEL_SIZE}px ${getComputedStyle(elements.panel).fontFamily}`;
  context.textAlign = align;
  context.textBaseline = "middle";
  context.fillText(text, x, y);
}

function drawChart(canvas, stats, hovered) {
  const { context, width, height } = chartContext(canvas);

  const plotLeft = CHART_GUTTER;
  const plotRight = width - CHART_PAD_RIGHT;
  const plotBottom = height - CHART_PAD_BOTTOM;
  const binPixels = (plotRight - plotLeft) / stats.bins.length;

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

  const label = (text, x, y, align) => chartLabel(context, text, x, y, align);

  // The bin being pointed at, behind everything: a band rather than a crosshair, since
  // what is being read off it is a span of moves and not a single one.
  if (hovered !== null) {
    context.fillStyle = CHART_HOVER_COLOR;
    context.fillRect(plotLeft + hovered * binPixels, CHART_PAD_TOP, binPixels, plotBottom - CHART_PAD_TOP);
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

  return { plotLeft, binPixels, binCount: stats.bins.length };
}

/**
 * The live graph: the game as it now stands, and the bin the pointer is on.
 *
 * Skipped outright while the popup is away, which is what lets this hang off paintPanel
 * and run on every move without asking anything about staleness.
 */
function paintChart() {
  if (elements.statsPanel.hidden) {
    return;
  }
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
  chartGeometry = drawChart(elements.chart, stats, hoveredBin);
  elements.chartReadout.textContent = chartReadout(stats, hoveredBin);
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
  if (open && !elements.archivePanel.hidden) {
    setArchiveOpen(false);
  }
  elements.statsPanel.hidden = !open;
  elements.graph.setAttribute("aria-expanded", String(open));
  // Whatever was under the pointer belonged to the last time it was open.
  hoveredBin = null;
  syncPlayState();
  paintChart();
}

/* Past games ---------------------------------------------------------------- */

// Which games the figures are computed over. Three rather than two, because "all" is a
// real question and not a missing filter: how much has been played is asked of
// everything, and how well is asked of one track or the other. The split is the score
// line's own -- a game played on from an earlier state is not the achievement a straight
// one is -- and it is drawn here for the same reason the asterisk is drawn there.
const ARCHIVE_TRACKS = {
  all: () => true,
  clean: isClean,
  replayed: (row) => !isClean(row),
};
let archiveTrack = "all";
// The game whose graph is open under the list, or null. Held by id rather than by row,
// because the list it was picked from is rebuilt on every paint.
let openedGame = null;

// The single-spaced bar the score line and the readings line under the board both use,
// rather than the wide one the chart readout is written with. These lines carry five
// fields on a panel as narrow as the board, and the four characters a wide divider costs
// each time are the difference between a line that fits and a line that wraps its last
// field onto a row of its own. The readout below the archived graph keeps the wide one:
// it is the live graph's own line, printed by the same function.
const FIELD = " | ";

/**
 * When a game began, at the width a list of them can be scanned down -- or a dash where
 * it is not known.
 *
 * A dash rather than a guess. The end time and the play clock are both on the row, and
 * subtracting one from the other looks like it would give the start, but the clock stops
 * with the tab: a game played over a lunch break would claim to have begun minutes
 * before it ended. So a game finished before start times were recorded says it does not
 * know, in the same en dash a tile no track ever landed is written with, and the column
 * heals as games are played.
 */
const formatStarted = (row) => (row.st === null ? "\u2013" : formatWhen(row.st));

/** A stored moment, at the width a list of them can be scanned down. */
function formatWhen(at) {
  const when = new Date(at);
  const date = when.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const time = when.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  });
  return `${date} ${time}`;
}

/**
 * The figures over the games being shown, in three lines.
 *
 * Split by what is being asked rather than by what is cheap to compute together: the
 * first line is how much has been played, the second is how well, and the third is how
 * far. Read down, they answer the three questions a list of finished games raises, and
 * none of the three lines is worth reading against the others.
 */
function archiveSummary(rows) {
  const stats = archiveStats(rows);
  const played = [
    `${count(stats.games)} ${stats.games === 1 ? "game" : "games"}`,
    `${count(stats.finished)} finished`,
    `${count(stats.totalMoves)} moves`,
    formatDuration(stats.totalSeconds),
    // Taking back sits on this line rather than among the scores, because it is a fact
    // about how the games were played and not about what they came to. Two readings of
    // it, for the reason archiveStats gives: a total says how much of it happens, and
    // the clean count says how often it happens at all.
    `${count(stats.totalUndos)} undos (${count(stats.gamesWithoutUndo)} clean)`,
  ];
  // Median and mean both, because 2048 scores are skewed and the two answer different
  // questions: see archiveStats. A median above the mean is the shape of a run of even
  // games; well below it, of one game that went much better than the rest.
  const scored = [
    `Best ${abbreviate(stats.bestScore)}`,
    `Median ${abbreviate(stats.medianScore)}`,
    `Mean ${abbreviate(stats.meanScore)}`,
    `${stats.pointsPerMove.toFixed(1)}/move`,
  ];
  return [played.join(FIELD), scored.join(FIELD)];
}

/**
 * How far the games got, as a funnel: how many reached each milestone tile.
 *
 * Milestones a game reached rather than the tile it finished on, so the counts nest --
 * every 2048 game is also a 1024 game. Read down it says where games stop, which is what
 * the largest tile alone cannot: a list of best tiles says what the peak was, and this
 * says how often it is reached.
 *
 * Milestones no game has reached are left out rather than printed as zeroes. A row of
 * zeroes above the tiles that were actually reached is a line about what has not
 * happened, and the line is read for what has.
 */
function archiveMilestones(rows) {
  const reached = milestones(rows).filter((milestone) => milestone.games > 0);
  if (reached.length === 0) {
    return "";
  }
  return `Reached${FIELD}${reached
    .map((milestone) => `${milestone.tile} ×${count(milestone.games)}`)
    .join(FIELD)}`;
}

/**
 * One row of the list: when the game was, what it was worth, and what it took.
 *
 * A button where the moves were kept and a plain row where they were not, which is the
 * whole of how the list says which is which. A row that cannot be opened does not look
 * like one that can, so nothing has to explain the difference in words -- and the games
 * that cannot be opened are the ones finished before the log existed, which will age out
 * of the archive on their own.
 *
 * The score carries its largest tile after a middot and its asterisk when the game was
 * replayed, which is the score line's own notation: a score in this demo has meant a
 * pair since tiles were tracked, and a list of them is no place to start meaning
 * something else.
 */
function archiveRow(row) {
  // The game on the board is not opened from here even though its moves are all
  // recorded: what opening a row does is draw that game's graph, and the live game's
  // graph is already one button along the row above. So it is a plain row, like a game
  // whose moves were never kept, and for a different reason.
  const openable = row.rec && !isPlaying(row);
  const element = document.createElement(openable ? "button" : "div");
  element.className = `archive-row${isPlaying(row) ? " playing" : ""}`;
  if (openable) {
    element.type = "button";
    element.dataset.id = row.id;
    element.setAttribute("aria-expanded", String(openedGame === row.id));
  }
  if (isPlaying(row)) {
    element.title = "The game on the board. Its graph is under the spark-line button.";
  }
  if (openedGame === row.id) {
    element.classList.add("opened");
  }
  const cell = (text, className, title) => {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    if (title) {
      span.title = title;
    }
    return span;
  };
  // A discarded game is marked where the reading it changes is, which is the score: it is
  // not what the game came to but what it had got to when it was thrown away.
  //
  // Marked by weight rather than by a glyph. The mark for it used to be a trailing
  // ellipsis, which is the one punctuation a reader already has a meaning for at the end
  // of a figure in a narrow column: text that did not fit. A column of "492·64…" reads as
  // a column of clipped numbers, and the more discarded games in the list the more the
  // whole table looks broken -- so the score is dimmed to the colour the labels are set
  // in instead, and nothing is appended to a number that is complete.
  //
  // The colour is not carrying it alone. A screen reader gets the word, the pointer gets
  // the sentence, and the line above the list gives the count -- so "how many of these
  // were played out" is answerable without seeing the dimming at all.
  const discarded = row.end === ENDED_DISCARDED;
  const score = cell(
    `${abbreviate(row.score)}·${row.tile === 0 ? "–" : row.tile}${isClean(row) ? "" : "*"}`,
    `archive-score${discarded ? " discarded" : ""}`,
    discarded ? "Discarded before the board ran out" : ""
  );
  if (discarded) {
    const note = document.createElement("span");
    note.className = "visually-hidden";
    note.textContent = " (discarded)";
    score.append(note);
  }
  element.append(
    // The live row names itself where the others name their start time. It has a start
    // time too, and it is on the row above in the panel's own clock -- what this column
    // is for here is telling you which row is the one you are playing.
    cell(isPlaying(row) ? "Playing now" : formatStarted(row), "archive-when"),
    score,
    cell(count(row.moves), "archive-moves"),
    cell(formatDuration(row.secs), "archive-secs"),
    cell(row.undos === 0 ? "–" : count(row.undos), "archive-undos")
  );
  return element;
}

/* The trend graph ----------------------------------------------------------- */

// The two lanes, top to bottom. The scores take the larger share: they are the series
// with a range worth drawing, while the tiles take a dozen values and are legible in a
// band. Same split of the plot the per-game graph uses, one lane fewer.
const TREND_LANES = { score: 0.62, tile: 0.38 };
// A tile mark is a dash rather than a bar, so its lane reads as a scatter of levels
// reached rather than as a second row of bars saying the same thing as the first.
const TREND_TILE_MARK = 2;
// The widest a single game's mark is allowed to get, as a share of the plot.
//
// Without a cap a mark is simply the slot it sits in, which is the whole plot when there
// is one game in the window -- and a bar as wide as the graph does not read as one game
// among others, it reads as a fill. The cap only binds under about four games; past that
// the slots are already narrower than this and nothing here changes.
//
// The per-game graph is deliberately left uncapped. Its axis is moves, so a wide bar
// there means a bin covering a wide span of them, which is true and worth seeing. This
// axis is games, where width means nothing at all.
const TREND_MAX_MARK = 0.25;
// How solid the game on the board is drawn, against the games that are over. Faint
// rather than a different colour: it is the same two series, and what is different about
// it is that it has not finished happening -- which is what a mark that has not settled
// into full strength says without needing a fourth colour to learn.
const TREND_LIVE_ALPHA = 0.45;
// Which game the pointer is over on the trend graph, and the geometry that paint used.
// Kept apart from the per-game graph's own pair rather than shared: the two are open at
// once, over different axes, and a pointer in one says nothing about the other.
let hoveredGame = null;
let trendGeometry = null;

/** The game under a canvas x on the trend graph, or null outside the plot. */
function gameAt(x) {
  if (trendGeometry === null) {
    return null;
  }
  const { plotLeft, gamePixels, count: games } = trendGeometry;
  const index = Math.floor((x - plotLeft) / gamePixels);
  return index < 0 || index >= games ? null : index;
}

/**
 * The trend graph in words: the window as a whole, or the game being pointed at.
 *
 * Both readings name their span first, the way the per-game graph's do, so pointing at a
 * game swaps one sentence for another of the same shape rather than adding one.
 */
function trendReadout(trend) {
  if (trend.games.length === 0) {
    return "";
  }
  const game = hoveredGame === null ? null : trend.games[hoveredGame];
  if (game === null) {
    const stamp = (row) => (isPlaying(row) ? "now" : formatWhen(row.at));
    // A window of one game is not a span, and "now to now" is what saying it as one
    // reads like. One game is named once.
    const span =
      trend.games.length === 1
        ? stamp(trend.games[0])
        : `${stamp(trend.games[0])} to ${stamp(trend.games[trend.games.length - 1])}`;
    return (
      `Last ${count(trend.games.length)} ${trend.games.length === 1 ? "game" : "games"}` +
      `${FIELD}${span}${FIELD}best ${abbreviate(trend.maxScore)}`
    );
  }
  // The same pair the score line prints, in the same notation: a score and the tile it
  // was reached on, with the asterisk a replayed game carries everywhere else.
  return (
    `${isPlaying(game) ? "Playing now" : formatStarted(game)}${FIELD}` +
    `${abbreviate(game.score)}·${game.tile === 0 ? "–" : game.tile}` +
    `${isClean(game) ? "" : "*"}${FIELD}${count(game.moves)} moves` +
    `${FIELD}${formatDuration(game.secs)}`
  );
}

/**
 * Draw the last games against each other: what each was worth, and how far each got.
 *
 * Two lanes rather than two scales on one axis, for the reason the per-game graph gives
 * at length: the series are measured in different units, and whichever one is squeezed to
 * fit looks like it crosses the other.
 *
 * The lanes are scaled differently on purpose, and it is the whole of what makes this
 * readable. Scores are counted from zero, because a bar twice as tall meaning twice the
 * points is the comparison the lane exists for. Tiles are not counted at all -- they are
 * levels, they double, and drawing them from zero on a linear axis would crush every
 * game into the bottom of the lane and leave the one that reached 2048 alone at the top.
 * So the tile lane is drawn in exponents, between the lowest and highest tile the window
 * actually holds, and both ends are labelled with the tile rather than the exponent so
 * nothing has to be read as a logarithm to be understood.
 *
 * Colours come off the legend swatches, the way the per-game graph's do: the stylesheet
 * stays the one place a colour is chosen.
 */
function drawTrend(canvas, trend) {
  const { context, width, height } = chartContext(canvas);
  if (trend.games.length === 0) {
    trendGeometry = null;
    return;
  }

  const plotLeft = CHART_GUTTER;
  const plotRight = width - CHART_PAD_RIGHT;
  const plotBottom = height - CHART_PAD_BOTTOM;
  const gamePixels = (plotRight - plotLeft) / trend.games.length;
  trendGeometry = { plotLeft, gamePixels, count: trend.games.length };

  const names = Object.keys(TREND_LANES);
  const laneRoom = plotBottom - CHART_PAD_TOP - CHART_LANE_GAP * (names.length - 1);
  const lanes = {};
  let laneTop = CHART_PAD_TOP;
  for (const [index, name] of names.entries()) {
    // The last lane is measured from the bottom rather than given its share, so the
    // rounding the one above leaves over lands inside it instead of pushing its baseline
    // out from under the axis labels.
    const bottom =
      index === names.length - 1
        ? plotBottom
        : laneTop + Math.round(laneRoom * TREND_LANES[name]);
    lanes[name] = { top: laneTop, bottom, height: bottom - laneTop };
    laneTop = bottom + CHART_LANE_GAP;
  }

  const centre = (index) => plotLeft + (index + 0.5) * gamePixels;
  const label = (text, x, y, align) => chartLabel(context, text, x, y, align);
  const headroom = (lane) => lane.height - CHART_LABEL_SIZE / 2;

  if (hoveredGame !== null) {
    context.fillStyle = CHART_HOVER_COLOR;
    context.fillRect(
      plotLeft + hoveredGame * gamePixels, CHART_PAD_TOP, gamePixels, plotBottom - CHART_PAD_TOP
    );
  }

  context.fillStyle = CHART_AXIS_COLOR;
  for (const lane of Object.values(lanes)) {
    context.fillRect(plotLeft, lane.bottom, plotRight - plotLeft, 1);
  }

  // The scores, from zero, one bar a game.
  const barWidth = Math.max(
    CHART_MIN_MARK,
    Math.min(gamePixels - CHART_BAR_GAP, (plotRight - plotLeft) * TREND_MAX_MARK)
  );
  context.fillStyle = paintedColor("swatch score");
  for (const [index, game] of trend.games.entries()) {
    if (game.score === 0 || trend.maxScore === 0) {
      continue;
    }
    context.globalAlpha = isPlaying(game) ? TREND_LIVE_ALPHA : 1;
    const barHeight = Math.max(
      CHART_MIN_MARK, (game.score / trend.maxScore) * headroom(lanes.score)
    );
    const radius = Math.min(CHART_BAR_RADIUS, barWidth / 2, barHeight / 2);
    context.beginPath();
    context.roundRect(
      centre(index) - barWidth / 2, lanes.score.bottom - barHeight, barWidth, barHeight,
      [radius, radius, 0, 0]
    );
    context.fill();
  }
  context.globalAlpha = 1;
  if (trend.maxScore > 0) {
    label(abbreviate(trend.maxScore), plotLeft - 6, lanes.score.top + CHART_LABEL_SIZE / 2, "right");
  }

  // The tiles, as levels: a dash a game, between the lowest and highest reached. A window
  // where every game reached the same tile has no range to spread across, so its dashes
  // sit on the lane's own middle rather than being divided by a span of nothing.
  const span = trend.maxTileExponent - trend.minTileExponent;
  const tileAt = (tile) => {
    const room = headroom(lanes.tile);
    if (span === 0) {
      return lanes.tile.bottom - room / 2;
    }
    return lanes.tile.bottom - ((Math.log2(tile) - trend.minTileExponent) / span) * room;
  };
  context.fillStyle = paintedColor("swatch tile");
  for (const [index, game] of trend.games.entries()) {
    if (game.tile === 0) {
      continue;
    }
    context.globalAlpha = isPlaying(game) ? TREND_LIVE_ALPHA : 1;
    context.fillRect(
      centre(index) - barWidth / 2, tileAt(game.tile) - TREND_TILE_MARK / 2,
      barWidth, TREND_TILE_MARK
    );
  }
  context.globalAlpha = 1;
  // Both ends named, and named as tiles: the lane is drawn in exponents and nobody reads
  // in exponents. A window with one tile in it says so once rather than labelling a range
  // it does not have.
  if (trend.tiled > 0) {
    const highest = 2 ** trend.maxTileExponent;
    label(String(highest), plotLeft - 6, tileAt(highest), "right");
    if (span > 0) {
      const lowest = 2 ** trend.minTileExponent;
      label(String(lowest), plotLeft - 6, tileAt(lowest), "right");
    }
  }

  // The axis is games rather than a measure, so its ends are named by when they were
  // played -- which is the one thing about a game that puts it in order.
  //
  // By when each left the list rather than by when it began, which is what the rows show.
  // The two agree for anyone playing one game at a time, and only one of them is on every
  // row: a game finished before start times were recorded has none, and an axis is no
  // place for a dash. The axis is also what the list is ordered by, so labelling it with
  // that is labelling it with the thing it is actually sorted on.
  const axisLabel = (row) => (isPlaying(row) ? "now" : formatWhen(row.at));
  label(axisLabel(trend.games[0]), plotLeft, plotBottom + CHART_PAD_BOTTOM / 2 + 2, "left");
  if (trend.games.length > 1) {
    label(
      axisLabel(trend.games[trend.games.length - 1]),
      plotRight, plotBottom + CHART_PAD_BOTTOM / 2 + 2, "right"
    );
  }
}

/**
 * The game on the board as a row, or null when there is no game to show one for.
 *
 * Built rather than stored. The archive is what a game leaves behind when it ends, and
 * this game has not ended -- so it is assembled at paint time from the live game and
 * joins the list only on screen. That also means it cannot go stale: there is nothing
 * written down for a crash to leave behind claiming a game is still being played.
 *
 * It never needs repainting while it is up, either. Every popup stops play, this one
 * included, so the figures on this row are frozen for exactly as long as anyone is
 * looking at them.
 *
 * A board still on its opening tiles is not a game and gets no row, which is the same
 * rule archiveGame files by.
 */
function liveRow() {
  const latest = game.latest;
  if (latest.moves === 0) {
    return null;
  }
  return summarize({
    id: currentGameId,
    startedAt: currentGameStarted,
    // The row is about a game that has not ended, so what is stamped here is the moment
    // it was looked at. Nothing reads it: the list is ordered with this row first by
    // construction, and the trend axis labels the archived games around it.
    endedAt: Date.now(),
    ending: ENDED_PLAYING,
    score: latest.score,
    topTile: topTileOf(latest.cells),
    moves: latest.moves,
    undos: game.history.reduce((total, entry) => total + entry.undos, 0),
    seconds: playTime.elapsed(),
    replayedFrom: game.replayedFrom,
    recorded: game.spawns !== null,
  });
}

/**
 * Paint the list of finished games and the figures over them.
 *
 * Skipped while the popup is away, the same way the live graph is: this hangs off the
 * move that ends a game, and there is no sense building a list nothing is looking at.
 */
function paintArchive() {
  if (elements.archivePanel.hidden) {
    return;
  }
  for (const button of elements.archiveTracks.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.track === archiveTrack));
  }

  // The fault is shown where the list would have been, and says what to do about it: a
  // record that will not parse is a permanent dead end on its own, exactly as a corrupt
  // save is, and the one action that clears it is the one thing worth offering.
  if (archiveFault !== null) {
    elements.archivePlayed.textContent = "Past games could not be read.";
    elements.archiveScored.textContent = archiveFault;
    elements.archiveReached.textContent = "";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.id = "clear-archive";
    clear.textContent = "Clear past games";
    clear.addEventListener("click", () => {
      storage.removeItem(ARCHIVE_KEY);
      loadArchive();
      pruneSpawnLogs();
      paintArchive();
    });
    elements.archiveList.replaceChildren(clear);
    elements.archiveTrend.hidden = true;
    elements.archiveTrendReadout.textContent = "";
    elements.archiveGame.hidden = true;
    return;
  }

  const stored = archive.filter(ARCHIVE_TRACKS[archiveTrack]);
  // The game on the board joins the list and the graph but stays out of the figures.
  // Those are readings of games that are over -- a median taken over a game twenty moves
  // in is a median of something that has not happened yet -- and the played line says
  // the live game is there rather than quietly folding it in.
  const live = liveRow();
  const showLive = live !== null && ARCHIVE_TRACKS[archiveTrack](live);
  const rows = showLive ? [live, ...stored] : stored;

  const [played, scored] = archiveSummary(stored);
  // A non-breaking space, so the count and the word wrap as the one field they are. It
  // is the last field on the longest line in the panel and the first thing pushed onto a
  // second row, where "1" stranded at the end of the line above reads as a stray digit.
  const playing = showLive ? `${stored.length === 0 ? "" : FIELD}1 playing` : "";
  elements.archivePlayed.textContent =
    stored.length === 0 && !showLive ? "" : `${stored.length === 0 ? "" : played}${playing}`;
  elements.archiveScored.textContent = stored.length === 0 ? "" : scored;
  elements.archiveReached.textContent = stored.length === 0 ? "" : archiveMilestones(stored);

  if (rows.length === 0) {
    // What is missing depends on which track is being asked about, and the difference is
    // worth a sentence: an empty archive and an archive with nothing in this track are
    // not the same absence, and only one of them is fixed by playing a game.
    const nothing = document.createElement("p");
    nothing.className = "archive-empty";
    nothing.textContent =
      archive.length === 0
        ? "No finished games yet. A game joins this list when it ends or is discarded."
        : `No ${archiveTrack} games yet.`;
    elements.archiveList.replaceChildren(nothing);
    elements.archiveTrend.hidden = true;
    elements.archiveTrendReadout.textContent = "";
    elements.archiveGame.hidden = true;
    return;
  }

  // The same rows the figures above are computed over, so the graph and the lines agree
  // about which games are being talked about -- capped at the newest TREND_GAMES.
  const trend = gameTrend(rows);
  // The game under the pointer need not have survived the track being switched, or a new
  // game arriving and pushing the oldest out of the window.
  if (hoveredGame !== null && hoveredGame >= trend.games.length) {
    hoveredGame = null;
  }
  elements.archiveTrend.hidden = false;
  drawTrend(elements.archiveTrend, trend);
  elements.archiveTrendReadout.textContent = trendReadout(trend);

  const header = document.createElement("div");
  header.className = "archive-row archive-head";
  header.setAttribute("aria-hidden", "true");
  for (const [text, className] of [
    ["Started", "archive-when"],
    ["Score", "archive-score"],
    ["Moves", "archive-moves"],
    ["Time", "archive-secs"],
    ["Undos", "archive-undos"],
  ]) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    header.append(span);
  }
  elements.archiveList.replaceChildren(header, ...rows.map(archiveRow));

  // The opened game may not be in the track being shown, or may have aged out of the
  // archive entirely while it was open. Either way what is under the list no longer
  // belongs to anything in it.
  if (openedGame !== null && !rows.some((row) => row.id === openedGame)) {
    closeArchivedGame();
  }
}

function closeArchivedGame() {
  openedGame = null;
  elements.archiveGame.hidden = true;
}

/**
 * Open a finished game: rebuild it from its record and draw the graph the live game
 * draws.
 *
 * The whole of the reconstruction is replaySpawns -- the same rules, replaying the same
 * spawns -- and the whole of the drawing is drawChart, which is what the game is drawing
 * as it is played. Nothing here knows how a 2048 move works or how a lane is scaled, and
 * that is the point: an archived game is not a different kind of game.
 *
 * The undo tallies come off the stored record and are put back on the rebuilt history,
 * because they are the one thing the moves cannot say: see storeGameRecord.
 */
async function openArchivedGame(id) {
  const row = archive.find((game) => game.id === id);
  if (row === undefined) {
    return;
  }
  openedGame = id;
  elements.archiveGame.hidden = false;
  elements.archiveGameTitle.textContent = `${formatStarted(row)}${FIELD}rebuilding…`;
  elements.archiveReadout.textContent = "";

  const record = await readGameRecord(id);
  // Raced past: another row was opened, or the panel was closed, while this was being
  // fetched. Painting now would drop one game's graph under another game's heading.
  if (openedGame !== id) {
    return;
  }
  if (record === null) {
    // The row said the moves were kept and the store does not have them. That is the
    // shape of a store this browser refuses -- a private window, a sandboxed frame --
    // and it is worth saying plainly rather than leaving an empty frame.
    elements.archiveGameTitle.textContent =
      `${formatStarted(row)}${FIELD}moves unavailable`;
    elements.archiveReadout.textContent =
      "This browser is not keeping move records. The figures above are unaffected.";
    elements.archiveChart.hidden = true;
    return;
  }

  let rebuilt;
  try {
    rebuilt = replaySpawns(record.spawns);
  } catch (error) {
    if (!(error instanceof SaveError)) {
      throw error;
    }
    elements.archiveGameTitle.textContent = `${formatStarted(row)}${FIELD}record unusable`;
    elements.archiveReadout.textContent = error.message;
    elements.archiveChart.hidden = true;
    return;
  }

  const history = rebuilt.history.map((entry) => ({
    ...entry,
    undos: record.undos[entry.moves] ?? 0,
  }));
  const stats = binGame(history);
  elements.archiveChart.hidden = false;
  drawChart(elements.archiveChart, stats, null);
  // Named by what it rebuilt rather than by what the row claimed, and the two are
  // printed together: they are two records of one game written at different times and by
  // different means, so a disagreement between them is worth seeing rather than hiding.
  // Agreement is the ordinary case and reads as a plain restatement of the row.
  const agrees = rebuilt.latest.score === row.score && rebuilt.latest.moves === row.moves;
  elements.archiveGameTitle.textContent =
    `${formatStarted(row)}${FIELD}${count(rebuilt.latest.moves)} moves rebuilt from ` +
    `${count(record.spawns.length)} bytes` +
    (agrees ? "" : `${FIELD}does not match the archived row`);
  elements.archiveReadout.textContent = chartReadout(stats, null);
}

/**
 * Show or hide the list of past games.
 *
 * A third popup on the anchor the other two share, so opening it puts either of them
 * away and puts the newest state back on the board, exactly as they do to each other.
 */
function setArchiveOpen(open) {
  if (open) {
    if (!elements.timeline.hidden) {
      closeTimeline();
    }
    if (!elements.statsPanel.hidden) {
      setStatsOpen(false);
    }
  }
  elements.archivePanel.hidden = !open;
  elements.pastGames.setAttribute("aria-expanded", String(open));
  if (!open) {
    closeArchivedGame();
  }
  // Whatever was under the pointer belonged to the last time it was open.
  hoveredGame = null;
  syncPlayState();
  paintArchive();
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
  // Before the board is thrown away, since it is what the row is made of. A game with no
  // moves on it files nothing, which is what makes this safe to call from startup.
  archiveGame();
  currentGameId = newGameId();
  storage.setItem(CURRENT_GAME_KEY, currentGameId);
  // Cleared rather than set: this game has not been played yet, and markGameStarted
  // stamps it on the move that changes that.
  currentGameStarted = null;
  storage.removeItem(CURRENT_GAME_STARTED_KEY);
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
  markGameStarted();
  landSlide();
  startSlide(paintSliding(result.slidingTiles), () =>
    paintSettled({
      merged: result.mergedCells,
      appeared: new Set([result.spawnedCell]),
    })
  );

  paintPanel();
  // The move that locked the board is the moment the game became a finished one, so it
  // is filed here rather than being noticed later by whatever next asks. Filed before the
  // save below, so the two records of the game agree from the first frame it is over.
  if (game.latest.gameOver) {
    archiveGame();
    paintArchive();
  }
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
  if (event.key === "Escape" && !elements.archivePanel.hidden) {
    event.preventDefault();
    setArchiveOpen(false);
    elements.pastGames.focus();
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
    event.target.closest("button, #timeline, #stats-panel, #archive-panel")
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
onPress(elements.pastGames, () => setArchiveOpen(elements.archivePanel.hidden));

// One listener on the list rather than one per row: the rows are rebuilt on every paint,
// and a row is only ever a button when its game has moves to open.
elements.archiveList.addEventListener("click", (event) => {
  const row = event.target instanceof Element ? event.target.closest(".archive-row") : null;
  if (row === null || row.dataset.id === undefined) {
    return;
  }
  // A second press on the open row closes it, which is how every other control in this
  // panel's neighbourhood behaves.
  if (openedGame === row.dataset.id) {
    closeArchivedGame();
    paintArchive();
    return;
  }
  openArchivedGame(row.dataset.id);
  paintArchive();
});

// Pointing at a game reads it out, and taking the pointer away puts the window back --
// the same interaction the per-game graph's bins have, over a different axis.
elements.archiveTrend.addEventListener("pointermove", (event) => {
  const game = gameAt(event.offsetX);
  if (game !== hoveredGame) {
    hoveredGame = game;
    paintArchive();
  }
});
elements.archiveTrend.addEventListener("pointerleave", () => {
  if (hoveredGame !== null) {
    hoveredGame = null;
    paintArchive();
  }
});

elements.archiveTracks.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("button") : null;
  if (button === null || button.dataset.track === archiveTrack) {
    return;
  }
  archiveTrack = button.dataset.track;
  paintArchive();
});

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
  // The list of past games goes the same way, and for the same reason as the graph: its
  // rows are controls, but a press outside them is a press meant for the game.
  if (
    !elements.archivePanel.hidden &&
    target?.closest("#archive-panel, #past-games") === null
  ) {
    setArchiveOpen(false);
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
  // A save from a build that did not keep one gets an id now rather than going without:
  // it names a game that is still being played, and the archive will want to file it
  // under something when it ends.
  currentGameId = storage.getItem(CURRENT_GAME_KEY) ?? newGameId();
  storage.setItem(CURRENT_GAME_KEY, currentGameId);
  currentGameStarted = loadGameStarted();
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
  // Before either branch: startNewGame files the game it is replacing, and it has to be
  // filed into the list as it actually stands rather than into an empty one.
  loadArchive();
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
    // A finished game that was never filed: the board locked, and the page went away
    // between the row being written and the reload -- or the save predates the archive
    // entirely, which is every game anyone had already finished when this shipped. Filing
    // it is idempotent, so asking on every restore costs a comparison and closes the gap
    // without anything having to remember whether it was filed.
    if (game.latest.gameOver) {
      archiveGame();
    }
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
  if (acceptingInput && saver.saveIfDue(game, playSeconds)) {
    // On the same beat as the save that just went down, so the two records of this game
    // never drift more than one interval apart.
    storeLiveRecord();
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
  // The archived graph is drawn once when its row is opened rather than on every move,
  // so a resize is the one thing that can leave it stretched across a backing store the
  // wrong size. Redrawing it needs the game rebuilt again, which is why this asks
  // whether one is open rather than doing it unconditionally.
  if (openedGame !== null) {
    openArchivedGame(openedGame);
  }
}).observe(elements.main);

// Only now is there a game to receive input, so a corrupt save leaves input off while
// the recovery overlay is up.
acceptingInput = start();
resizeBoard();
requestAnimationFrame(frame);
