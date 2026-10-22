// Tests for site/js/halls.js: chain hall codes as hall types.
import assert from "node:assert/strict";
import { test } from "node:test";

import { hallLabel, hallTypes, sortHallTypes } from "../../site/js/halls.js";

test("plain halls of both chains are Standard", () => {
  assert.deepEqual(hallTypes("2D"), ["standard"]);
  assert.deepEqual(hallTypes("DELUXE"), ["standard"]);
});

test("children's halls of both chains are Kids", () => {
  assert.deepEqual(hallTypes("PLAY"), ["kids"]);
  assert.deepEqual(hallTypes("JUNIOR-HOTWHEEL"), ["kids"]);
});

test("IMAX and TGV's IMAX Laser are one type", () => {
  assert.deepEqual(hallTypes("IMAX"), ["IMAX"]);
  assert.deepEqual(hallTypes("IMAXLASER"), ["IMAX"]);
});

test("every other code is its own type", () => {
  assert.deepEqual(hallTypes("INDULGE-BED"), ["INDULGE-BED"]);
  assert.deepEqual(hallTypes("VR"), ["VR"]);
});

test("a label with several codes has several types", () => {
  assert.deepEqual(hallTypes("ATMOS BIG DBOX"), ["ATMOS", "BIG", "DBOX"]);
  assert.deepEqual(hallTypes("ATMOS__INFINITY-V"), ["ATMOS", "INFINITY-V"]);
  assert.deepEqual(hallTypes("3D ONYX"), ["3D", "ONYX"]);
});

test("no label, no type", () => {
  assert.deepEqual(hallTypes(""), []);
  assert.deepEqual(hallTypes(undefined), []);
});

test("menu order and names", () => {
  assert.deepEqual(
    sortHallTypes(["kids", "ATMOS", "IMAX", "standard", "4DX"]),
    ["standard", "IMAX", "4DX", "ATMOS", "kids"],
  );
  assert.equal(hallLabel("DBOX"), "D-BOX");
  assert.equal(hallLabel("standard"), "Standard · 2D, Deluxe");
  assert.equal(hallLabel("NEWCODE"), "NEWCODE");
});
