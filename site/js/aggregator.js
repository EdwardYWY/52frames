// Load cinemas from both chains, fetch showtimes with a concurrency limit, filter and group.
// Ports cinema_showtimes/aggregator.py, plus a sessionStorage cache for the browser.

export const CONCURRENCY = 6;
import { movieGroupKey, normalizeLanguage, untaggedTitle } from './models.js?v=27';
export const CACHE_TTL_MS = 10 * 60 * 1000;
// Bump when the cached shape of a showtime changes.
const CACHE_PREFIX = "showtimes:v3:";

const matches = (value, needle) => !needle || String(value).toLowerCase().includes(needle.toLowerCase());

const byStartChainCinema = (a, b) =>
  cmp(a.start, b.start) || cmp(a.chain, b.chain) || cmp(a.cinema_name, b.cinema_name);

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** "9:5" / "09:05" -> "09:05", so it compares correctly with "HH:MM" strings. */
function hhmm(value) {
  const [h, m = "0"] = String(value).split(":");
  const hours = Number(h);
  const minutes = Number(m || 0);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) throw new Error(`bad time ${value}`);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function filterShowtimes(showtimes, { chains, region, cinema, movie, after } = {}) {
  const wanted = chains?.length ? new Set(chains.map((c) => c.toUpperCase())) : null;
  const earliest = after ? hhmm(after) : null;
  return showtimes
    .filter(
      (s) =>
        (!wanted || wanted.has(s.chain)) &&
        matches(s.region, region) &&
        matches(s.cinema_name, cinema) &&
        (matches(s.movie_title, movie) || matches(s.movie_key, movie)) &&
        // Past-midnight shows belong to the previous business day, so keep them.
        (!earliest ||
          s.start.slice(0, 10) > s.business_date ||
          s.start.slice(11, 16) >= earliest),
    )
    .sort(byStartChainCinema);
}

/** Map of movie_key -> shows, keys in sorted order, shows by start time. */
export function groupByMovie(showtimes) {
  // Bucket first, then sort each (small) bucket: far cheaper than sorting every show by key.
  const buckets = new Map();
  for (const show of showtimes) {
    const key = movieGroupKey(show);
    const list = buckets.get(key);
    if (list) list.push(show);
    else buckets.set(key, [show]);
  }
  return new Map([...buckets.keys()].sort(cmp).map((key) => [key, buckets.get(key).sort((a, b) => cmp(a.start, b.start))]));
}

// Known poster widths: GSC thumb_big is 500x750, thumb_medium 232x350; TGV "poster" is 436x650.
// Used as srcset hints; the browser picks the smallest that is sharp enough, and when both chains
// have a poster the higher-resolution one is first.
const POSTER_WIDTHS = { GSC: [500, 232], TGV: [436, 0] };

/** Poster candidates for one movie, highest resolution first: [{url, width}]. */
export function posterCandidates(shows) {
  const seen = new Map();
  for (const s of shows) {
    const [big, small] = POSTER_WIDTHS[s.chain] || [300, 150];
    if (s.poster_url && !seen.has(s.poster_url)) seen.set(s.poster_url, big || 300);
    if (s.poster_small_url && !seen.has(s.poster_small_url)) seen.set(s.poster_small_url, small || 150);
  }
  return [...seen].map(([url, width]) => ({ url, width })).sort((a, b) => b.width - a.width);
}

