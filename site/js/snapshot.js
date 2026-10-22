// The shared snapshot: a scheduled GitHub Action (scripts/snapshot.mjs) fetches every cinema for
// all published booking dates, every 6 hours, and publishes one compact file, data/showtimes.json. Browsers
// load that single file instead of calling GSC and TGV, so the load on the chains is the same
// however many people use the site, and switching dates or regions needs no further requests.
//
// To keep the file small, cinemas, movies and labels are stored once and each show is a row of
// numbers:  [day, cinema, movie, minute, experience, hall, soldOut]
// where minute counts from midnight of the business day (>= 1440 means after midnight).

import { addDays, makeShowtime } from "./models.js?v=28";
import { tgvCinemaName } from "./places.js?v=28";

export const SNAPSHOT_URL = "data/showtimes.json";
/** Older than this, the page fetches live instead (the job runs every 6 h; cron can run late). */
export const SNAPSHOT_MAX_AGE_MS = 13 * 3600 * 1000;
export const SNAPSHOT_VERSION = 3;

const MOVIE_FIELDS = [
  "chain",
  "movie_title",
  "duration_mins",
  "rating",
  "language",
  "booking_url",
  "poster_url",
  "poster_small_url",
  "subtitles",
  "info_url",
  "genres",
  "tags",
];
const CINEMA_FIELDS = ["chain", "cinema_id", "name", "region", "state", "hall_group", "latitude", "longitude"];

function table() {
  const index = new Map();
  const rows = [];
  return {
    rows,
    id(row) {
      const key = JSON.stringify(row);
      if (!index.has(key)) {
        index.set(key, rows.length);
        rows.push(row);
      }
      return index.get(key);
    },
  };
}

const minutesBetween = (businessDate, start) => {
  const days = Math.round((Date.parse(`${start.slice(0, 10)}T00:00:00Z`) - Date.parse(`${businessDate}T00:00:00Z`)) / 86400000);
  return days * 1440 + Number(start.slice(11, 13)) * 60 + Number(start.slice(14, 16));
};

/**
 * Pack days of results into the snapshot.
 * `days` is [{ date, showtimes, cinemas, errors }] as returned by collectShowtimes().
 */
export function encodeSnapshot(days, generatedAt) {
  const cinemas = table();
  const movies = table();
  const labels = table();
  const dates = table();
  const cinemaIds = new Map(); // "CHAIN|id|name" -> row index
  const out = { version: SNAPSHOT_VERSION, generated_at: generatedAt, days: [], errors: {}, cinemas: [], movies: [], labels: [], shows: [] };

  const cinemaRow = (c, place = {}) => {
    // GSC reuses a cinema code for its premium halls (e.g. 1 Utama and HLB Prestige 1 Utama),
    // so the name is part of the key.
    const key = `${c.chain}|${c.cinema_id}|${c.name}`;
    if (!cinemaIds.has(key)) {
      const row = CINEMA_FIELDS.map((f) => c[f] ?? (f === "latitude" || f === "longitude" ? null : ""));
      cinemaIds.set(key, cinemas.id(row));
    }
    const row = cinemas.rows[cinemaIds.get(key)];
    // TGV cinemas learn their location from the shows (map link per cinema).
    if (row[6] == null && place.latitude != null) {
      row[6] = place.latitude;
      row[7] = place.longitude;
    }
    return cinemaIds.get(key);
  };

  for (const day of days) {
    dates.id(day.date);
    for (const c of day.cinemas) cinemaRow(c);
    if (day.errors?.length) out.errors[day.date] = day.errors;
    for (const s of day.showtimes) {
      const cinema = cinemaRow(
        { chain: s.chain, cinema_id: s.cinema_id, name: s.cinema_name, region: s.region },
        { latitude: s.latitude, longitude: s.longitude },
      );
      out.shows.push([
        dates.id(s.business_date),
        cinema,
        movies.id(MOVIE_FIELDS.map((f) => s[f] ?? null)),
        minutesBetween(s.business_date, s.start),
        labels.id(s.experience),
        labels.id(s.hall),
        s.sold_out ? 1 : 0,
      ]);
    }
  }
  return Object.assign(out, { days: dates.rows, cinemas: cinemas.rows, movies: movies.rows, labels: labels.rows });
}

const hm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** Unpack the snapshot into { days, errors, cinemas, showtimes } with the same shapes as live data. */
export function decodeSnapshot(snap) {
  if (snap?.version !== SNAPSHOT_VERSION) throw new Error("unknown snapshot version");
  const cinemas = snap.cinemas.map((row) => {
    const c = Object.fromEntries(CINEMA_FIELDS.map((f, i) => [f, row[i]]));
    // Snapshots made before TGV names were converted say "TGV 1 Utama": convert on the way in.
    if (c.chain === "TGV") c.name = tgvCinemaName(c.cinema_id, c.name, c.state);
    return c;
  });
  const movies = snap.movies.map((row) => Object.fromEntries(MOVIE_FIELDS.map((f, i) => [f, row[i]])));
  const showtimes = snap.shows.map(([day, cinemaIndex, movieIndex, minute, experience, hall, soldOut]) => {
    const businessDate = snap.days[day];
    const cinema = cinemas[cinemaIndex];
    const movie = movies[movieIndex];
    return makeShowtime({
      ...movie,
      chain: cinema.chain,
      cinema_id: cinema.cinema_id,
      cinema_name: cinema.name,
      region: cinema.region,
      start: `${addDays(businessDate, Math.floor(minute / 1440))}T${hm(minute % 1440)}`,
      business_date: businessDate,
      experience: snap.labels[experience],
      hall: snap.labels[hall],
      sold_out: soldOut === 1,
      latitude: cinema.latitude,
      longitude: cinema.longitude,
    });
  });
  return { days: snap.days, errors: snap.errors || {}, cinemas, showtimes, generatedAt: snap.generated_at };
}

/** Fetch and unpack the snapshot, or null when it's missing, broken or too old. */
export async function loadSnapshot({ url = SNAPSHOT_URL, fetch: fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  try {
    const res = await fetchImpl(url, { cache: "no-cache" });
    if (!res.ok) return null;
    const snap = await res.json();
    if (now - Date.parse(snap.generated_at) > SNAPSHOT_MAX_AGE_MS) return null;
    return decodeSnapshot(snap);
  } catch {
    return null; // No snapshot (local dev, first deploy, broken file): fetch live instead.
  }
}
