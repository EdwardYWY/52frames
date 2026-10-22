// Tests for site/js/aggregator.js and models.js, mirroring tests/test_aggregator.py.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectShowtimes,
  createCache,
  filterShowtimes,
  groupByMovie,
  posterCandidates,
  summarizeMovies,
} from "../../site/js/aggregator.js";
import { addDays, distanceKm, makeShowtime, normalizeTitle, todayMyt } from "../../site/js/models.js";

const show = (chain, cinema, title, hour, region = "Klang Valley") =>
  makeShowtime({
    chain,
    cinema_id: cinema,
    cinema_name: cinema,
    region,
    movie_title: title,
    start: `2026-10-15T${String(hour).padStart(2, "0")}:00`,
    business_date: "2026-10-15",
  });

test("normalizeTitle strips tags, case and punctuation", () => {
  assert.equal(normalizeTitle("(IMAX) Jailer 2"), "jailer 2");
  assert.equal(normalizeTitle("[BED] OTHER MOMMY"), "other mommy");
  assert.equal(normalizeTitle("(InfinityVision) Avengers:Endgame Encore"), "avengers endgame encore");
});

test("normalizeTitle drops only same-movie tags; other tags make a separate movie", () => {
  assert.equal(normalizeTitle("Terbang (2026)"), "terbang");
  assert.equal(normalizeTitle("(Infinity Vision) Avengers: Doomsday"), "avengers doomsday");
  assert.equal(normalizeTitle("(GUARANTEED POSTER) Godzilla Minus Zero"), "guaranteed poster godzilla minus zero");
  assert.equal(normalizeTitle("(SPECIAL) Clayface"), "special clayface");
  assert.equal(normalizeTitle("[REBROADCAST] BTS LIVE"), "rebroadcast bts live");
});

test("normalizeTitle drops non-Latin words so bilingual titles match", () => {
  assert.equal(normalizeTitle("Go for Broke 2 重生2"), "go for broke 2");
  assert.equal(normalizeTitle("Good Trip 我阿爹想旅行"), "good trip");
  assert.equal(normalizeTitle("Jailer 2 (Tamil)"), "jailer 2");
});

const threeShows = () => [
  show("GSC", "Mid Valley", "Jailer 2", 20),
  show("TGV", "Pavilion KL", "Jailer 2", 21),
  show("TGV", "Bukit Indah", "Other Mommy", 19, "Southern"),
];

test("no filters returns all, sorted by start", () => {
  assert.deepEqual(
    filterShowtimes(threeShows()).map((s) => s.start.slice(11, 13)),
    ["19", "20", "21"],
  );
});

test("filters by chain, region, cinema and movie", () => {
  const shows = threeShows();
  assert.equal(filterShowtimes(shows, { chains: ["gsc"] }).length, 1);
  assert.equal(filterShowtimes(shows, { region: "southern" }).length, 1);
  assert.equal(filterShowtimes(shows, { cinema: "pavilion" }).length, 1);
  assert.equal(filterShowtimes(shows, { movie: "JAILER" }).length, 2);
});

test("filters by earliest start time", () => {
  assert.deepEqual(
    filterShowtimes(threeShows(), { after: "20:30" }).map((s) => s.cinema_name),
    ["Pavilion KL"],
  );
});

test("the start-time filter keeps after-midnight shows", () => {
  const late = makeShowtime({
    chain: "GSC",
    cinema_name: "Queensbay",
    movie_title: "Go For Broke 2",
    start: "2026-10-16T00:15",
    business_date: "2026-10-15",
  });
  assert.deepEqual(filterShowtimes([...threeShows(), late], { after: "20:30" }).length, 2);
});

test("the same movie from both chains is grouped", () => {
  const groups = groupByMovie([
    show("GSC", "Mid Valley", "(IMAX) Jailer 2", 20),
    show("TGV", "Pavilion KL", "Jailer 2", 21),
  ]);
  assert.deepEqual([...groups.keys()], ["jailer 2"]);
  assert.equal(groups.get("jailer 2").length, 2);
});

test("one chain failing still returns the other", async () => {
  const good = { chain: "TGV", cinema_id: "PKL", name: "TGV Pavilion", region: "Klang Valley" };
  const providers = {
    GSC: {
      fetchCinemas: async () => {
        throw new Error("network down");
      },
      fetchShowtimes: async () => assert.fail("should not be called"),
    },
    TGV: {
      fetchCinemas: async () => [good],
      fetchShowtimes: async (cinema) => [show("TGV", cinema.name, "Jailer 2", 20)],
    },
  };
  const errors = [];
  const result = await collectShowtimes("2026-10-15", { providers, onError: (e) => errors.push(e) });
  assert.equal(result.showtimes.length, 1);
  assert.equal(result.showtimes[0].chain, "TGV");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /GSC/);
  assert.deepEqual(errors, result.errors);
});

