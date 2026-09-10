/*
 * Exhaustive backward-induction solver for 2048 on an H x W board, behind
 * docs/2048-perfect-play.md.
 *
 * Rules match site/vanilla-2048: two opening tiles, each a 2 with p=0.9 and a 4
 * with p=0.1 onto a uniformly chosen empty cell; a move must change the board.
 *
 * The whole thing rests on one invariant: a move preserves the tile sum (merges
 * conserve it) and the spawn that answers it adds exactly 2 or 4. So the tile
 * sum rises every turn, the state graph is a DAG graded by that sum, and
 * backward induction over the grades is exact -- no value iteration, no
 * simultaneous equations, and never more than three grades in play at once.
 *
 * Board sizes up to 16 cells fit, four bits a cell, in one uint64_t. The
 * objectives are the ones the 3x3 questions ask -- the tile goals are 128 to
 * 1024 and the chained-policy handover is 256-then-512 -- so `solve` is worth
 * running on 3x3 and smaller; `count` is the mode that says anything about
 * bigger boards.
 *
 *   build:  cc -O2 -DH=3 -DW=3 -o solve33 solve-2048.c
 *
 *   solve33 count [cap]   states per grade, canonical under the board's
 *                         symmetry group; stops once a grade passes cap
 *   solve33 countraw [c]  the same without the symmetry fold
 *   solve33 solve         every objective in one backward pass, from the
 *                         opening board
 *   solve33 scoredist     that, plus the exact distribution of the final score
 *                         under score-optimal play, written to scoredist.csv
 *   solve33 movetest      hex boards on stdin, each move's result on stdout,
 *                         for diffing against site/vanilla-2048/board.js
 *
 * GOAL=512 in the environment ends the game the moment that tile appears, so
 * the counts are the ones a solve aimed at that tile would face. Counting
 * only: it truncates the graph the backward pass would need.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifndef H
#define H 3
#endif
#ifndef W
#define W 3
#endif

#define NCELL   (H * W)
#define MAXSUM  (1 << 21)      /* grade index bound; sums are always even */
#define SQUARE  (H == W)

typedef uint64_t board_t;

#define CELL(r, c) (4 * ((r) * W + (c)))

/* ---------------------------------------------------------------- tables */

/* A line of L cells slid/merged toward index 0, packed 4 bits per cell. */
#define LINEMAX 4
static uint32_t slide[LINEMAX + 1][1 << (4 * LINEMAX)];
static uint32_t sgain[LINEMAX + 1][1 << (4 * LINEMAX)];

static void build_tables(void)
{
    for (int len = 2; len <= LINEMAX; len++) {
        uint32_t n = 1u << (4 * len);
        for (uint32_t line = 0; line < n; line++) {
            int t[LINEMAX], k = 0;
            for (int i = 0; i < len; i++) {
                int v = (line >> (4 * i)) & 0xF;
                if (v) t[k++] = v;
            }
            uint32_t packed = 0, gain = 0;
            int m = 0;
            for (int i = 0; i < k; i++) {
                int v;
                if (i + 1 < k && t[i] == t[i + 1] && t[i] < 15) {
                    v = t[i] + 1;
                    gain += 1u << v;
                    i++;
                } else {
                    v = t[i];
                }
                packed |= (uint32_t)v << (4 * m);
                m++;
            }
            slide[len][line] = packed;
            sgain[len][line] = gain;
        }
    }
}

/* --------------------------------------------------------------- board ops */

/* Gather a row or column into a packed line, low nibble = index 0. */
static inline uint32_t gather_row(board_t b, int r, int rev)
{
    uint32_t l = 0;
    for (int c = 0; c < W; c++) {
        uint32_t v = (b >> CELL(r, c)) & 0xF;
        l |= v << (4 * (rev ? W - 1 - c : c));
    }
    return l;
}

static inline uint32_t gather_col(board_t b, int c, int rev)
{
    uint32_t l = 0;
    for (int r = 0; r < H; r++) {
        uint32_t v = (b >> CELL(r, c)) & 0xF;
        l |= v << (4 * (rev ? H - 1 - r : r));
    }
    return l;
}

