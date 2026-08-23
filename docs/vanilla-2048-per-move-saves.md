# Saving the vanilla-2048 game more often than every five seconds

Notes from measuring what the current save costs, and what a save built on
the spawn log instead of the timeline would cost. Nothing here is
implemented; the numbers are real.

## Where the save stands today

`saver.saveIfDue` writes the whole game to `localStorage` under
`vanilla-2048.gameState.v1` every `SAVE_INTERVAL_MS` (5 s), and
`commitChange` writes it outright on any move that raised a best figure or
on a take-back. The payload is, in order of size:

- the **timeline**: up to `TIMELINE_LIMIT` (1000) boards, about 120 bytes a
  move, and the only part that is capped
- the **history**: one gain per move plus a sparse undo map, about 2.3
  bytes a move
- the **spawn log**: one byte a move, base64 in the JSON, so 1.33

So the current game's moves are *already* durable to within five seconds --
the log rides inside the ordinary save and costs nothing extra, because
that save was being written anyway. What is written only when a game ends
is the IndexedDB archive record.

## Measured cost

Chromium, against the real modules, at a 1000-move game. "Save without
boards" is the same save with `timeline` removed and nothing else changed.

| | full save (today) | log only | save without boards |
|---|---|---|---|
| size | 125 KB | 1.3 KB | 4.0 KB |
| `encode` | 1.19 ms | -- | -- |
| `localStorage.setItem` | 0.16 ms | ~0.01 ms | 0.027 ms |
| total per write | **1.35 ms** | -- | ~0.1 ms |
| IndexedDB put | -- | 1.2-1.5 ms (async) | -- |
| replay back into a game | -- | **4.1 ms** | -- |

Shorter games, for scale: 100 moves is 11.8 KB and 0.15 ms; 500 moves is
61 KB and 0.79 ms. The timeline cap means size plateaus past 1000 moves
while the history and log keep growing.

## What each option would cost

**Every five seconds.** Already happening. No work, no cost.

**Every move, as the save stands.** 1.35 ms of synchronous main-thread
work per move at 1000 moves. Against a 16.7 ms frame and the 150 ms input
throttle that is survivable -- about 8% of one frame, and the panel's own
p50/90/99 readout would show it -- but it pays 125 KB to durably record
1.3 KB. The cost is the timeline, not the log.

**Every move, log only, to its own `localStorage` key.** ~0.03 ms. Free at
any rate. Costs a second key that can disagree with the save beside it,
which is a consistency problem to think about rather than a performance
one: two records of one game, written at different moments.

**Every move, log only, to IndexedDB.** ~1.2 ms but asynchronous, so it
does not block the frame. It queues a transaction per move to store a
single byte, which is the wasteful shape of this -- IndexedDB is where the
log belongs when a game *ends*, not while it is being played.

## The change actually worth making

The timeline is derivable from the log. `replaySpawns` already rebuilds
every board, score and tile exactly, and that is tested.

A save without boards is 4 KB writing in 0.027 ms -- **50x cheaper** --
against 4.1 ms to replay the log back into a full game. That replay is a
once-per-load cost at startup, where there is no frame budget to blow.

What it would buy:

- per-move saving becomes free
- `TIMELINE_LIMIT` stops being a *storage* cap. The scrubber could reach a
  game's first move instead of stopping 1000 back; the cap becomes a
  question about memory, not about `localStorage`
- the history could go too, since replaying gives back the scores. A
  minimal save is the log, the undo positions, the cursor and the play
  clock -- call it 1.5 KB for a game that currently costs 125 KB

What it would cost:

- 4 ms at startup, and the timeline has to be rebuilt into memory anyway
  for the scrubber to walk it, so the memory is not saved -- only the
  storage and the write time
- a save-format change, with the existing versions still to be read: v1,
  v2 and v3 all carry boards and no log, and a game restored from one of
  them has no log and never can have. So the reader keeps both paths
  regardless -- boards when they are there, replay when they are not --
  and that is the real complexity, not the replay itself
- `decodeSavedState` currently validates the timeline against the history
  and the log against both. With the boards gone there is less to check
  against, so a corrupt log fails later and less obviously

## Where to start

`Game.encode` / `decodeSavedState` in `site/vanilla-2048/board.js` are the
whole surface. `replaySpawns` in the same file is the reconstruction, and
`tests/test_board.mjs` already covers it round-tripping through undos,
restores and a save with no log at all.