/** One summary per movie: the data behind a poster card. */
export function summarizeMovies(showtimes) {
  const versions = new Map();
  for (const show of showtimes) {
    if (!versions.has(show.movie_key)) versions.set(show.movie_key, new Set());
    const language = normalizeLanguage(show.language);
    if (language) versions.get(show.movie_key).add(language);
  }
  return [...groupByMovie(showtimes)].map(([key, shows]) => {
    const withRuntime = shows.find((s) => s.duration_mins) || shows[0];
    const language = normalizeLanguage(shows.find((s) => s.language)?.language);
    let title = shows.map((s) => s.movie_title).sort((a, b) => a.length - b.length || cmp(a, b))[0];
    if (language && versions.get(shows[0].movie_key).size > 1) {
      const suffix = /\s*\(([^()]*)\)\s*$/.exec(title);
      if (suffix && normalizeLanguage(suffix[1]).toLowerCase() === language.toLowerCase()) title = title.slice(0, suffix.index).trim();
      title = `${title} (${language})`;
    }
    return {
      key,
      title,
      duration_mins: withRuntime.duration_mins,
      rating: shows.find((s) => s.rating)?.rating || "",
      language,
      chains: [...new Set(shows.map((s) => s.chain))].sort(),
      showCount: shows.length,
      cinemaCount: new Set(shows.map((s) => `${s.chain}|${s.cinema_name}`)).size,
      firstStart: shows[0].start,
      posters: posterCandidates(shows),
      // Per chain: subtitles (null = not known) and the chain's page about the movie.
      byChain: Object.fromEntries(
        [...new Set(shows.map((s) => s.chain))].sort().map((chain) => {
          const own = shows.filter((s) => s.chain === chain);
          const known = own.find((s) => Array.isArray(s.subtitles) && s.subtitles.length) || own.find((s) => Array.isArray(s.subtitles));
          return [chain, { subtitles: known ? known.subtitles : null, info_url: own.find((s) => s.info_url)?.info_url || "" }];
        }),
      ),
      shows,
    };
  });
}

// ---------------------------------------------------------------------------- cache

/**
 * A TTL cache: in memory for this tab, backed by Web Storage so a reload is quick too.
 * A region-day can be ~2 MB, so storage fills after a few days; then the oldest entries are
 * dropped. The memory layer never fills, so switching back to a date is always instant.
 * Every storage access may throw (private mode, quota), and is treated as a miss.
 */
export function createCache(storage, { ttlMs = CACHE_TTL_MS, now = () => Date.now() } = {}) {
  const store = storage ?? null;
  const memory = new Map();

  function get(key) {
    const hit = memory.get(key);
    if (hit && now() - hit.t < ttlMs) return hit.v;
    memory.delete(key);
    try {
      const raw = store?.getItem(CACHE_PREFIX + key);
      if (!raw) return undefined;
      const entry = JSON.parse(raw);
      if (now() - entry.t < ttlMs) {
        memory.set(key, entry);
        return entry.v;
      }
      store.removeItem(CACHE_PREFIX + key);
    } catch {
      // Unreadable or corrupt entry: treat as a miss.
    }
    return undefined;
  }

  function write(key, raw) {
    try {
      store?.setItem(CACHE_PREFIX + key, raw);
      return true;
    } catch {
      return false;
    }
  }

  function set(key, value) {
    const entry = { t: now(), v: value };
    memory.set(key, entry);
    const raw = JSON.stringify(entry);
    if (write(key, raw)) return;
    // Full: drop expired entries, then the oldest ones, until it fits (or nothing is left).
    prune();
    for (const old of entriesOldestFirst()) {
      if (write(key, raw)) return;
      try {
        store.removeItem(old);
      } catch {
        return;
      }
    }
    write(key, raw);
  }

  function entriesOldestFirst() {
    const found = [];
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (!key?.startsWith(CACHE_PREFIX)) continue;
        let t = 0;
        try {
          t = JSON.parse(store.getItem(key)).t;
        } catch {
          /* corrupt: oldest */
        }
        found.push([t, key]);
      }
    } catch {
      /* storage unavailable */
    }
    return found.sort((a, b) => a[0] - b[0]).map(([, key]) => key);
  }

  function prune() {
    try {
      for (let i = store.length - 1; i >= 0; i--) {
        const key = store.key(i);
        if (!key?.startsWith(CACHE_PREFIX)) continue;
        try {
          if (now() - JSON.parse(store.getItem(key)).t >= ttlMs) store.removeItem(key);
        } catch {
          store.removeItem(key);
        }
      }
    } catch {
      /* storage unavailable */
    }
  }

  return { get, set, prune };
}