static inline board_t scatter_row(uint32_t l, int r, int rev)
{
    board_t o = 0;
    for (int c = 0; c < W; c++) {
        board_t v = (l >> (4 * (rev ? W - 1 - c : c))) & 0xF;
        o |= v << CELL(r, c);
    }
    return o;
}

static inline board_t scatter_col(uint32_t l, int c, int rev)
{
    board_t o = 0;
    for (int r = 0; r < H; r++) {
        board_t v = (l >> (4 * (rev ? H - 1 - r : r))) & 0xF;
        o |= v << CELL(r, c);
    }
    return o;
}

/* dir 0 left, 1 right, 2 up, 3 down. */
static board_t do_move(board_t b, int dir, uint32_t *gain)
{
    board_t o = 0;
    uint32_t g = 0;
    if (dir < 2) {
        int rev = dir;
        for (int r = 0; r < H; r++) {
            uint32_t l = gather_row(b, r, rev);
            o |= scatter_row(slide[W][l], r, rev);
            g += sgain[W][l];
        }
    } else {
        int rev = dir - 2;
        for (int c = 0; c < W; c++) {
            uint32_t l = gather_col(b, c, rev);
            o |= scatter_col(slide[H][l], c, rev);
            g += sgain[H][l];
        }
    }
    *gain = g;
    return o;
}

static inline board_t flip_h(board_t b)     /* reverse each row */
{
    board_t o = 0;
    for (int r = 0; r < H; r++)
        for (int c = 0; c < W; c++)
            o |= ((b >> CELL(r, c)) & 0xF) << CELL(r, W - 1 - c);
    return o;
}

static inline board_t flip_v(board_t b)     /* reverse the row order */
{
    board_t o = 0;
    for (int r = 0; r < H; r++)
        for (int c = 0; c < W; c++)
            o |= ((b >> CELL(r, c)) & 0xF) << CELL(H - 1 - r, c);
    return o;
}

#if SQUARE
static inline board_t transpose(board_t b)
{
    board_t o = 0;
    for (int r = 0; r < H; r++)
        for (int c = 0; c < W; c++)
            o |= ((b >> CELL(r, c)) & 0xF) << CELL(c, r);
    return o;
}
#endif

/* Least image under the board's symmetry group: the full dihedral 8 when
 * square, otherwise the 4 that do not swap the axes. The rules are equivariant
 * under all of them, so a state and its images have identical values. */
static int use_sym = 1;
static uint32_t stop_exp = 0;   /* goal tile: reaching it ends the game */

static inline board_t canonical(board_t b)
{
    if (!use_sym) return b;
    board_t best = b, v = flip_v(b);
    board_t c[4] = { b, flip_h(b), v, flip_h(v) };
    for (int i = 1; i < 4; i++) if (c[i] < best) best = c[i];
#if SQUARE
    board_t t = transpose(b), tv = flip_v(t);
    board_t d[4] = { t, flip_h(t), tv, flip_h(tv) };
    for (int i = 0; i < 4; i++) if (d[i] < best) best = d[i];
#endif
    return best;
}

static inline uint32_t tile_sum(board_t b)
{
    uint32_t s = 0;
    for (int i = 0; i < NCELL; i++) {
        uint32_t v = (b >> (4 * i)) & 0xF;
        if (v) s += 1u << v;
    }
    return s;
}

static inline uint32_t max_exp(board_t b)
{
    uint32_t m = 0;
    for (int i = 0; i < NCELL; i++) {
        uint32_t v = (b >> (4 * i)) & 0xF;
        if (v > m) m = v;
    }
    return m;
}

/* ------------------------------------------------------------- dyn array */

typedef struct { board_t *a; size_t n, cap; } vec;

static void vec_push(vec *v, board_t x)
{
    if (v->n == v->cap) {
        v->cap = v->cap ? v->cap + v->cap / 2 + 1024 : 1024;
        v->a = realloc(v->a, v->cap * sizeof(board_t));
        if (!v->a) { fprintf(stderr, "oom pushing %zu\n", v->cap); exit(1); }
    }
    v->a[v->n++] = x;
}

