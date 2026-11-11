// The snapshot must decode to exactly what the live fetch gives.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { makeShowtime } from "../../site/js/models.js";
import { parseGscCinemas, parseGscShowtimes, parseTgvCinemas, parseTgvShowtimes } from "../../site/js/providers.js";
import { decodeSnapshot, encodeSnapshot, loadSnapshot, snapshotRegressions } from "../../site/js/snapshot.js";
import { parseXml } from "../../scripts/xml.mjs";

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const byKey = (a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);

function sampleDays() {
  const gsc = parseGscCinemas(JSON.parse(fixture("gsc_locations.json")));
  const tgv = parseTgvCinemas(JSON.parse(fixture("tgv_states.json")));
  const gscShows = parseGscShowtimes(fixture("gsc_showtimes_120.xml"), gsc[0], parseXml); // 15 Oct, one after midnight
  const tgvShows = parseTgvShowtimes(JSON.parse(fixture("tgv_sessions_PKL.json")), tgv[0]); // 14 Oct
  return [
    { date: "2026-10-14", cinemas: [...gsc, ...tgv], showtimes: tgvShows, errors: [] },
    { date: "2026-10-15", cinemas: [...gsc, ...tgv], showtimes: gscShows, errors: ["TGV TGV Bukit Indah: timed out"] },
    { date: "2026-10-16", cinemas: [...gsc, ...tgv], showtimes: [], errors: [] }, // not published yet
  ];
}

test("snapshot round-trips every show exactly, after-midnight included", () => {
  const days = sampleDays();
  const decoded = decodeSnapshot(JSON.parse(JSON.stringify(encodeSnapshot(days, "2026-10-14T06:00:00.000Z"))));
  const original = days.flatMap((d) => d.showtimes);
  assert.equal(decoded.showtimes.length, original.length);
  assert.deepEqual([...decoded.showtimes].sort(byKey), [...original].sort(byKey));
  const late = decoded.showtimes.find((s) => s.start === "2026-10-16T00:15");
  assert.equal(late.business_date, "2026-10-15");
  assert.equal(late.sold_out, true);
});

test("snapshot keeps days, empty days, errors and cinema locations", () => {
  const decoded = decodeSnapshot(encodeSnapshot(sampleDays(), "2026-10-14T06:00:00.000Z"));
  assert.deepEqual(decoded.days, ["2026-10-14", "2026-10-15", "2026-10-16"]);
  assert.deepEqual(decoded.errors, { "2026-10-15": ["TGV TGV Bukit Indah: timed out"] });
  const pkl = decoded.cinemas.find((c) => c.cinema_id === "PKL");
  assert.ok(Math.abs(pkl.latitude - 3.149) < 0.001, "TGV location learned from its shows");
  assert.equal(decoded.cinemas.find((c) => c.cinema_id === "BI0").latitude, null);
});

test("snapshot is much smaller than the plain showtimes", () => {
  const days = sampleDays();
  const plain = JSON.stringify(days.flatMap((d) => d.showtimes)).length;
  const packed = JSON.stringify(encodeSnapshot(days, "x")).length;
  assert.ok(packed < plain / 2, `${packed} vs ${plain}`);
});

test("loadSnapshot: an old file is kept and marked stale; a very old or missing one falls back (null)", async () => {
  const snap = encodeSnapshot(sampleDays(), "2026-10-14T06:00:00.000Z");
  const serve = (body, ok = true) => async () => ({ ok, json: async () => body });
  const fresh = await loadSnapshot({ fetch: serve(snap), now: Date.parse("2026-10-14T10:00:00Z") });
  assert.equal(fresh.showtimes.length, 14);
  assert.equal(fresh.stale, false);
  const old = await loadSnapshot({ fetch: serve(snap), now: Date.parse("2026-10-15T10:00:00Z") });
  assert.equal(old.showtimes.length, 14);
  assert.equal(old.stale, true);
  assert.equal(await loadSnapshot({ fetch: serve(snap), now: Date.parse("2026-10-16T10:00:00Z") }), null);
  assert.equal(await loadSnapshot({ fetch: serve({ ...snap, generated_at: "nonsense" }) }), null);
  assert.equal(await loadSnapshot({ fetch: serve(null, false) }), null);
  assert.equal(await loadSnapshot({ fetch: async () => { throw new Error("offline"); } }), null);
  assert.ok(makeShowtime);
});

test("cinemas sharing a GSC code (regular + premium hall) stay separate", () => {
  const regular = { chain: "GSC", cinema_id: "260", name: "Petaling Jaya - 1 Utama (New Wing)", region: "Klang Valley", hall_group: "" };
  const prestige = { ...regular, name: "GSC HLB Prestige - 1 Utama (New Wing)", hall_group: "PRESTIGE_1U2" };
  const show = (c, hour) =>
    makeShowtime({ chain: "GSC", cinema_id: "260", cinema_name: c.name, region: c.region, movie_title: "Jailer 2", start: `2026-10-15T${hour}:00`, business_date: "2026-10-15" });
  const decoded = decodeSnapshot(
    encodeSnapshot([{ date: "2026-10-15", cinemas: [regular, prestige], showtimes: [show(regular, "20"), show(prestige, "21")], errors: [] }], "x"),
  );
  assert.deepEqual(decoded.showtimes.map((s) => s.cinema_name).sort(), [prestige.name, regular.name].sort());
  assert.equal(decoded.cinemas.length, 2);
});

test("snapshotRegressions: a chain that lost most of its cinemas blocks the refresh", () => {
  // Ten cinemas per chain, each with one show; then GSC answers with a one-cinema list.
  const pack = (gsc, tgv) => {
    const cinemas = [...Array(gsc).keys()].map((i) => ["GSC", String(i), `G${i}`]).concat([...Array(tgv).keys()].map((i) => ["TGV", String(i), `T${i}`]));
    return { cinemas, shows: cinemas.map((_, i) => [0, i, 0, 600, 0, 0, 0]) };
  };
  assert.deepEqual(snapshotRegressions(pack(10, 10), pack(10, 10)), []);
  assert.deepEqual(snapshotRegressions(pack(10, 10), pack(7, 12)), []);
  assert.deepEqual(snapshotRegressions(pack(10, 10), pack(1, 10)), ["GSC: cinemas with shows 1, down from 10"]);
  assert.deepEqual(snapshotRegressions(pack(10, 10), pack(10, 0)), ["TGV: cinemas with shows 0, down from 10"]);
  // A recovery (the published one was the short one) and a first deploy are fine.
  assert.deepEqual(snapshotRegressions(pack(1, 10), pack(10, 10)), []);
  assert.deepEqual(snapshotRegressions(null, pack(10, 10)), []);
});
