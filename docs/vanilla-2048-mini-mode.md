# A 3x3 mini mode for vanilla-2048

How a second board size got in front of the player, what the rules underneath
had to change for it, and what was weighed on the way. This is now built; the
options not taken are kept because the ones taken only make sense against
them.

The rules themselves do not change: same spawn odds, same merge, same
game-over test, same score. The only difference between the two modes is how
many cells there are. That is worth stating up front, because it is the one
decision everything else rests on -- a mini mode that also tuned
`FOUR_SPAWN_CHANCE` would be a second game rather than a smaller board, and
the two would be incomparable in two ways instead of one.

## What already works at any size

More than expected. `compressAndMerge` collapses whatever line it is handed
and pads back to that line's own length. `topTileOf` maps over rows.
`boardCanMove`, `emptyCells` and `arrivalCells` walk `SIZE` but only ever
read cells that exist. `stats.js` and `format.js` never see a board at all.

The spawn log needs no format change either. `spawnByte` gives the cell four
bits -- 0-15 -- and a 3x3 board addresses 0-8, so a mini game's log is a
valid log by the current encoding. What the log cannot say is which size it
was played at, which is the one thing the reader has to be told; see below.

## Where the size actually comes in

`board.js`, ten sites: the `SIZE` export, `validateSavedBoard`'s two length
checks, the loops in `emptyCells`, `boardCanMove` and `lineCoordinates`,
`compressAndMerge`'s pad, `arrivalCells`' empty board and index maths,
`Game.emptyBoard`, and the `cell / SIZE` pairs in `spawnTile` and `move`.

`game.js`, seven: `rowOf`, `colOf`, the `paintSettled` loop, `resizeBoard`'s
cell arithmetic, `drawShareBoard`'s loop, `renderShareImage`'s board extent,
and the `#grid` cells built once at startup.

`index.html`, two: `#board`'s `calc(var(--cell) * 4 + var(--gap) * 3)` and
`#grid`'s `repeat(4, var(--cell))`.

## Plan: the board carries its own size

Not a module-level variable that gets reassigned. `openArchivedGame` rebuilds
a finished game through `replaySpawns` **while** a live game sits on the
board, and the two need not be the same size -- so a global would rebuild a
3x3 game against 4x4 rules the first time anyone opened an old row.

The shape that avoids threading a parameter through everything: a board is an
array of rows, so it already knows its size. `emptyCells`, `boardCanMove`,
`arrivalCells` and `compressAndMerge` derive it from what they are handed and
gain no argument at all. Only the two functions that receive no board take
one -- `lineCoordinates(direction, size)` and `validateSavedBoard(value,
size)`, where the expected size is the whole point of the check -- plus
`Game.emptyBoard(size)`.

`Game` gains `size` in its options and `this.size`, defaulted to 4. Every
`cell / SIZE` inside it becomes `cell / this.size`. `replaySpawns(spawns,
size)` passes it through to the game it builds; a log naming cell 9 on a 3x3
board is already rejected without a new check, because `dealRecorded` tests
the cell against the empty list the rules handed it and cell 9 is never on
it.

`game.js` reads `game.size` rather than importing `SIZE`. There is exactly
one live game per page, so `rowOf`/`colOf` can read it directly; the `#grid`
cells move out of the startup block into a function that runs whenever the
size changes.

Watch the bundler while renaming: `test_bundle.py` asserts no two modules
declare the same top-level name, because the bundle concatenates them into
one scope. A `SIZES` in `board.js` and a size default in `archive.js` must
not collide.

## The save

`STATE_VERSION` 3 -> 4, with an explicit `"size"`. A v3 save reads back as
size 4, which is what every one of them is.

Bumping rather than adding an optional field, which is how `replayed_from`
and `spawns` went in. Those were safe to add because an older reader that
ignored them still opened the game. A `size` an older reader ignored would
send a 3x3 board through `validateSavedBoard` against 4, fail, and put up the
recovery overlay -- which offers to discard the save *and both best scores*.
"Unsupported version" is a refusal; "corrupt" is a refusal that invites the
player to wipe something that was never wrong. The version bump buys the
first message, and this file already reads three versions.

The alternative -- packing the size into the two bits `spawnByte` leaves
unused on an opening spawn -- is rejected. It hides a format decision inside
a bit field, and it does not help: the save has to know its size before it
can validate the boards, and the log is decoded after them.

## One save slot, or one per size

**S1, one slot.** `GAME_STATE_KEY` holds whichever game is on the board.
Switching size goes through the existing Discard question and files the old
game into the archive. One live game, one key, one path.

**S2, a slot per size.** The 4x4 game keeps `vanilla-2048.gameState.v1`; the
mini game gets a suffixed key of its own, and so do `currentGame` and
`currentGameStarted`. Switching parks one game and resumes the other: no
question to answer, no archive row for a game that has not ended.

S2 is worth its cost. The cost is a `keys(size)` helper over three key names,
and everything else -- the play clock, the timeline, the bests -- is already
inside the save or already split by track. What it buys is a mode switch that
costs nothing to press, and a mode that costs nothing to press is the one
that gets played. S1 charges a whole game for curiosity.

## Best scores and tiles

A 3x3 score is not comparable with a 4x4 score, in exactly the sense a
replayed score is not comparable with a clean one -- and the reasoning is
already written down beside `BEST_REPLAYED_SCORE_KEY`. So: a key per track
per size. The four existing keys stay the 4x4 track untouched, and mini gets
four suffixed ones. `loadBest` and `saveBests` pick the set from the size.