test("one cinema failing still returns the rest, with progress", async () => {
  const cinemas = ["A", "B", "C"].map((id) => ({ chain: "TGV", cinema_id: id, name: id, region: "Klang Valley" }));
  const providers = {
    TGV: {
      fetchCinemas: async () => cinemas,
      fetchShowtimes: async (c) => {
        if (c.cinema_id === "B") throw new Error("timed out");
        return [show("TGV", c.name, "Jailer 2", 20)];
      },
    },
  };
  const progress = [];
  const result = await collectShowtimes("2026-10-15", {
    providers,
    onProgress: (p) => progress.push(`${p.done}/${p.total}`),
  });
  assert.equal(result.showtimes.length, 2);
  assert.deepEqual(result.errors, ["TGV B: timed out"]);
  assert.deepEqual(progress, ["0/3", "1/3", "2/3", "3/3"]);
});

test("only fetches cinemas matching the region", async () => {
  const fetched = [];
  const providers = {
    TGV: {
      fetchCinemas: async () => [
        { chain: "TGV", cinema_id: "A", name: "A", region: "Klang Valley" },
        { chain: "TGV", cinema_id: "B", name: "B", region: "Southern" },
      ],
      fetchShowtimes: async (c) => {
        fetched.push(c.cinema_id);
        return [];
      },
    },
  };
  await collectShowtimes("2026-10-15", { providers, region: "southern" });
  assert.deepEqual(fetched, ["B"]);
});

test("never runs more than the concurrency limit at once", async () => {
  const cinemas = Array.from({ length: 20 }, (_, i) => ({ chain: "TGV", cinema_id: `C${i}`, name: `C${i}`, region: "x" }));
  let inFlight = 0;
  let peak = 0;
  const providers = {
    TGV: {
      fetchCinemas: async () => cinemas,
      fetchShowtimes: async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return [];
      },
    },
  };
  await collectShowtimes("2026-10-15", { providers, concurrency: 6 });
  assert.equal(peak, 6);
});

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  get length() {
    return this.map.size;
  }
  key(i) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

test("cache hits skip the network, and entries expire", async () => {
  let clock = 0;
  const cache = createCache(new MemoryStorage(), { ttlMs: 1000, now: () => clock });
  let calls = 0;
  const providers = {
    TGV: {
      fetchCinemas: async () => [{ chain: "TGV", cinema_id: "A", name: "A", region: "x" }],
      fetchShowtimes: async (c) => {
        calls++;
        return [show("TGV", c.name, "Jailer 2", 20)];
      },
    },
  };
  await collectShowtimes("2026-10-15", { providers, cache });
  await collectShowtimes("2026-10-15", { providers, cache });
  assert.equal(calls, 1);
  await collectShowtimes("2026-10-16", { providers, cache });
  assert.equal(calls, 2, "a different date is a different key");
  clock = 1500;
  await collectShowtimes("2026-10-15", { providers, cache });
  assert.equal(calls, 3);
});

test("a broken storage never breaks loading", async () => {
  const throwing = new Proxy(
    {},
    {
      get() {
        throw new Error("SecurityError");
      },
    },
  );
  const cache = createCache(throwing);
  cache.set("k", 1); // must not throw
  assert.equal(cache.get("k"), 1, "still cached in memory for this tab");
  assert.equal(cache.get("missing"), undefined);
  cache.prune();
});

test("todayMyt uses Malaysia time", () => {
  // 2026-10-14 17:30 UTC is already 15 Oct 01:30 in Kuala Lumpur.
  assert.equal(todayMyt(new Date("2026-10-14T17:30:00Z")), "2026-10-15");
  assert.equal(todayMyt(new Date("2026-10-14T15:59:00Z")), "2026-10-14");
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
});

test("posters: both chains' posters are offered, highest resolution first", () => {
  const gsc = { ...show("GSC", "Mid Valley", "(IMAX) Jailer 2", 20), poster_url: "g-big", poster_small_url: "g-med" };
  const tgv = { ...show("TGV", "Pavilion KL", "Jailer 2", 21), poster_url: "t-poster" };
  const again = { ...show("GSC", "Sunway", "Jailer 2", 22), poster_url: "g-big", poster_small_url: "g-med" };
  assert.deepEqual(posterCandidates([tgv, gsc, again]), [
    { url: "g-big", width: 500 },
    { url: "t-poster", width: 436 },
    { url: "g-med", width: 232 },
  ]);
  assert.deepEqual(posterCandidates([show("TGV", "x", "No Poster", 20)]), []);
});

test("summarizeMovies merges chains into one card per movie", () => {
  const [jailer, mommy] = summarizeMovies([
    { ...show("GSC", "Mid Valley", "(IMAX) Jailer 2", 20), duration_mins: 170, rating: "16" },
    show("TGV", "Pavilion KL", "Jailer 2", 18),
    show("TGV", "Pavilion KL", "Jailer 2", 22),
    show("TGV", "Bukit Indah", "Other Mommy", 19),
  ]);
  assert.equal(jailer.key, "jailer 2");
  assert.equal(jailer.title, "Jailer 2");
  assert.deepEqual(jailer.chains, ["GSC", "TGV"]);
  assert.equal(jailer.showCount, 3);
  assert.equal(jailer.cinemaCount, 2);
  assert.equal(jailer.duration_mins, 170);
  assert.equal(jailer.rating, "16");
  assert.equal(jailer.firstStart, "2026-10-15T18:00");
  assert.equal(mommy.title, "Other Mommy");
});