const noCache = { get: () => undefined, set: () => {}, prune: () => {} };

// ---------------------------------------------------------------------------- collect

/** Run `worker` over `items` with at most `limit` in flight. */
export async function mapLimit(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

const errorText = (err) => (err && err.message) || String(err);

/**
 * Fetch every matching cinema's showtimes for `day` (YYYY-MM-DD).
 *
 * Calls back as data arrives:
 *   onCinemas(cinemas)                    once the cinema lists are in
 *   onShowtimes(shows, cinema)            per cinema that loaded
 *   onProgress({done, total})             after each cinema, loaded or failed
 *   onError(message)                      per chain or cinema that failed
 * Resolves to { showtimes, cinemas, errors } like the Python Result.
 */
export async function collectShowtimes(
  day,
  {
    providers,
    chains,
    region,
    cinema,
    cache = noCache,
    concurrency = CONCURRENCY,
    signal,
    onCinemas = () => {},
    onShowtimes = () => {},
    onProgress = () => {},
    onError = () => {},
  },
) {
  const result = { showtimes: [], cinemas: [], errors: [] };
  const fail = (message) => {
    result.errors.push(message);
    onError(message);
  };
  const wantedChains = chains?.length
    ? Object.keys(providers).filter((c) => chains.map((x) => x.toUpperCase()).includes(c))
    : Object.keys(providers);

  const lists = await Promise.all(
    wantedChains.map(async (chain) => {
      const key = `cinemas:${chain}`;
      try {
        let list = cache.get(key);
        if (!list) {
          list = await providers[chain].fetchCinemas(signal);
          cache.set(key, list);
        }
        return list;
      } catch (err) {
        if (signal?.aborted) throw err;
        fail(`${chain}: could not load cinemas (${errorText(err)})`);
        return [];
      }
    }),
  );
  result.cinemas = lists.flat().filter((c) => matches(c.region, region) && matches(c.name, cinema));
  onCinemas(result.cinemas);

  let done = 0;
  onProgress({ done, total: result.cinemas.length });
  await mapLimit(result.cinemas, concurrency, async (target) => {
    if (signal?.aborted) return;
    const key = `shows:${day}:${target.chain}:${target.cinema_id}:${target.hall_group || ""}`;
    try {
      let shows = cache.get(key);
      if (!shows) {
        shows = await providers[target.chain].fetchShowtimes(target, day, signal);
        cache.set(key, shows);
      }
      if (signal?.aborted) return;
      result.showtimes.push(...shows);
      onShowtimes(shows, target);
    } catch (err) {
      if (signal?.aborted) return;
      fail(`${target.chain} ${target.name}: ${errorText(err)}`);
    }
    done++;
    onProgress({ done, total: result.cinemas.length });
  });

  result.showtimes.sort(byStartChainCinema);
  return result;
}

/**
 * Drop repeats of the same session. TGV sometimes lists one session under two movie entries
 * (e.g. "Jailer 2 (Tamil)" and "(FANS) Jailer 2"); the tagged entry is kept, so a special
 * screening shows on its own card and not again on the regular one.
 */
export function uniqueShows(shows) {
  const titles = new Map(); // movie_title -> untagged title; a few hundred titles across ~20k shows
  const untagged = (title) => titles.get(title) ?? titles.set(title, untaggedTitle(title)).get(title);
  const keys = shows.map((s) => [s.chain, s.cinema_id, s.cinema_name, s.start, s.hall, s.experience, untagged(s.movie_title), normalizeLanguage(s.language)].join("|"));
  const best = new Map();
  shows.forEach((s, i) => {
    const kept = best.get(keys[i]);
    if (!kept || s.movie_key.length > kept.movie_key.length) best.set(keys[i], s);
  });
  return shows.filter((s, i) => best.get(keys[i]) === s);
}