static int cmp_board(const void *x, const void *y)
{
    board_t a = *(const board_t *)x, b = *(const board_t *)y;
    return (a > b) - (a < b);
}

static void vec_sort_unique(vec *v)
{
    if (!v->n) return;
    qsort(v->a, v->n, sizeof(board_t), cmp_board);
    size_t m = 1;
    for (size_t i = 1; i < v->n; i++)
        if (v->a[i] != v->a[m - 1]) v->a[m++] = v->a[i];
    v->n = m;
}

static size_t find_board(const board_t *a, size_t n, board_t x)
{
    size_t lo = 0, hi = n;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        if (a[mid] < x) lo = mid + 1; else hi = mid;
    }
    if (lo >= n || a[lo] != x) { fprintf(stderr, "missing successor\n"); exit(1); }
    return lo;
}

/* ---------------------------------------------------------- enumeration */

static vec states[MAXSUM / 2];    /* indexed by tile sum / 2 */

static void seed_openings(void)
{
    for (int c1 = 0; c1 < NCELL; c1++)
        for (int c2 = 0; c2 < NCELL; c2++) {
            if (c1 == c2) continue;
            for (int v1 = 1; v1 <= 2; v1++)
                for (int v2 = 1; v2 <= 2; v2++) {
                    board_t b = ((board_t)v1 << (4 * c1)) | ((board_t)v2 << (4 * c2));
                    vec_push(&states[tile_sum(b) / 2], canonical(b));
                }
        }
}

/* cap: stop once a grade exceeds this many states (0 = run to the end).
 * discard: free each grade once expanded -- counting only, no backward pass. */
static uint32_t enumerate(uint64_t cap, int quiet, int discard)
{
    seed_openings();
    uint32_t maxsum = 0;
    uint64_t total = 0, total_after = 0, total_moves = 0, peak = 0;
    uint32_t peak_sum = 0;

    if (!quiet) printf("%8s %16s %16s %8s\n", "sum", "states", "afterstates", "maxtile");

    for (uint32_t s = 4; s < MAXSUM; s += 2) {
        vec *L = &states[s / 2];
        if (!L->n) continue;
        vec_sort_unique(L);
        maxsum = s;
        total += L->n;
        if (L->n > peak) { peak = L->n; peak_sum = s; }

        if (cap && L->n > cap) {
            if (!quiet)
                printf("%8u %16zu %16s %8s   (cap, stopping)\n", s, L->n, "-", "-");
            goto done;
        }

        /* Afterstates: every legal move from every state in this grade. A
         * goal-directed solve stops dead at the goal tile, so those positions
         * are leaves and nothing past them is ever enumerated. */
        vec after = { 0 };
        uint32_t mt = 0;
        for (size_t i = 0; i < L->n; i++) {
            board_t b = L->a[i];
            uint32_t e = max_exp(b);
            if (e > mt) mt = e;
            if (stop_exp && e >= stop_exp) continue;
            for (int d = 0; d < 4; d++) {
                uint32_t g;
                board_t nb = do_move(b, d, &g);
                if (nb != b) { vec_push(&after, canonical(nb)); total_moves++; }
            }
        }
        vec_sort_unique(&after);
        total_after += after.n;
        if (!quiet) {
            printf("%8u %16zu %16zu %8u\n", s, L->n, after.n, 1u << mt);
            fflush(stdout);
        }

        /* Each afterstate spawns a 2 into grade s+2 and a 4 into grade s+4. */
        for (size_t i = 0; i < after.n; i++) {
            board_t a = after.a[i];
            for (int c = 0; c < NCELL; c++) {
                if ((a >> (4 * c)) & 0xF) continue;
                vec_push(&states[(s + 2) / 2], canonical(a | ((board_t)1 << (4 * c))));
                vec_push(&states[(s + 4) / 2], canonical(a | ((board_t)2 << (4 * c))));
            }
        }
        free(after.a);
        if (discard) { free(L->a); L->a = NULL; L->n = L->cap = 0; }
    }
done:
    if (!quiet)
        printf("\n%dx%d: %llu canonical states, %llu legal (state, move) pairs, "
               "%llu afterstates,\n     %u grades, max sum %u, "
               "peak grade %llu at sum %u\n",
               H, W, (unsigned long long)total, (unsigned long long)total_moves,
               (unsigned long long)total_after,
               maxsum / 2 - 1, maxsum, (unsigned long long)peak, peak_sum);
    return maxsum;
}

