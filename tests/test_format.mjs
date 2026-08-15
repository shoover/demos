/**
 * Unit tests for the pure formatting helpers in site/vanilla-2048/format.js.
 *
 * Kept outside site/ so GitHub Pages does not publish them. Node's built-in test
 * runner only: the demo's own dependencies live in the browser, not in this checkout.
 * Run with `just test-js`, or `node --test tests/`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { abbreviate, count, formatDuration } from "../site/vanilla-2048/format.js";

test("count groups digits with commas", () => {
  assert.equal(count(0), "0");
  assert.equal(count(999), "999");
  assert.equal(count(9999999), "9,999,999");
});

for (const [value, expected] of [
  [0, "0"],
  [999, "999"],
  [1000, "1k"],
  [10096, "10.1k"],
  [10049, "10k"],
  [10050, "10.1k"],
  [999999, "1M"],
  [1234567, "1.2M"],
  [9999999, "10M"],
  [999999999, "1B"],
  [1000000000, "1B"],
]) {
  test(`abbreviate(${value}) is "${expected}"`, () => {
    assert.equal(abbreviate(value), expected);
  });
}

test("abbreviate never grows longer once a unit is reached", () => {
  // The score line's whole reason to abbreviate: nothing past 1000 should ever again
  // run longer than a small number of characters, however many digits it started with.
  for (const value of [1000, 999999, 1000000, 999999999, 1000000000]) {
    assert.ok(abbreviate(value).length <= 5, `${value} -> ${abbreviate(value)}`);
  }
});

for (const [seconds, expected] of [
  [0, "0:00"],
  [45, "0:45"],
  [59, "0:59"],
  [60, "1:00"],
  [184, "3:04"],
  [59.9, "0:59"], // fractional playSeconds floors, so this doesn't tick over to 1:00 early
  [90.6, "1:30"],
  [3540, "59:00"],
  [3599, "59:59"],
  [3600, "1:00:00"], // the hour appears once there is one, not as a leading "0:"
  [12345, "3:25:45"],
  [86399, "23:59:59"],
  [86400, "24:00:00"], // hours keep counting up rather than rolling over into days
]) {
  test(`formatDuration(${seconds}) is "${expected}"`, () => {
    assert.equal(formatDuration(seconds), expected);
  });
}
