#!/usr/bin/env node
// Build the shared snapshot: GSC and TGV movies across all published booking dates,
// in one compact file. Run by .github/workflows/pages.yml every 6 hours.
//
//   node scripts/snapshot.mjs --out _site/data/showtimes.json
//   node scripts/snapshot.mjs --out ... --reuse https://edwardywy.github.io/52frames/data/showtimes.json
//   node scripts/snapshot.mjs --out ... --reuse <url> --reuse-hours 5 --guard <url>
//
// --reuse copies the published snapshot instead of fetching (used when a push redeploys the site,
// so code changes don't add load on the chains); it fetches only if that copy is missing or older
// than --reuse-hours (13 by default).
// --guard compares the new snapshot with the published one and fails, publishing nothing, when a
// chain lists far fewer cinemas than before (--force 1 publishes anyway).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { mapLimit } from "../site/js/aggregator.js";
import { todayMyt } from "../site/js/models.js";
import { GSC, findGscSlug, gscMovieSlugs, parseGscSubtitles } from "../site/js/providers.js";
import { SNAPSHOT_MAX_AGE_MS, decodeSnapshot, encodeSnapshot, snapshotRegressions } from "../site/js/snapshot.js";
import { parseXml } from "./xml.mjs";
import { collectCatalogue } from "../site/js/catalog.js";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const out = args.out || "_site/data/showtimes.json";
const CONCURRENCY = 4; // gentler than the browser's 6; nobody is waiting on this

const USER_AGENT = "Mozilla/5.0 (compatible; 52frames-showtimes/1.0; +https://edwardywy.github.io/52frames/)";
const politeFetch = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, "user-agent": USER_AGENT } });

function write(json) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
  console.log(`wrote ${out} (${(json.length / 1024).toFixed(0)} KB)`);
}

const reuseMaxAge = args["reuse-hours"] ? Number(args["reuse-hours"]) * 3600 * 1000 : SNAPSHOT_MAX_AGE_MS;

/** The published snapshot as packed JSON, or null when it can't be read. */
async function published(url) {
  try {
    const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snap = await res.json();
    decodeSnapshot(snap);
    return snap;
  } catch (err) {
    console.log(`can't read ${url}: ${err.message}; publishing without comparing`);
    return null;
  }
}

async function reuse(url) {
  try {
    const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const snap = JSON.parse(text);
    decodeSnapshot(snap); // must be readable by this version of the site
    const age = Date.now() - Date.parse(snap.generated_at);
    if (age > reuseMaxAge) throw new Error(`too old (${Math.round(age / 3600000)} h)`);
    write(text);
    console.log(`reused published snapshot from ${snap.generated_at}`);
    return true;
  } catch (err) {
    console.log(`can't reuse ${url}: ${err.message}; fetching instead`);
    return false;
  }
}

/**
 * GSC subtitles and movie page links: GSC's showtime data has neither, so read its public movie
 * pages, once per movie per run. A movie GSC doesn't link, or a page that fails, keeps
 * subtitles = null ("not known") rather than failing the snapshot.
 */
async function addGscMovieInfo(days) {
  const shows = days.flatMap((d) => d.showtimes).filter((s) => s.chain === "GSC");
  const titles = [...new Set(shows.map((s) => s.movie_title))];
  if (!titles.length) return;
  let slugs = [];
  try {
    const res = await politeFetch(`${GSC.siteUrl}/`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    slugs = gscMovieSlugs(await res.text());
  } catch (err) {
    console.log(`GSC homepage: ${err.message}; no GSC subtitles this run`);
    return;
  }
  const slugOf = new Map(titles.map((t) => [t, findGscSlug(t, slugs)]));
  const info = new Map(); // slug -> subtitles
  const wanted = [...new Set([...slugOf.values()].filter(Boolean))];
  await mapLimit(wanted, 2, async (slug) => {
    try {
      const res = await politeFetch(`${GSC.siteUrl}/movie/${slug}/`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      info.set(slug, parseGscSubtitles(await res.text()));
    } catch (err) {
      console.log(`  ! GSC movie page ${slug}: ${err.message}`);
    }
  });
  for (const s of shows) {
    const slug = slugOf.get(s.movie_title);
    if (!slug) continue;
    s.info_url = `${GSC.siteUrl}/movie/${slug}/`;
    if (info.has(slug)) s.subtitles = info.get(slug);
  }
  const unmatched = titles.filter((t) => !slugOf.get(t));
  console.log(`GSC movie pages: ${wanted.length} read for ${titles.length} titles` + (unmatched.length ? `; no page for: ${unmatched.join(", ")}` : ""));
}

async function build() {
  const result = await collectCatalogue({ fetch: politeFetch, parseXml, concurrency: CONCURRENCY,
    onProgress: ({ done, total }) => { if (done % 50 === 0) console.log(`Catalogue: ${done}/${total}`); } });
  // A failed refresh must not publish an incomplete catalogue over the good one.
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  const dates = [...new Set([todayMyt(), ...result.showtimes.map(s => s.business_date)])].sort();
  const days = dates.map(date => ({ date, cinemas: result.cinemas, errors: [], showtimes: result.showtimes.filter(s => s.business_date === date) }));
  await addGscMovieInfo(days);
  const total = days.reduce((n, d) => n + d.showtimes.length, 0);
  // Every cinema failing (e.g. an API change) must not replace a good snapshot with an empty one.
  if (!total && days.every((d) => d.errors.length)) throw new Error("no showtimes at all, every day had errors");
  const snapshot = encodeSnapshot(days, new Date().toISOString());
  // A chain answering with a short cinema list (and no error) must not replace a good snapshot.
  const before = args.guard && args.force !== "1" && args.force !== "true" ? await published(args.guard) : null;
  const lost = before ? snapshotRegressions(before, snapshot) : [];
  if (lost.length) throw new Error(`not publishing, the new snapshot lost cinemas (run the workflow with "force" to publish anyway):\n${lost.join("\n")}`);
  write(JSON.stringify(snapshot));
}

if (!(args.reuse && (await reuse(args.reuse)))) await build();