/* ------------------------------------------------------------- objectives */

enum { SCORE, P128, P256, P512, P1K, CHAIN_HI, CHAIN_LO, CHAIN_DIR,
       SCORE_P512, P512_SCORE, NOBJ };

static const char *obj_name[NOBJ] = {
    "E[score], score-optimal play",
    "P(128), 128-optimal play",
    "P(256), 256-optimal play",
    "P(512), 512-optimal play",
    "P(1024), 1024-optimal play",
    "P(512), play 256 then 512, ties favour 512",
    "P(512), play 256 then 512, ties favour 256",
    "P(512), play 256 then 512, ties by move order",
    "P(512) under score-optimal play",
    "E[score] under 512-optimal play",
};

static const uint32_t obj_goal[NOBJ] = { 0, 7, 8, 9, 10, 0, 0, 0, 0, 0 };

static double *val[MAXSUM / 2][NOBJ];
static uint8_t *pol[MAXSUM / 2];   /* score-optimal move, 255 if none */

static void solve_all(uint32_t maxsum)
{
    for (int32_t s = (int32_t)maxsum; s >= 4; s -= 2) {
        vec *L = &states[s / 2];
        if (!L->n) continue;
        for (int k = 0; k < NOBJ; k++) {
            val[s / 2][k] = malloc(L->n * sizeof(double));
            if (!val[s / 2][k]) { fprintf(stderr, "oom\n"); exit(1); }
        }
        pol[s / 2] = malloc(L->n);
        if (!pol[s / 2]) { fprintf(stderr, "oom\n"); exit(1); }

        for (size_t i = 0; i < L->n; i++) {
            board_t b = L->a[i];
            uint32_t be = max_exp(b);
            double mv[4][NOBJ];
            int dirof[4];
            int nmoves = 0;

            for (int d = 0; d < 4; d++) {
                uint32_t g;
                board_t nb = do_move(b, d, &g);
                if (nb == b) continue;
                board_t a = canonical(nb);
                uint32_t ae = max_exp(a);

                double acc[NOBJ] = { 0 };
                int empties = 0;
                for (int c = 0; c < NCELL; c++) {
                    if ((a >> (4 * c)) & 0xF) continue;
                    empties++;
                    vec *L2 = &states[(s + 2) / 2], *L4 = &states[(s + 4) / 2];
                    size_t i2 = find_board(L2->a, L2->n,
                                           canonical(a | ((board_t)1 << (4 * c))));
                    size_t i4 = find_board(L4->a, L4->n,
                                           canonical(a | ((board_t)2 << (4 * c))));
                    for (int k = 0; k < NOBJ; k++)
                        acc[k] += 0.9 * val[(s + 2) / 2][k][i2]
                                + 0.1 * val[(s + 4) / 2][k][i4];
                }
                for (int k = 0; k < NOBJ; k++) {
                    double v = acc[k] / empties;
                    if (obj_goal[k] && ae >= obj_goal[k]) v = 1.0;   /* goal made */
                    mv[nmoves][k] = v;
                }
                mv[nmoves][SCORE] += (double)g;
                mv[nmoves][P512_SCORE] += (double)g;
                dirof[nmoves] = d;
                nmoves++;
            }

#define SET(k, x) (val[s / 2][k][i] = (x))

            if (nmoves == 0) {                       /* no legal move: game over */
                pol[s / 2][i] = 255;
                for (int k = 0; k < NOBJ; k++)
                    SET(k, (obj_goal[k] && be >= obj_goal[k]) ? 1.0 : 0.0);
                double won = (be >= 9) ? 1.0 : 0.0;
                SET(CHAIN_HI, won); SET(CHAIN_LO, won); SET(CHAIN_DIR, won);
                SET(SCORE_P512, won);
                continue;
            }

            for (int k = 0; k <= P1K; k++) {
                double best = mv[0][k];
                for (int m = 1; m < nmoves; m++) if (mv[m][k] > best) best = mv[m][k];
                SET(k, (obj_goal[k] && be >= obj_goal[k]) ? 1.0 : best);
            }

            /* Lexicographic policies: choose on the first, read off the second. */
            int bs = 0, b5 = 0;
            for (int m = 1; m < nmoves; m++) {
                if (mv[m][SCORE] > mv[bs][SCORE] ||
                    (mv[m][SCORE] == mv[bs][SCORE] &&
                     mv[m][SCORE_P512] > mv[bs][SCORE_P512])) bs = m;
                if (mv[m][P512] > mv[b5][P512] ||
                    (mv[m][P512] == mv[b5][P512] &&
                     mv[m][P512_SCORE] > mv[b5][P512_SCORE])) b5 = m;
            }
            pol[s / 2][i] = (uint8_t)dirof[bs];
            SET(SCORE_P512, (be >= 9) ? 1.0 : mv[bs][SCORE_P512]);
            SET(P512_SCORE, mv[b5][P512_SCORE]);

            /* Chained goals: play for 256 until it exists, then for 512. Where
             * moves tie for the 256 goal -- which is most of the early game,
             * since P(256) is 1 there -- the tie-break is all that decides. */
            if (be >= 9) {
                SET(CHAIN_HI, 1.0); SET(CHAIN_LO, 1.0); SET(CHAIN_DIR, 1.0);
            } else if (be >= 8) {
                double v = val[s / 2][P512][i];
                SET(CHAIN_HI, v); SET(CHAIN_LO, v); SET(CHAIN_DIR, v);
            } else {
                int hi = 0, lo = 0, fixed = 0;
                for (int m = 1; m < nmoves; m++) {
                    if (mv[m][P256] > mv[hi][P256] ||
                        (mv[m][P256] == mv[hi][P256] &&
                         mv[m][CHAIN_HI] > mv[hi][CHAIN_HI])) hi = m;
                    if (mv[m][P256] > mv[lo][P256] ||
                        (mv[m][P256] == mv[lo][P256] &&
                         mv[m][CHAIN_LO] < mv[lo][CHAIN_LO])) lo = m;
                    if (mv[m][P256] > mv[fixed][P256]) fixed = m;
                }
                SET(CHAIN_HI, mv[hi][CHAIN_HI]);
                SET(CHAIN_LO, mv[lo][CHAIN_LO]);
                SET(CHAIN_DIR, mv[fixed][CHAIN_DIR]);
            }
#undef SET
        }

        int32_t drop = s + 6;                /* only s+2 and s+4 are read again */
        if (drop <= (int32_t)maxsum && val[drop / 2][0])
            for (int k = 0; k < NOBJ; k++) { free(val[drop / 2][k]); val[drop / 2][k] = NULL; }
    }
}


