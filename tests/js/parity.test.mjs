// Cross-check: the JS parsers must give exactly what the Python parsers give for the fixtures.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { normalizeTitle } from "../../site/js/models.js";
import {
  parseGscCinemas,
  parseGscShowtimes,
  parseTgvCinemas,
  parseTgvShowtimes,
} from "../../site/js/providers.js";
import { parseXml } from "../../scripts/xml.mjs";
import { TGV_NAMES, tgvCinemaName } from "../../site/js/places.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

const TITLES = [
  "(IMAX) Jailer 2",
  "Jailer 2 (Tamil)",
  "[BED] OTHER MOMMY",
  "Go for Broke 2 重生2",
  "Good Trip 我阿爹想旅行",
  "Coolie கூலி",
  "  Avengers:Endgame   Encore ",
  "Amélie (2D) [ATMOS]",
  "Pokémon: The Movie",
  "(GUARANTEED POSTER) Godzilla Minus Zero",
  "(KINOFF26) Hello Betty (Hallo Betty)",
  "Terbang (2026)",
  "(Ünïcode) Tag [ÉTÉ] Title",
  "Spider-Man™ No Way Home",
  "Ne Zha 2 哪吒之魔童闹海 (MAN)",
  "Wide\u3000Space\u00a0Title",
  "",
];

function python() {
  const script = `
import json, sys
from pathlib import Path
from cinema_showtimes import gsc, tgv
from cinema_showtimes.models import normalize_title
f = Path("tests/fixtures")
g = gsc.parse_cinemas(json.loads((f / "gsc_locations.json").read_text()))
t = tgv.parse_cinemas(json.loads((f / "tgv_states.json").read_text()))
print(json.dumps({
  "gsc_cinemas": [c.__dict__ for c in g],
  "tgv_cinemas": [c.__dict__ for c in t],
  "gsc": [s.to_dict() for s in gsc.parse_showtimes((f / "gsc_showtimes_120.xml").read_text(), g[0])],
  "tgv": [s.to_dict() for s in tgv.parse_showtimes(json.loads((f / "tgv_sessions_PKL.json").read_text()), t[0])],
  "titles": [normalize_title(x) for x in json.loads(sys.argv[1])],
  "tgv_names": tgv.NAMES,
  "tgv_fallback": tgv.cinema_name("NEW", "TGV Some Mall (New)", "Johor"),
}))
`;
  try {
    return JSON.parse(execFileSync(process.platform === "win32" ? "python" : "python3", ["-c", script, JSON.stringify(TITLES)], { cwd: root }));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

test("JS and Python parsers agree on every fixture", (t) => {
  const py = python();
  if (!py) return t.skip("python3 not available");

  const gscCinemas = parseGscCinemas(JSON.parse(fixture("gsc_locations.json")));
  const tgvCinemas = parseTgvCinemas(JSON.parse(fixture("tgv_states.json")));
  assert.deepEqual(gscCinemas, py.gsc_cinemas);
  assert.deepEqual(tgvCinemas, py.tgv_cinemas);
  assert.deepEqual(parseGscShowtimes(fixture("gsc_showtimes_120.xml"), gscCinemas[0], parseXml), py.gsc);
  assert.deepEqual(parseTgvShowtimes(JSON.parse(fixture("tgv_sessions_PKL.json")), tgvCinemas[0]), py.tgv);
  assert.deepEqual(TITLES.map(normalizeTitle), py.titles);
  assert.deepEqual(TGV_NAMES, py.tgv_names);
  assert.equal(tgvCinemaName("NEW", "TGV Some Mall (New)", "Johor"), py.tgv_fallback);
});