The score line needs no new field. It shows the best for the mode being
played -- which is precisely why the mode has to be visible on screen, or the
number is ambiguous.

## The archive

The row gains `n`, the board size, read back as 4 when absent. Every stored
row is a 4x4 game, so the default is a fact rather than a fallback and
`ARCHIVE_VERSION` can stay at 1. `openArchivedGame` hands `row.n` to
`replaySpawns`.

Size has to be a *filter*, not a column. `archiveStats` over a mixed list
takes a median across 3x3 games worth a couple of thousand and 4x4 games
worth twenty, and reports a figure that describes neither; `gameTrend` draws
both into one score lane and makes every mini game look like a collapse. The
fix is one more predicate beside `ARCHIVE_TRACKS`, defaulting to the size
being played.

`MILESTONE_TILES` is 4x4-tuned: `[2048, 1024, 512, 256, 128]` reads as a
column of zeros for a mode that rarely passes 512. A 3x3 board holds nine
tiles, which caps the chain a merge can be built on -- 1024 is about the
arithmetic ceiling and play lands well below it -- so mini wants its own
list, `[512, 256, 128, 64, 32]` as a starting guess, checked against actual
games before it is fixed.

## Where the choice went: four options, and the measurements

`#actions` held six controls: New Game, Undo, Share, and three icon buttons.
It is `flex-wrap`, and the panel is already at its width limit on a phone --
the note above `#score-line` measures an end-game line at 282px of the 330px
a 360px phone leaves it. Anything added here can wrap to another row, and the
board is sized from what the panel leaves over, so a wrapped row is paid for
in board height. That is what decided this, and the widths below are measured
in Chromium against the built page rather than guessed at.

**A. A segmented pair beside New Game: `4x4 | 3x3`.** Follows
`#archive-tracks` exactly, `aria-pressed` accent and all, so the colour that
already means "this one is in force" means it here too. The mode is never
ambiguous, which matters because Best changes meaning with it. One press to
switch. Costs the most width of any option: two buttons and their gaps.

**B. A single `Mini` toggle, `aria-pressed`. Built.** Half the width of A,
and it is an icon beside the other three -- a 3x3 of squares, the same kind
of glyph they already use, in the same accent `#archive-tracks` uses for the
filter in force. It says less about what the two states are than a labelled
pair does, but the board underneath is showing three columns or four, which
is the least ambiguous readout available.

What paid for it was the Share button, which became the share sheet's own
glyph in the same change: the word was 31px that the toggle and the two
dividers then spent. The toolbar stays on one row from 340px up, and the
dividers themselves are dropped below 350px, where they are what costs the
row its second line. Below about 330px it wraps -- a width where the panel is
already stepping its type down.

**C. Inside the New Game question.** No new chrome at rest: "Discard this
game?" gains "New 4x4" and "New 3x3" beside Resume. But New Game is the most
pressed control on the page, and a board with nothing to discard would now
have to be asked which size it is starting -- so `R`, and the game-over line
that says "Press R or New Game", both become two presses. It also hides the
mode, which the score line needs shown. And it is the wrong verb under S2:
switching resumes a parked game rather than starting one.

**D. A `?size=3` parameter.** Costs nothing in the panel and makes a mode
linkable, which is worth having. Not the way in, though: `generate-index.py`
builds the index from directories, so a second entry means a second copy of
the demo, and a mode reachable only by editing the URL is a mode nobody
plays. Ship it alongside B as what picks the opening mode.

The choice persists under `vanilla-2048.boardSize`, so a reload comes back on
the board it left. D is not built; the key is what the mode opens from.

## Sizing the board: cap the board, not the cell

`resizeBoard` maxed the *cell* at `MAX_CELL` (92px), so a 3x3 board would
have drawn 292px wide where a 4x4 draws 392px -- the play area shrinking by a
quarter for no reason a player would recognise.

`MAX_BOARD` caps the extent instead and lets the cell follow: mini draws
125px cells in a 391px board against the 4x4 board's 392px, measured. Tile
type is already derived from `cellSize`, so it scales with no other change.
It also keeps the panel measurement stable across a switch, which is the
thing `resizeBoard`'s own note is careful about.

CSS: set `--size` beside `--cell` and `--gap`, and replace the two hardcoded
4s with it.

## Tests

`test_board.mjs` already imports `SIZE`; the line-collapsing and move tests
become a loop over both sizes. New cases worth having:

- a 3x3 game round-trips through `encode`/`decodeSavedState`
- a v3 save with no `size` reads back as 4x4
- a save whose boards disagree with its declared size is refused
- `replaySpawns(log, 3)` rebuilds a mini game move for move
- a log naming cell 9 at size 3 is refused

`test_archive.mjs`: a row with no `n` reads back as 4x4, and the size filter
splits a mixed list.

## What is not done

- **`?size=`.** Worth having and not built; the mode is remembered rather
  than linkable.
- **`MINI_MILESTONE_TILES`.** `[512, 256, 128, 64, 32]` is reasoned from nine
  cells capping the chain a merge can be built on, not measured against real
  games. It is the one number here that should be checked by playing.
- **The imgui demo.** It keeps its own `SIZE = 4` and is untouched.
- **A mini log replayed at 4x4.** Caught in one direction only: a 4x4 log on
  a mini board deals onto cells 9 and up and is refused, but a mini log on a
  4x4 board names cells that all exist there and would rebuild a game nobody
  played. That is why the size is stored on the archived row -- it cannot be
  inferred from the log -- and why nothing tries to.