/* ------------------------------------------------- final-score distribution
 *
 * The score is not a function of the board. It is
 *
 *     score = phi(board) - 4 * (number of 4s spawned so far)
 *
 * because phi(v) = v*(log2(v)-1) summed over the tiles rises by exactly the
 * merge value on every merge, by 4 on a spawned 4 and by 0 on a spawned 2. So
 * carrying one extra integer -- the count of 4-spawns -- pins the score down
 * exactly, and a forward pass over the same grades gives the whole
 * distribution of final scores under the score-optimal policy.
 */
static double *dist[MAXSUM / 2];          /* [state * width(s) + n4] */
#define FSMAX (1 << 16)
static double final_score[FSMAX];

static inline size_t width_of(uint32_t s) { return s / 4 + 2; }

static double phi(board_t b)
{
    double p = 0;
    for (int i = 0; i < NCELL; i++) {
        uint32_t v = (b >> (4 * i)) & 0xF;
        if (v) p += (double)(1u << v) * (double)(v - 1);
    }
    return p;
}

static void need_dist(uint32_t s)
{
    if (!dist[s / 2] && states[s / 2].n) {
        dist[s / 2] = calloc(states[s / 2].n * width_of(s), sizeof(double));
        if (!dist[s / 2]) { fprintf(stderr, "oom on grade %u\n", s); exit(1); }
    }
}

