# Solving 2048 exactly, and what a 4x4 solve would cost

Simon Tatham [analysed 2048 on a 3x3
board](https://www.chiark.greenend.org.uk/~sgtatham/quasiblog/small2048/) and
published the probability of reaching each tile under perfect play. These are
notes from reproducing that analysis against the rules the demos in `site/`
actually play, and from measuring what the same method would cost on 4x4.

Nothing here is implemented in the demos. The numbers are real: everything
labelled *measured* came out of `scripts/solve-2048.c` on one core of the
machine these notes were written on.

## The one fact the method rests on

A move conserves the tile sum. Merging two 2s into a 4 moves value around the
board but does not create any, and sliding moves none at all. The only thing
that adds value is the spawn that answers the move, and it adds exactly 2 or
exactly 4.

So every turn raises the tile sum, and nothing ever lowers it. Two consequences
do all the work:

- **No position can ever repeat**, in a game or across games. The state graph
  is a DAG, so the value of a position is a plain backward induction over it --
  no value iteration, no system of simultaneous equations, no discounting, no
  convergence threshold. The answer is exact and arrives in one pass.
- **The tile sum grades the DAG.** Every edge steps from grade `s` to grade
  `s+2` or `s+4`. Process grades in decreasing order and the values you need
  are always the two grades you just finished.

That second point is the one that decides feasibility, and it is easy to miss.
It means a solve never has to hold the whole state space: **three grades at a
time is enough**, whatever the total.

## The two kinds of node

Splitting each turn in half keeps the arithmetic honest and cuts the work:

- a **state** is a board with the player to move (just after a spawn)
- an **afterstate** is a board just after a move, before the spawn

```
V(state)      = max over the legal moves of   gain(move) + V(afterstate)
V(afterstate) = average over the spawn: 0.9 on a 2, 0.1 on a 4,
                uniform over the empty cells
```

A state and its afterstates share a grade; only the spawn steps up one. Many
distinct states collapse onto the same afterstate, so averaging over spawns --
the expensive half -- is done once per afterstate instead of once per
`(state, move)` pair. Measured on 3x3: 48,713,519 states offer 118,494,856
legal `(state, move)` pairs but only 31,431,374 distinct afterstates, a **3.8x**
saving on the spawn expansion.

## Symmetry

The rules are equivariant under the board's symmetry group -- the eight
dihedral images on a square board, four when it is not square -- so a board and
its images have equal value. Canonicalising each board to the least of its
images is exact, not an approximation. Measured on 3x3: 388,921,077 states
collapse to 48,713,519, a factor of **7.98** against a theoretical ceiling of 8.

## Reproducing the 3x3 answer

Rules as `site/vanilla-2048/board.js` plays them: two opening tiles, each a 2
with p=0.9 and a 4 with p=0.1, onto a uniformly chosen empty cell; a move must
change the board.

| board | cells | states | afterstates | grades | top sum | top tile | top grade |
|---|---|---|---|---|---|---|---|
| 2x2 | 4 | 110 | 67 | 29 | 60 | 32 | 7 |
| 2x3 | 6 | 21,752 | 14,883 | 125 | 252 | 128 | 302 |
| 2x4 | 8 | 4,980,767 | 3,406,686 | 509 | 1,020 | 512 | 18,210 |
| 3x3 | 9 | 48,713,519 | 31,431,374 | 1,021 | 2,044 | 1,024 | 93,061 |

All canonical, all exhaustive. **The whole 3x3 game solves in under two minutes
on one core**: 34.5 s to enumerate every state, 81.8 s for a backward induction
that computes all ten objectives below in the same pass, 847 MB peak.

That 847 MB is an implementation convenience, not a requirement -- it holds
every grade's keys at once because enumeration runs first. A properly streaming
solve holds three grades: on 3x3 that is 93,061 x 3 states, about **4.5 MB**.

Note the last column against the third. The biggest grade on 3x3 holds 93,061
states, **0.19% of the 48.7 million**. That ratio, not the total, is what a
solve has to fit in memory.

Probabilities under play optimised for each goal separately:

| goal | P(reach it) under perfect play |
|---|---|
| 128 | 0.999999805905 |
| 256 | 0.995709643199 |
| 512 | 0.736774177023 |
| 1024 | 0.011337880083 |
| 2048 | 0, and provably so |

128 is *not* certain, which is the sort of thing only an exact method tells
you: about **1 game in 5.15 million** dies below it however well it is played,
because a 3x3 board can be dealt into a dead end that early.

2048 is not unlucky, it is unreachable. Nine cells hold at most
`1024+512+256+128+64+32+16+8+4 = 2044` of tile sum, which the enumeration
confirms as the largest tile sum the game ever reaches, and a single 2048 tile
would need 2048 of it on its own.

The 256, 512 and 1024 figures agree with the published ones to every digit
quoted, which is the check that this reproduction is the same computation.

## "Perfect play" is not one thing

Every row of that table is a *different* solve. Maximising `P(512)` and
maximising expected score are different objectives, they induce different
policies, and each needs its own backward induction. Values from one cannot be
read off the other.

On 3x3 they happen to point almost the same way, which is worth knowing and is
not obvious in advance:

| | E[score] | P(512) |
|---|---|---|
| score-optimal play | **5468.49** | 0.736648 |
| 512-optimal play | 5466.97 | **0.736774** |

Playing flat out for score costs 0.000126 of the chance at 512; playing flat
out for 512 costs 1.5 points of expected score. Either is within a rounding
error of the other's optimum.

Chaining goals is where it stops being harmless. "Play for 256, then switch to
the 512 policy once you have it" sounds like it should land near 0.7368, and it
can -- but the policy is barely pinned down. `P(256)` is *exactly* 1 from most
early positions, so several moves tie for the 256 goal and the tie-break alone
decides what happens next:

| tie-break among moves equally good for 256 | P(512) |
|---|---|
| take the best one for 512 | 0.736770 |
| take the first in a fixed direction order | 0.722365 |
| take the worst one for 512 | 0.124667 |

A factor of six, all of it inside the freedom the stated goal leaves open. The
middle row is the interesting one: an arbitrary but deterministic rule, of the
kind any solver falls into without meaning to, and it lands at 0.7224 -- next
to the ~0.726 that gets published for this chained strategy.

The lesson generalises. A goal-directed policy is only determined where the
goal is still in doubt, and on an easy goal that is almost nowhere. A figure
for a chained strategy is mostly a figure about its tie-break, and worth
reporting as a range rather than a number.

## Probability of a *score*, which is a harder question

Reaching a tile is a property of the board. Reaching a score is not: the score
is not a function of the position. Two identical boards can carry different
scores, because a spawned 4 gives you a tile you would otherwise have had to
merge -- and pay for -- yourself.

The bookkeeping is exact, though. Give each tile a potential

```
phi(v) = v * (log2(v) - 1)          phi(2)=0, phi(4)=4, phi(8)=16, ...
```

and sum it over the board. Merging two `v` tiles raises `phi` by exactly `2v`,
which is exactly the score for that merge. A spawned 2 adds 0 to both. A
spawned 4 adds 4 to `phi` and nothing to the score. So at every moment of every
game:

```
score = phi(board) - 4 * (number of 4s spawned so far)
```

Nothing else is needed. The score is pinned down by the board plus **one small
integer**, the count of 4-spawns, and that count is bounded by `sum/4`.

Two things follow:

- The **distribution of final score under a fixed policy** is a forward pass
  over the same grades, carrying a distribution over that count instead of a
  single number. Cheap: it is one sweep, and the count's realised spread is
  narrow.
- The **policy that maximises `P(score >= X)`** is a different solve again, over
  the augmented state `(board, 4-spawns so far)`, and it needs one solve per
  threshold `X`. That multiplies the state space by the width of the count, and
  the answer for one `X` says nothing about another. Expected score is linear
  and needs no augmentation; a threshold on score is not and does.

This is the part of the method that does not simply transplant. It is also why
the published 3x3 results are about *tiles*: tiles are free, scores are not.

Measured, exact, under the score-maximising policy:

| | final score |
|---|---|
| mean | 5468.49 |
| median | 6220 |
| most likely single value | 2984 (p=0.0132) |
| lowest possible | 88 |
| highest possible | 16,352 (p = 7e-55) |

| X | P(final score >= X) |
|---|---|
| 1,000 | 0.999949 |
| 2,000 | 0.995675 |
| 3,000 | 0.804536 |
| 4,000 | 0.736648 |
| 5,000 | 0.725349 |
| 6,000 | 0.539757 |
| 7,000 | 0.062199 |
| 8,000 | 0.011115 |
| 10,000 | 0.010958 |
| 12,000 | 0.002023 |
| 14,000 | 0.000097 |

The curve is a staircase, not a bell. It is flat from 3,500 to 4,000 -- no game
ends in that band at all -- and that step's height, 0.736648, is exactly
`P(512)` under this policy. The shelf past 8,000 sits at 0.011115, just under
the 0.011338 that optimal 1024-hunting achieves. The score you finish on is
mostly a restatement of the top tile you reached, which is the other reason the
published 3x3 results are quoted as tiles.

## Scaling to 4x4

Nothing in the method cares about board size. What changes is how much there is
of it. Measured, exhaustive, all states unreduced by symmetry so the sizes are
comparable:

| cells | board | reachable states | per extra cell |
|---|---|---|---|
| 4 | 2x2 | 662 | |
| 6 | 2x3 | 85,844 | x11.4 |
| 8 | 2x4 | 19,920,382 | x15.2 |
| 9 | 3x3 | 388,921,077 | x19.5 |
| 12 | 4x3 | 1,152,817,492,752 | |
| 16 | 4x4 | *see below* | |

Every row but 4x3 was measured here; that one is the published 2025 strong
solve, and it is the nearest anyone has got to 4x4. Each cell added costs more
than the last, so seven more cells past 3x3 is not seven more of anything on
this table.

An exact ceiling is easy to get without enumerating: the number of boards with a
given tile sum is a coefficient of `(1 + x^2 + x^4 + ... )^cells`, and the
biggest such coefficient bounds the biggest grade. These are exact:

| problem | all boards | biggest grade |
|---|---|---|
| 3x3, whole game | 2,357,947,691 | 3,032,568 |
| 4x4, goal 2048 (tiles <= 1024) | 45,949,729,863,572,161 | 32,414,189,808,000 |
| 4x4, whole game | 18,446,744,073,709,551,616 | 617,439,692,513,280 |

Not every board is reachable. Measured across the grades that could be
enumerated, 3 to 5% of 4x4 boards are, against 16.5% over the whole 3x3 game,
and the fraction was still drifting up where the enumeration was stopped.

Stopping it is the part worth reporting. Enumerating 4x4 forward from the
opening ran out of room after **32 grades** -- tile sums 4 to 66, 710,807,198
states, 607 s and 6 GB. The last grade alone, tile sum 66, holds 142,853,436
states: already **192x the biggest grade in the entire 3x3 game**, and tile sum
66 is 2.3% of the way to where the 4x4 grades even start to peak. Roughly 1,400
grades lie between there and that peak, and almost every one of them is bigger
than this one.

Taking 5-25% reachable and the 8x symmetry fold, and pricing a state at 16 bytes
(key plus a double), that gives:

| | states to visit | top grade | 3 grades held | one core, 596k st/s |
|---|---|---|---|---|
| 3x3, whole game | 4.9e7 | 93,061 | 4.5 MB | **82 s** |
| 4x3, whole game | 1.2e12 | -- | -- | 22 days |
| 4x4, goal 2048 | 3e14 - 1.4e15 | 2e11 - 1e12 | **10 - 48 TB** | 16 - 74 core-yr |
| 4x4, whole game | ~1e17 | ~4e12 | **~190 TB** | ~6,000 core-yr |

So: **no, not as it stands** -- but the reason is worth being precise about,
because it is not the one the headline state counts suggest.

- **Time is not really the wall.** The DP within a grade is embarrassingly
  parallel; only the grade order is serial. Sixteen core-years is under three
  weeks on a thousand cores. Even the friendliest framing of 4x4 is only about
  250x the 4x3 problem that was solved in 2025, and that ratio is affordable.
- **Memory is the wall**, and specifically the *biggest grade*, not the total.
  Ten terabytes, minimum, held with random access, for the friendliest version
  of the question. That is the number that decides it, and it is exactly the
  one a "48 million states" headline for 3x3 hides -- there, the same quantity
  is 4.5 MB, which is why the 3x3 solve is a coffee break and this one is not.

## The shortcuts, in the order worth taking them

Four cost nothing -- they change the size of the problem, not the answer. All
four are already in the numbers above; without them 3x3 is a much duller story.

1. **Grade streaming.** Hold three grades, not the space. This is what turns
   "48 million states" into "4.5 MB resident" on 3x3, and it is the difference
   between 4x4 needing 10 TB and needing 5,000 TB.
2. **Cap the tiles at the goal.** Making 2048 an absorbing win means no board
   still in play holds more than 1024, and 4x4 drops from `16^16` boards to
   `11^16` -- **401x**, exactly, for free. The 3x3 analogue is why asking about
   512 is much cheaper than solving the whole game.
3. **Symmetry.** Measured 7.98x on 3x3, against a ceiling of 8. Only 4x on a
   non-square board, which is part of why 4x3 was reachable and 4x4 is not just
   "one more column".
4. **Afterstates.** 3.8x fewer spawn-averagings on 3x3. Pure compute, no
   memory cost.

Two more trade one resource for another:

5. **Quantise the values.** A probability in 16-bit fixed point is a quarter
   the size of a double and still far more precise than the question deserves.
   It takes a state from 16 bytes to 10 -- worth having, not decisive.
6. **Index by rank instead of storing keys.** The same coefficient DP that
   bounds a grade also ranks the boards within it, so a grade can be a bare
   value array with no 8-byte keys at all. That is a win only where most boards
   in the grade are reachable -- at the 3-5% measured on 4x4 it is a large loss,
   so it is a 3x3-scale trick, not a 4x4 one.

An **endgame database** -- solve the high grades exactly, play heuristically
before them -- reads like the obvious next move and mostly is not. The grades
are back-loaded: on 3x3, cutting at tile sum 1600, which is 78% of the way to
the end of the game, still leaves **15.7%** of all states inside the database
and 84% of the game outside it. There is no cheap tail to precompute.

So past the free shortcuts, 4x4 means giving up the exact answer:

- **Monte Carlo over a fixed strong policy** gives `P(reach 2048)` to as many
  digits as you care to sample, and it is an honest *lower bound* on the optimal
  probability rather than an estimate of it. This is the answer for anything
  this repo would want to know about its own demos.
- **Expectimax with a learned evaluation** (n-tuple networks and the like) is
  what actually plays 4x4 near-optimally, and gives no bound at all.
- **Solve a smaller board and reason across.** 2x4 and 3x3 solve here in
  seconds, 4x3 is solved in the literature. Answers for 4x4 have to be argued
  from those, not computed.

## Where this leaves the demos

The exact analysis is available at 3x3 and below and will not be available at
4x4. The three answers this repo might want from it -- how good is perfect play,
what does the score distribution look like, how much does the policy's objective
matter -- are all measurable on 4x4 only by sampling a strong policy, and
`site/vanilla-2048` already keeps every finished game and every move of it,
which is the raw material for exactly that.

## How much to trust these numbers

Four checks, because a solver that is subtly wrong still prints six decimals.

- **The 3x3 tile probabilities match the published ones to every digit
  quoted** -- 0.99571, 0.73677, 0.01134. Three independent five-digit
  agreements is the check that this is the same computation and not merely a
  plausible one.
- **2x2 was solved twice, independently.** Once by the solver here (bit-packed
  boards, symmetry folding, grade ordering) and once by a plain memoised
  expectimax over tuples with none of those tricks. Both give 662 boards with
  the player to move, `E[score]` 66.964149, `P(16)` 0.962511, `P(32)`
  0.082887, `P(64)` 0. Agreement across two implementations that share no
  machinery is the check on the machinery.
- **The move rules were checked against the demo's own code.** 4,000 random
  boards through `lineCoordinates` and `compressAndMerge` from
  `site/vanilla-2048/board.js`, and through the solver, in all four
  directions: every resulting board and every score gain identical. This is an
  analysis of the game in `site/`, not of a lookalike.
- **The score identity checks itself.** The forward pass carries only a count
  of 4-spawns and reconstructs the score from `phi`; its distribution sums to
  1.000000000000 and its mean is 5468.486797, which is the expected score the
  backward induction computed by a completely different route.