test("distanceKm: Pavilion KL to Sunway Pyramid is about 14 km", () => {
  const pavilion = { latitude: 3.1489607, longitude: 101.7134125 };
  const sunway = { latitude: 3.0726, longitude: 101.6067 };
  const km = distanceKm(pavilion, sunway);
  assert.ok(km > 14 && km < 15, String(km));
  assert.equal(distanceKm(pavilion, { latitude: null, longitude: 101 }), null);
  assert.equal(distanceKm(pavilion, pavilion), 0);
});

test("every TGV location is inside Malaysia and not a copy of another", async () => {
  const { TGV_LOCATIONS } = await import("../../site/js/places.js");
  const points = Object.values(TGV_LOCATIONS);
  assert.ok(points.length >= 45);
  for (const [lat, lng] of points) {
    assert.ok(lat > 0.8 && lat < 7.5 && lng > 99.5 && lng < 119.5, `${lat},${lng}`);
  }
  assert.equal(new Set(points.map(String)).size, points.length);
});

test("every TGV cinema with a location has a unique Town - Mall name", async () => {
  const { TGV_LOCATIONS, TGV_NAMES } = await import("../../site/js/places.js");
  assert.deepEqual(Object.keys(TGV_NAMES).sort(), Object.keys(TGV_LOCATIONS).sort());
  const names = Object.values(TGV_NAMES);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^[^-]+ - \S/);
  for (const name of names) assert.doesNotMatch(name, /\bTGV\b|\(New\)/i);
});

test("a full storage keeps working: memory serves repeats, oldest stored entries make room", () => {
  let clock = 0;
  const store = new MemoryStorage();
  const limit = 3; // entries
  const small = {
    get length() {
      return store.length;
    },
    key: (i) => store.key(i),
    getItem: (k) => store.getItem(k),
    removeItem: (k) => store.removeItem(k),
    setItem(k, v) {
      if (!store.map.has(k) && store.length >= limit) throw new Error("QuotaExceededError");
      store.setItem(k, v);
    },
  };
  const cache = createCache(small, { ttlMs: 1000, now: () => clock });
  for (const day of ["d1", "d2", "d3", "d4", "d5"]) {
    clock++;
    cache.set(day, day.toUpperCase());
  }
  // Every day is still served (memory), and storage holds the newest three.
  assert.deepEqual(["d1", "d2", "d3", "d4", "d5"].map((d) => cache.get(d)), ["D1", "D2", "D3", "D4", "D5"]);
  assert.equal(store.length, 3);
  assert.ok(store.getItem("showtimes:v3:d5"));
  assert.equal(store.getItem("showtimes:v3:d1"), null);
  // A fresh tab (no memory) still finds what storage kept.
  const reloaded = createCache(small, { ttlMs: 1000, now: () => clock });
  assert.equal(reloaded.get("d5"), "D5");
  assert.equal(reloaded.get("d1"), undefined);
});

test("the same session listed under two TGV movie entries counts once", async () => {
  const { uniqueShows } = await import("../../site/js/aggregator.js");
  const { makeShowtime } = await import("../../site/js/models.js");
  const base = { chain: "TGV", cinema_id: "BKM", cinema_name: "Bukit Mertajam - AEON Bukit Mertajam", language: "Tamil", start: "2026-10-15T09:00", business_date: "2026-10-15", experience: "DELUXE", hall: "Cinema 6" };
  const shows = [
    makeShowtime({ ...base, movie_title: "Jailer 2 (Tamil)" }),
    makeShowtime({ ...base, movie_title: "(First Day First Showing) Jailer 2" }),
    makeShowtime({ ...base, movie_title: "Jailer 2 (Tamil)", hall: "Cinema 5", start: "2026-10-15T09:30" }),
  ];
  // The tagged entry is kept, so the session is on the special screening's card only.
  assert.deepEqual(uniqueShows(shows).map((s) => s.movie_title), ["(First Day First Showing) Jailer 2", "Jailer 2 (Tamil)"]);
});

test("GSC language codes and TGV language names group together", async () => {
  const { normalizeLanguage, movieGroupKey } = await import("../../site/js/models.js");
  assert.equal(normalizeLanguage("IND"), "Bahasa Indonesia");
  assert.equal(normalizeLanguage("Bahasa Indonesia"), "Bahasa Indonesia");
  assert.equal(normalizeLanguage("CAN"), normalizeLanguage("Cantonese"));
  assert.equal(normalizeLanguage("THA"), normalizeLanguage("Thai"));
  assert.equal(movieGroupKey({ movie_key: "x", language: "IND" }), movieGroupKey({ movie_key: "x", language: "Bahasa Indonesia" }));
});