static void score_distribution(uint32_t maxsum)
{
    const double pcell = 1.0 / (double)(NCELL * (NCELL - 1));
    for (int c1 = 0; c1 < NCELL; c1++)
        for (int c2 = 0; c2 < NCELL; c2++) {
            if (c1 == c2) continue;
            for (int v1 = 1; v1 <= 2; v1++)
                for (int v2 = 1; v2 <= 2; v2++) {
                    board_t b = ((board_t)v1 << (4 * c1)) | ((board_t)v2 << (4 * c2));
                    double p = (v1 == 1 ? 0.9 : 0.1) * (v2 == 1 ? 0.9 : 0.1) * pcell;
                    uint32_t s = tile_sum(b);
                    need_dist(s);
                    size_t i = find_board(states[s / 2].a, states[s / 2].n, canonical(b));
                    int n4 = (v1 == 2) + (v2 == 2);
                    dist[s / 2][i * width_of(s) + n4] += p;
                }
        }

    for (uint32_t s = 4; s <= maxsum; s += 2) {
        vec *L = &states[s / 2];
        if (!L->n || !dist[s / 2]) continue;
        size_t wid = width_of(s);
        need_dist(s + 2);
        need_dist(s + 4);

        for (size_t i = 0; i < L->n; i++) {
            double *D = &dist[s / 2][i * wid];
            board_t b = L->a[i];
            uint8_t d = pol[s / 2][i];

            if (d == 255) {                       /* game over: bank the score */
                double base = phi(b);
                for (size_t n4 = 0; n4 < wid; n4++)
                    if (D[n4] > 0) final_score[(size_t)(base - 4.0 * n4)] += D[n4];
                continue;
            }
            int live = 0;
            for (size_t n4 = 0; n4 < wid; n4++) if (D[n4] > 0) { live = 1; break; }
            if (!live) continue;

            uint32_t g;
            board_t a = canonical(do_move(b, d, &g));
            int empties = 0;
            for (int c = 0; c < NCELL; c++) if (!((a >> (4 * c)) & 0xF)) empties++;

            for (int c = 0; c < NCELL; c++) {
                if ((a >> (4 * c)) & 0xF) continue;
                board_t s2 = canonical(a | ((board_t)1 << (4 * c)));
                board_t s4 = canonical(a | ((board_t)2 << (4 * c)));
                size_t i2 = find_board(states[(s + 2) / 2].a, states[(s + 2) / 2].n, s2);
                size_t i4 = find_board(states[(s + 4) / 2].a, states[(s + 4) / 2].n, s4);
                double *D2 = &dist[(s + 2) / 2][i2 * width_of(s + 2)];
                double *D4 = &dist[(s + 4) / 2][i4 * width_of(s + 4)];
                for (size_t n4 = 0; n4 < wid; n4++) {
                    if (D[n4] == 0) continue;
                    D2[n4]      += D[n4] * 0.9 / empties;   /* a 2 spawns */
                    D4[n4 + 1]  += D[n4] * 0.1 / empties;   /* a 4 spawns */
                }
            }
        }
        free(dist[s / 2]);
        dist[s / 2] = NULL;
    }
}

/* Value at the start of a game. reset() deals two tiles in sequence: the first
 * onto one of NCELL cells, the second onto one of the NCELL-1 left, each a 2
 * with p=0.9. So ordered cell pairs are uniform over NCELL*(NCELL-1). */
static double opening_of(int k)
{
    double acc = 0;
    const double pcell = 1.0 / (double)(NCELL * (NCELL - 1));
    for (int c1 = 0; c1 < NCELL; c1++)
        for (int c2 = 0; c2 < NCELL; c2++) {
            if (c1 == c2) continue;
            for (int v1 = 1; v1 <= 2; v1++)
                for (int v2 = 1; v2 <= 2; v2++) {
                    board_t b = ((board_t)v1 << (4 * c1)) | ((board_t)v2 << (4 * c2));
                    double p = (v1 == 1 ? 0.9 : 0.1) * (v2 == 1 ? 0.9 : 0.1);
                    uint32_t s = tile_sum(b);
                    vec *L = &states[s / 2];
                    acc += p * pcell * val[s / 2][k][find_board(L->a, L->n, canonical(b))];
                }
        }
    return acc;
}


/* The mass must come to 1 and the mean must equal the expected score the
 * backward induction found, which is the check on the phi identity. */
static void report_scores(void)
{
    static const int marks[] = { 1000, 2000, 3000, 4000, 5000, 6000, 7000,
                                 8000, 10000, 12000, 14000, 0 };
    double mass = 0, mean = 0;
    for (size_t v = 0; v < FSMAX; v++) { mass += final_score[v]; mean += v * final_score[v]; }
    printf("\nfinal score: mass %.12f, mean %.6f\n", mass, mean);

    printf("%10s %14s\n", "X", "P(final >= X)");
    double tail = 1.0;
    for (size_t v = 0, m = 0; v < FSMAX; v++) {
        if (marks[m] && (size_t)marks[m] == v) { printf("%10zu %14.6f\n", v, tail); m++; }
        tail -= final_score[v];
    }

    FILE *f = fopen("scoredist.csv", "w");
    if (!f) return;
    for (size_t v = 0; v < FSMAX; v++)
        if (final_score[v] > 0) fprintf(f, "%zu,%.12g\n", v, final_score[v]);
    fclose(f);
}

/* A cross-check hook: read hex boards on stdin, print each move's result and
 * gain, so the same boards can be run through site/vanilla-2048/board.js. */
static void move_test(void)
{
    char line[64];
    while (fgets(line, sizeof line, stdin)) {
        board_t b = strtoull(line, NULL, 16);
        printf("%016llx", (unsigned long long)b);
        for (int d = 0; d < 4; d++) {
            uint32_t g;
            board_t nb = do_move(b, d, &g);
            printf(" %016llx:%u", (unsigned long long)nb, g);
        }
        printf("\n");
    }
}

int main(int argc, char **argv)
{
    build_tables();
    const char *mode = argc > 1 ? argv[1] : "count";
    uint64_t cap = argc > 2 ? strtoull(argv[2], NULL, 10) : 0;
    if (!strcmp(mode, "countraw")) { use_sym = 0; mode = "count"; }
    /* "count512" / "countraw512": stop the game dead at that tile. */
    {
        const char *g = getenv("GOAL");
        if (g) {
            if (strcmp(mode, "count")) {
                fprintf(stderr, "GOAL truncates the graph; it only makes "
                                "sense with count/countraw\n");
                return 2;
            }
            uint32_t v = strtoul(g, NULL, 10);
            while ((1u << stop_exp) < v) stop_exp++;
        }
    }

    if (!strcmp(mode, "movetest")) { move_test(); return 0; }

    clock_t t0 = clock();
    if (!strcmp(mode, "count")) {
        enumerate(cap, 0, 1);
        printf("elapsed %.1fs\n", (double)(clock() - t0) / CLOCKS_PER_SEC);
        return 0;
    }

    int want_dist = !strcmp(mode, "scoredist");
    uint32_t maxsum = enumerate(0, 1, 0);
    double t_enum = (double)(clock() - t0) / CLOCKS_PER_SEC;
    printf("%dx%d, enumerated to tile sum %u in %.1fs\n", H, W, maxsum, t_enum);
    solve_all(maxsum);
    printf("solved in %.1fs\n", (double)(clock() - t0) / CLOCKS_PER_SEC - t_enum);
    for (int k = 0; k < NOBJ; k++)
        printf("  %-46s %18.12f\n", obj_name[k], opening_of(k));
    if (want_dist) {
        score_distribution(maxsum);
        report_scores();
    }
    printf("elapsed %.1fs\n", (double)(clock() - t0) / CLOCKS_PER_SEC);
    return 0;
}
