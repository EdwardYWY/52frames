// Page code: a poster grid of what's showing, a movie sheet with its schedule, and a panel to
// manage starred cinemas. Fetching and parsing live in providers.js; grouping and caching in
// aggregator.js.

import { collectShowtimes, createCache, filterShowtimes, summarizeMovies, uniqueShows } from "./aggregator.js?v=23";
import { REGIONS, movieGroupKey, distanceKm, normalizeLanguage, normalizeTitle, todayMyt } from "./models.js?v=23";
import { TGV_LOCATIONS, TGV_NAMES } from "./places.js?v=23";
import { createProviders, domParseXml } from "./providers.js?v=24";
import { enhanceSelect } from "./select.js?v=23";
import { collectCatalogue } from "./catalog.js?v=23";
import { browseMovies, isConcert, screeningLabel, overnightLabel } from "./browse.js?v=23";
import { loadSnapshot } from "./snapshot.js?v=23";
import { enableSeatPreview } from "./seatmap.js?v=26";
let track = () => {}; // Replaced only if the optional analytics module loads successfully.

const $ = (id) => document.getElementById(id);
const providers = createProviders();
const STARRED = "*starred"; // cinema <select> value for "starred cinemas only"

function storage(kind) {
  try {
    return window[kind];
  } catch {
    return null; // Storage blocked: run without it.
  }
}
const cache = createCache(storage("sessionStorage"));
cache.prune();

function readLocal(key, fallback) {
  try {
    const raw = storage("localStorage")?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key, value) {
  try {
    storage("localStorage")?.setItem(key, JSON.stringify(value));
  } catch {
    // Not remembered; that's fine.
  }
}

/** One day of data for one view: the main grid, or the movie view (each has its own date). */
const newView = (date) => ({ date, shows: [], cinemas: [], errors: [], progress: { done: 0, total: 0 }, loading: false, source: null, controller: null });

const state = {
  main: newView(todayMyt()),
  sheet: newView(todayMyt()),
  pendingSheetDate: null, // a search result opens the movie on the day it next shows
  movieKey: null, // open movie, or null for the grid
  openVenues: new Set(),
  lastSummary: new Map(), // movie key -> last summary, so the sheet keeps its header between dates
  // Starred cinemas: venue key "CHAIN|Name" -> {chain, name, region}. Kept in localStorage.
  starred: new Map(), // filled by readStars() below
  here: null, // {latitude, longitude} once the visitor shares their location
  locating: false,
  locationError: "",
  places: new Map(), // venue key -> {latitude, longitude}
  // "date|region" combos that loaded fine but had no shows: not published yet.
  emptyDates: new Set(),
};

// ---------------------------------------------------------------- helpers

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const pad2 = (n) => String(n).padStart(2, "0");
const hhmm = (start) => start.slice(11, 16);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const venueKey = (s) => `${s.chain}|${s.cinema_name}`;
const splitKey = (key) => [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
const isStarred = (key) => state.starred.has(key);

// The main page's shows and the snapshot hold every day (~20k shows) and are looked up by movie
// and by day on every render. Index each list once, the first time it's asked.
const indexes = new WeakMap();
function indexOf(shows) {
  let index = indexes.get(shows);
  if (!index || index.size !== shows.length) {
    index = { size: shows.length, byMovie: new Map(), byDay: new Map() };
    const add = (map, key, show) => (map.get(key) || map.set(key, []).get(key)).push(show);
    for (const show of shows) {
      add(index.byMovie, movieGroupKey(show), show);
      add(index.byDay, show.business_date, show);
    }
    indexes.set(shows, index);
  }
  return index;
}

/** The booking dates a movie has in `shows`, among those passing `keep`, in order. */
const movieDates = (shows, key, keep) => [...new Set((indexOf(shows).byMovie.get(key) || []).filter(keep).map((s) => s.business_date))].sort();

// TGV cinemas used to be named "TGV <mall>"; stars saved under those names move to the new ones.
const OLD_TGV_IDS = {
  "Tgv Ksl Klang (New)": "KSL",
  "TGV Pavilion Damansara Heights (New)": "PDH",
  "TGV Pavilion Kuala Lumpur (New)": "PKL",
  "TGV Sunway Square (New)": "SWS",
  "TGV Sunway Pyramid": "SW0",
  "TGV 1 Utama": "BU0",
  "TGV Alamanda": "ALM",
  "TGV 1 Shamelin": "1SM",
  "TGV Ampang Point": "AMP",
  "TGV Au2 Setiawangsa": "AU2",
  "TGV Bukit Raja": "BR0",
  "TGV Bukit Tinggi": "BBT",
  "TGV Central I-city": "ICT",
  "TGV Cheras Selatan": "CHR",
  "TGV Cheras Sentral": "CTR",
  "TGV Dpulze Cyberjaya": "CYB",
  "TGV Jaya Seksyen 14": "JAY",
  "TGV Kepong": "KP0",
  "TGV Mines": "MN0",
  "TGV Pavilion Bukit Jalil": "PBJ",
  "TGV Rawang": "RWK",
  "TGV Setiawalk Puchong": "STW",
  "TGV Strand Kota Damansara": "STR",
  "TGV Sunway Putra": "SWP",
  "TGV Sunway Velocity": "SWV",
  "TGV Suria Klcc": "KLC",
  "TGV Sunway Wangsa Mall": "WWM",
  "TGV Bukit Indah": "BI0",
  "TGV Kulaijaya": "KUL",
  "TGV Tasek Central": "TSC",
  "TGV Tebrau City": "TBR",
  "TGV Toppen": "TOP",
  "TGV Kinta City": "IP0",
  "TGV Sentra Mall Klebang": "KLE",
  "TGV Seri Manjung": "MAN",
  "TGV Station 18 Ipoh": "S18",
  "TGV Taiping": "TAI",
  "TGV 1St Avenue Penang": "1AV",
  "TGV Bukit Mertajam": "BKM",
  "TGV Gurney Paragon": "GUR",
  "TGV Boulevard Bintulu": "BIN",
  "TGV Miri": "IMP",
  "TGV Vivacity Kuching": "VIV",
  "TGV Seremban 2": "S20",
  "TGV Mesra Mall": "MSR",
};

function readStars() {
  const stars = new Map();
  for (const [key, info] of Object.entries(readLocal("showtimes:starred", {}))) {
    const [chain, name] = splitKey(key);
    const renamed = chain === "TGV" && TGV_NAMES[OLD_TGV_IDS[name]];
    if (renamed) stars.set(`TGV|${renamed}`, { ...info, name: renamed });
    else stars.set(key, info);
  }
  return stars;
}
state.starred = readStars();

function nowMyt() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return `${d.toISOString().slice(0, 10)}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function runtime(mins) {
  if (!mins) return "";
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${pad2(mins % 60)}m` : `${mins}m`;
}

// Formatting dates is slow (Intl), and the date strip asks for the same few dozen on every render.
const datePartsCache = new Map();
function dateParts(iso) {
  let parts = datePartsCache.get(iso);
  if (!parts) datePartsCache.set(iso, (parts = formatDateParts(iso)));
  return parts;
}

function formatDateParts(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const fmt = (opts) => d.toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
  return {
    weekday: fmt({ weekday: "short" }),
    day: d.getUTCDate(),
    month: fmt({ month: "short" }),
    long: fmt({ weekday: "long", day: "numeric", month: "long" }),
  };
}

function savePrefs() {
  writeLocal("showtimes:prefs", {
    area: $("region").value,
    chains: selectedChains(),
    group: selectedGroup(),
    location: Boolean(state.here),
    hideConcerts: $("hide-concerts").checked,
  });
}

const selectedChains = () => [...document.querySelectorAll("input[name=chain]:checked")].map((c) => c.value);
const selectedGroup = () => document.querySelector("input[name=group]:checked")?.value || "time";
const regionLabel = (select = $("region")) => select.selectedOptions[0].text;

// ---------------------------------------------------------------- distance

/** A cinema's location: the TGV table first (TGV's own links are patchy), then the chain's data. */
function placeOf(item) {
  const known = item.chain === "TGV" ? TGV_LOCATIONS[item.cinema_id] : null;
  if (known) return { latitude: known[0], longitude: known[1] };
  if (item.latitude != null && item.longitude != null) return { latitude: item.latitude, longitude: item.longitude };
  return null;
}

function rememberPlace(key, item) {
  if (state.places.has(key)) return;
  const place = placeOf(item);
  if (place) state.places.set(key, place);
}

const rememberPlaces = (shows) => shows.forEach((s) => rememberPlace(venueKey(s), s));
const rememberCinemaPlaces = (cinemas) => cinemas.forEach((c) => rememberPlace(`${c.chain}|${c.name}`, c));

/** km from the visitor to a venue, or null when either is unknown. */
const kmTo = (key) => (state.here ? distanceKm(state.here, state.places.get(key)) : null);

function kmLabel(km) {
  if (km == null) return "";
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

function locate() {
  if (!navigator.geolocation) {
    state.locationError = "This browser can't share a location.";
    renderTools();
    return;
  }
  state.locating = true;
  state.locationError = "";
  renderTools();
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.locating = false;
      state.here = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      if ($("m-sort").value === "time") $("m-sort").value = "near";
      savePrefs();
      render();
    },
    (err) => {
      state.locating = false;
      state.here = null;
      state.locationError =
        err.code === err.PERMISSION_DENIED ? "Location is blocked for this site in your browser settings." : "Couldn't get your location.";
      savePrefs();
      render();
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 },
  );
}

function toggleLocation() {
  track("location_toggle", { action: state.here ? "off" : "request" });
  if (state.here) {
    state.here = null;
    if ($("m-sort").value === "near") $("m-sort").value = "time";
    savePrefs();
    render();
  } else {
    locate();
  }
}

// ---------------------------------------------------------------- stars

function saveStars() {
  writeLocal("showtimes:starred", Object.fromEntries(state.starred));
}

function toggleStar(key, region = "") {
  track("cinema_star", { chain: splitKey(key)[0], action: state.starred.has(key) ? "remove" : "add" });
  if (state.starred.has(key)) state.starred.delete(key);
  else {
    const [chain, name] = splitKey(key);
    state.starred.set(key, { chain, name, region });
  }
  saveStars();
  render();
}

function starButton(key, region) {
  const on = isStarred(key);
  return el(
    "button",
    {
      type: "button",
      class: `star${on ? " on" : ""}`,
      "aria-pressed": String(on),
      "aria-label": on ? "Unstar this cinema" : "Star this cinema",
      title: on ? "Starred: listed first. Click to unstar." : "Star: always list this cinema first",
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleStar(key, region);
      },
    },
    on ? "★" : "☆",
  );
}

/** Every cinema of both chains (cached lists), for the starred-cinemas panel. */
async function allCinemas() {
  const lists = await Promise.all(
    Object.keys(providers).map(async (chain) => {
      const key = `cinemas:${chain}`; // same cache key as collectShowtimes
      try {
        let list = cache.get(key);
        if (!list) {
          list = await providers[chain].fetchCinemas();
          cache.set(key, list);
        }
        return list;
      } catch {
        return [];
      }
    }),
  );
  return lists.flat();
}

let starsCinemas = null;

async function openStars() {
  track("stars_open");
  $("stars").hidden = false;
  document.body.classList.add("locked");
  $("stars").querySelector(".close").focus({ preventScroll: true });
  if (!$("stars-region").options.length) {
    $("stars-region").replaceChildren(...REGIONS.map((r) => new Option(r, r)), new Option("All Malaysia", ""));
  }
  $("stars-region").value = $("region").value;
  renderStars();
  if (!starsCinemas) {
    starsCinemas = await allCinemas();
    rememberCinemaPlaces(starsCinemas);
    renderStars();
  }
}

function closeStars() {
  $("stars").hidden = true;
  document.body.classList.toggle("locked", Boolean(state.movieKey));
  $("open-stars").focus({ preventScroll: true });
}

function starRow(key, region, extra) {
  const [chain, name] = splitKey(key);
  const km = kmTo(key);
  return el(
    "div",
    { class: `star-row${isStarred(key) ? " on" : ""}` },
    starButton(key, region),
    el("span", { class: `chain ${chain}` }, chain),
    el("span", { class: "star-name" }, name),
    el("span", { class: "mono star-meta" }, [extra, kmLabel(km)].filter(Boolean).join(" · ")),
  );
}

function renderStars() {
  if ($("stars").hidden) return;
  const mine = [...state.starred].sort(([a], [b]) => a.localeCompare(b));
  $("stars-clear").hidden = !mine.length;
  $("stars-mine").replaceChildren(
    mine.length
      ? el("div", { class: "star-list" }, mine.map(([key, info]) => starRow(key, info.region, info.region)))
      : el("p", { class: "empty" }, "No starred cinemas yet. Tap ☆ next to a cinema below, or in any movie's schedule."),
  );

  if (!starsCinemas) {
    $("stars-all").replaceChildren(el("p", { class: "empty" }, "Loading cinemas…"));
    return;
  }
  const region = $("stars-region").value.toLowerCase();
  const chain = $("stars-chain").value;
  const list = starsCinemas
    .filter((c) => (!region || c.region.toLowerCase().includes(region)) && (!chain || c.chain === chain))
    .map((c) => ({ key: `${c.chain}|${c.name}`, region: c.region }))
    .sort((a, b) => {
      const da = kmTo(a.key);
      const db = kmTo(b.key);
      if (da != null && db != null && da !== db) return da - db;
      return a.key.localeCompare(b.key);
    });
  $("stars-all").replaceChildren(
    list.length
      ? el("div", { class: "star-list" }, list.map((c) => starRow(c.key, c.region, region ? "" : c.region)))
      : el("p", { class: "empty" }, "No cinemas here."),
  );
}

// ---------------------------------------------------------------- posters

function posterImage(candidates, sizes, alt) {
  if (!candidates.length) return null;
  const img = el("img", { alt, loading: "lazy", decoding: "async", referrerpolicy: "no-referrer", sizes });
  setPoster(img, candidates);
  return img;
}

/** Every chain's poster in srcset; the browser picks the sharpest it needs. */
function setPoster(img, candidates) {
  const sig = candidates.map((c) => c.url).join(" ");
  if (img.dataset.sig === sig) return;
  img.dataset.sig = sig;
  const remaining = [...candidates];
  img.onerror = () => {
    // A broken poster: drop srcset and walk down the list, then show the title instead.
    img.removeAttribute("srcset");
    remaining.shift();
    if (remaining.length) img.src = remaining[0].url;
    else img.closest(".poster")?.classList.add("no-img");
  };
  img.srcset = candidates.map((c) => `${c.url} ${c.width}w`).join(", ");
  img.src = candidates[0].url;
  img.closest(".poster")?.classList.remove("no-img");
}

function posterFrame(summary, sizes) {
  const frame = el("div", { class: "poster" }, el("span", { class: "poster-fallback", "aria-hidden": "true" }, summary.title));
  const img = posterImage(summary.posters, sizes, `${summary.title} poster`);
  if (img) frame.prepend(img);
  else frame.classList.add("no-img");
  return frame;
}


// ---------------------------------------------------------------- controls

/** The region a view shows: the main page's dropdown, or the movie view's own. */
const regionOf = (view) => (view === state.sheet ? $("m-region") : $("region")).value;
const emptyKey = (view) => `${view.date}|${regionOf(view)}`;
function renderDateStrip(strip, name, date) {
  const dates = movieDates(state.main.shows, state.movieKey, matchesCinema($("cinema")));
  if (!dates.includes(date)) dates.push(date);
  dates.sort();
  strip.replaceChildren(...dates.map(iso => {
    const p = dateParts(iso);
    return el("label", { class: "day", title: p.long },
      el("input", { type: "radio", name, value: iso, checked: iso === date }),
      el("span", {}, el("small", {}, iso === todayMyt() ? "Today" : p.weekday), el("b", {}, String(p.day)), el("small", { class: "day-month" }, p.month)));
  }));
}

function setDate(view, iso) {
  if (iso === view.date) return;
  view.date = iso;
  load(view);
}

function fillAfterOptions() {
  const select = $("m-after");
  const keep = select.value;
  const options = [["", "Any time"]];
  if (state.sheet.date === todayMyt()) options.push(["now", "From now"]);
  for (const t of ["12:00", "15:00", "18:00", "21:00"]) options.push([t, `From ${t}`]);
  select.replaceChildren(...options.map(([v, label]) => new Option(label, v)));
  select.value = options.some(([v]) => v === keep) ? keep : "";
}

/**
 * Cinema <select>: "All", "Starred only", then starred cinemas, then the rest by chain
 * (nearest first when the location is known). Keeps the current choice if it's still listed.
 */
function fillCinemaSelect(select, keys, allLabel) {
  const keep = new Set(chosenCinemas(select));
  const label = (key) => {
    const km = kmLabel(kmTo(key));
    return km ? `${splitKey(key)[1]} · ${km}` : splitKey(key)[1];
  };
  const order = (a, b) => {
    const da = kmTo(a);
    const db = kmTo(b);
    if (da != null && db != null && da !== db) return da - db;
    return splitKey(a)[1].localeCompare(splitKey(b)[1]);
  };
  const starred = keys.filter(isStarred).sort(order);
  const rest = keys.filter((k) => !isStarred(k));
  const chains = [...new Set(rest.map((k) => splitKey(k)[0]))].sort();
  const options = [
    new Option(allLabel, ""),
    starred.length ? new Option("★ Starred", STARRED) : null,
    starred.length ? el("optgroup", { label: "★ Starred" }, starred.map((k) => new Option(`★ ${label(k)}`, k))) : null,
    ...chains.map((chain) =>
      el(
        "optgroup",
        { label: state.here ? `${chain} · nearest first` : chain },
        rest
          .filter((k) => splitKey(k)[0] === chain)
          .sort(order)
          .map((k) => new Option(label(k), k)),
      ),
    ),
  ].filter(Boolean);
  const sig = `${allLabel}::${options.map((o) => o.label || o.text).join("|")}::${starred.join(",")}::${rest.length}`;
  if (select.dataset.sig !== sig) {
    select.dataset.sig = sig;
    select.replaceChildren(...options);
  }
  // Keep whatever is still listed; nothing left means all cinemas.
  const valid = new Set([...keep].filter((v) => (v === STARRED ? starred.length : keys.includes(v))));
  setChosenCinemas(select, [...valid]);
}

/** The cinema filter's choices: [] means all cinemas; may hold STARRED and cinema keys. */
const chosenCinemas = (select) => [...select.selectedOptions].map((o) => o.value).filter(Boolean);

function setChosenCinemas(select, values) {
  for (const option of select.options) option.selected = values.length ? values.includes(option.value) : option.value === "";
  select.dataset.prev = JSON.stringify(chosenCinemas(select));
}

/** After a click in the checklist: "All" clears the rest; picking any cinema unticks "All". */
function tidyCinemaChoice(select) {
  const before = new Set(JSON.parse(select.dataset.prev || "[]"));
  const allTicked = select.options[0]?.selected;
  const now = chosenCinemas(select);
  const added = now.filter((v) => !before.has(v));
  setChosenCinemas(select, allTicked && !added.length && before.size ? [] : now);
}

function cinemaSummary(select) {
  const chosen = chosenCinemas(select);
  const all = select.options[0]?.text || "All cinemas";
  if (!chosen.length) return all;
  const names = chosen.map((v) => (v === STARRED ? "★ Starred" : splitKey(v)[1]));
  return names.length === 1 ? names[0] : chosen.includes(STARRED) ? `★ Starred + ${names.length - 1}` : `${names.length} cinemas`;
}

function matchesCinema(select) {
  const chosen = chosenCinemas(select);
  if (!chosen.length) return () => true;
  const keys = new Set(chosen);
  const starred = keys.has(STARRED);
  return (s) => keys.has(venueKey(s)) || (starred && isStarred(venueKey(s)));
}

const onlyStarred = (select) => {
  const chosen = chosenCinemas(select);
  return chosen.length === 1 && chosen[0] === STARRED;
};

function tickClock() {
  $("clock").textContent = `MYT ${nowMyt().slice(11)}`;
}

function renderTools() {
  const button = $("locate");
  button.setAttribute("aria-pressed", String(Boolean(state.here)));
  button.classList.toggle("on", Boolean(state.here));
  button.disabled = state.locating;
  $("locate-text").textContent = state.locating ? "Locating…" : state.here ? "Location on" : "Location";
  button.title = state.locationError || (state.here ? "Distances shown. Click to turn off." : "Show distance from where you are");
  button.classList.toggle("err", Boolean(state.locationError));
  $("star-count").textContent = state.starred.size ? String(state.starred.size) : "";
  const near = $("m-sort").querySelector("option[value=near]");
  near.disabled = !state.here;
  near.textContent = state.here ? "Nearest" : "Nearest (turn on location)";
}

// ---------------------------------------------------------------- loading

async function load(view = state.main) {
  view.controller?.abort();
  const controller = new AbortController();
  const current = () => view.controller === controller;
  const date = view.date;
  Object.assign(view, { controller, shows: [], cinemas: [], errors: [], progress: { done: 0, total: 0 }, loading: true, source: null });
  savePrefs();
  if (view === state.sheet) fillAfterOptions();

  const chains = selectedChains();
  const region = regionOf(view);
  if (!chains.length) {
    // Not an error: the grid and the movie view say to pick a chain.
    view.loading = false;
    render();
    return;
  }
  render();

  // The shared snapshot (one file, refreshed every 6 h) covers most visits with no calls to the
  // chains at all; fetch live only for a day it doesn't have, or when it's missing or stale.
  const snap = await snapshotOnce();
  if (!current()) return;
  if (snap && view === state.sheet) {
    const atCinema = matchesCinema($("m-cinema"));
    const dates = movieDates(snap.showtimes, state.movieKey, (s) => inScope(s.chain, s.region, chains, region) && atCinema(s));
    if (dates.length && !dates.includes(view.date)) view.date = dates[0];
  }
  if (snap && (view === state.main || snap.days.includes(view.date))) {
    view.cinemas = snap.cinemas.filter((c) => inScope(c.chain, c.region, chains, region));
    const pool = view === state.main ? snap.showtimes : indexOf(snap.showtimes).byDay.get(view.date) || [];
    view.shows = pool.filter((s) => inScope(s.chain, s.region, chains, region));
    view.errors = (snap.errors[date] || []).filter((e) =>
      /could not load cinemas/.test(e) ? chains.some((c) => e.startsWith(c)) : view.cinemas.some((c) => e.startsWith(`${c.chain} ${c.name}:`)),
    );
    rememberCinemaPlaces(view.cinemas);
    rememberPlaces(view.shows);
    view.progress = { done: view.cinemas.length, total: view.cinemas.length };
    view.source = snap.generatedAt;
    finishLoad(view);
    return;
  }

  try {
    if (view === state.main) {
      const result = await collectCatalogue({ parseXml: domParseXml, chains, region, signal: controller.signal,
        onProgress: progress => { if (current()) { view.progress = progress; scheduleRender(); } } });
      if (!current()) return;
      view.shows = result.showtimes;
      view.cinemas = result.cinemas;
      view.errors = result.errors;
      rememberCinemaPlaces(view.cinemas);
      rememberPlaces(view.shows);
      finishLoad(view);
      if (state.movieKey) load(state.sheet);
      return;
    }
    // The main page already has this day when its region covers the movie view's.
    const covered = !regionOf(state.main) || regionOf(state.main) === region;
    const available = covered ? (indexOf(state.main.shows).byDay.get(date) || []).filter((s) => inScope(s.chain, s.region, chains, region)) : [];
    if (available.length && !state.main.loading) {
      view.shows = available;
      view.cinemas = state.main.cinemas.filter((c) => inScope(c.chain, c.region, chains, region));
      finishLoad(view);
      return;
    }
    await collectShowtimes(date, {
      providers,
      chains,
      region,
      cache,
      signal: controller.signal,
      onCinemas: (cinemas) => {
        if (!current()) return;
        view.cinemas = cinemas;
        rememberCinemaPlaces(cinemas);
      },
      onShowtimes: (shows) => {
        if (!current()) return;
        view.shows.push(...shows);
        rememberPlaces(shows);
        scheduleRender();
      },
      onProgress: (progress) => {
        if (!current()) return;
        view.progress = progress;
        scheduleRender();
      },
      onError: (message) => {
        if (!current()) return;
        view.errors.push(message);
        scheduleRender();
      },
    });
  } catch (err) {
    if (!current() || controller.signal.aborted) return;
    view.errors.push(`Could not load showtimes: ${err.message || err}`);
  }
  if (!current()) return;
  finishLoad(view);
}

/** In the chosen region and chains. */
function inScope(chain, region, chains = selectedChains(), wanted = $("region").value) {
  wanted = wanted.toLowerCase();
  return chains.includes(chain) && (!wanted || String(region).toLowerCase().includes(wanted));
}

function finishLoad(view) {
  view.loading = false;
  view.shows = uniqueShows(view.shows);
  // Every cinema answered (or most did) and none has a show: that day isn't published yet.
  const answered = view.progress.done - view.errors.filter((e) => !e.includes("could not load cinemas")).length;
  if (!view.shows.length && answered > 0) state.emptyDates.add(emptyKey(view));
  else if (view.shows.length) state.emptyDates.delete(emptyKey(view));
  render();
}

let snapshotPromise = null;
const snapshotOnce = () => (snapshotPromise ??= loadSnapshot());

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

// ---------------------------------------------------------------- grid

function progressLabel(view) {
  if (view.source && !view.loading) {
    const d = new Date(Date.parse(view.source) + 8 * 3600 * 1000);
    const when = `${d.getUTCDate()} ${d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
    return `${view.cinemas.length} cinemas · updated ${when} MYT`;
  }
  const { done, total } = view.progress;
  if (!total) return view.loading ? "Finding cinemas…" : "";
  return view.loading ? `Loaded ${done}/${total} cinemas` : `Loaded ${done}/${total} cinemas · done`;
}

function renderStatus() {
  const view = state.main;
  const { done, total } = view.progress;
  const box = $("progress");
  box.hidden = !view.loading && total === 0;
  box.classList.toggle("done", !view.loading);
  $("bar").style.width = total ? `${(done / total) * 100}%` : view.loading ? "4%" : "0";
  $("progress-text").textContent = progressLabel(view);

  const errors = state.locationError ? [...view.errors, state.locationError] : view.errors;
  if (!errors.length) {
    $("warnings").replaceChildren();
    return;
  }
  const list = el("ul", {}, errors.map((e) => el("li", {}, e)));
  $("warnings").replaceChildren(
    errors.length <= 2
      ? el("div", { class: "warn" }, el("strong", {}, view.errors.length ? "Some cinemas didn't answer, so a few times may be missing." : ""), list)
      : el("details", { class: "warn" }, el("summary", {}, `${plural(errors.length, "cinema")} didn't answer, so a few times may be missing.`), list),
  );
}

const cards = new Map(); // movie key -> card element, reused so posters don't reload
const GRID_SIZES = "(max-width: 560px) 46vw, (max-width: 1100px) 24vw, 220px";

function movieCard(summary) {
  let card = cards.get(summary.key);
  if (!card) {
    card = el(
      "a",
      { class: "card", href: `#/movie/${encodeURIComponent(summary.key)}` },
      posterFrame(summary, GRID_SIZES),
      el("div", { class: "card-body" }, el("h3"), el("div", { class: "card-shows mono" }), el("div", { class: "card-status mono" }), el("div", { class: "card-meta mono" })),
    );
    cards.set(summary.key, card);
  }
  const img = card.querySelector("img");
  if (img) img.alt = `${summary.title} poster`;
  if (img) setPoster(img, summary.posters);
  else if (summary.posters.length) {
    const frame = card.querySelector(".poster");
    frame.classList.remove("no-img");
    frame.prepend(posterImage(summary.posters, GRID_SIZES, `${summary.title} poster`));
  }
  card.classList.remove("later");
  card.dataset.next = summary.nextDate;
  card.querySelector(".card-status").textContent = screeningLabel(summary.nextDate, todayMyt());
  card.querySelector(".card-shows").textContent = `${plural(summary.showCount, "show")} scheduled`;
  card.querySelector("h3").textContent = summary.title;
  card.querySelector(".card-meta").textContent = [runtime(summary.duration_mins), summary.rating, summary.language]
    .filter(Boolean)
    .join(" · ");
  return card;
}

/** Search text, normalised like titles are (tags, case and punctuation don't matter). */
const searchText = () => $("q").value.trim();

function matchesSearch(show, query) {
  if (!query) return true;
  const raw = query.toLowerCase();
  const key = normalizeTitle(query);
  if (show.movie_title.toLowerCase().includes(raw) || (key && show.movie_key.includes(key))) return true;
  // The language as either chain writes it: "CAN" or "Cantonese" finds both chains' Cantonese shows.
  const language = normalizeLanguage(show.language).toLowerCase();
  // Matches from the start of a word, so "IND" finds Bahasa Indonesia but not Hindi.
  if (raw.length < 2 || !language) return false;
  return normalizeLanguage(raw).toLowerCase() === language || language.startsWith(raw) || language.split(/[\s/]+/).some((w) => w.startsWith(raw));
}

// What the grid was last drawn from: render() runs on every change, including ones in the movie
// view, and rebuilding ~150 cards from ~20k shows each time made the movie view lag.
let gridDrawn = { shows: null, sig: "" };
let titlesOf = { shows: null, titles: new Map() };

function renderGrid() {
  const view = state.main;
  const sig = JSON.stringify([
    view.shows.length, view.cinemas.length, view.loading, chosenCinemas($("cinema")), searchText(), $("hide-concerts").checked,
    $("sort").value, todayMyt(), [...state.starred.keys()], state.here, state.places.size,
  ]);
  if (gridDrawn.shows === view.shows && gridDrawn.sig === sig) return;
  gridDrawn = { shows: view.shows, sig };
  const keys = view.cinemas.length ? view.cinemas.map(c => `${c.chain}|${c.name}`) : [...new Set(view.shows.map(venueKey))];
  fillCinemaSelect($("cinema"), keys, "All cinemas");
  const atCinema = matchesCinema($("cinema"));
  const query = searchText();
  const hideConcerts = $("hide-concerts").checked;
  const visible = view.shows.filter(s => atCinema(s) && matchesSearch(s, query) && (!hideConcerts || !isConcert(s)));
  const movies = browseMovies(visible, { today: todayMyt(), sort: $("sort").value });
  // Titles come from every show (not just the visible ones), so they only change with the data.
  if (titlesOf.shows !== view.shows) titlesOf = { shows: view.shows, titles: new Map(summarizeMovies(view.shows).map(m => [m.key, m.title])) };
  const { titles } = titlesOf;
  for (const movie of movies) movie.title = titles.get(movie.key) || movie.title;
  for (const m of movies) state.lastSummary.set(m.key, m);
  $("count").textContent = `${plural(movies.length, "movie")} · ${plural(new Set(visible.map(venueKey)).size, "cinema")}`;
  $("grid").replaceChildren(...(movies.length ? movies.map(m => movieCard(m)) : [el("p", { class: "empty" }, !selectedChains().length ? "Pick GSC, TGV or both to see what's showing." : view.loading ? "Loading movies and advance sales…" : "No movies match these filters.")]));
}

/** Text for a day with nothing loaded: unpublished schedule, or a real failure. */
function notPublishedText(view) {
  const p = dateParts(view.date);
  if (state.emptyDates.has(emptyKey(view))) {
    return `${p.weekday} ${p.day} ${p.month}: no schedule yet. Malaysian cinemas publish the next week's showtimes on Wednesdays, so later days fill in then.`;
  }
  return view.errors.length ? "Couldn't load showtimes. See the warning above." : "No showtimes found for this day and region.";
}

// ---------------------------------------------------------------- movie sheet

// Showtimes in the schedule -> their show, for the hold-to-see-seats preview (seatmap.js).
const seatShows = new WeakMap();
function allowSeatPreview(node, show) {
  if (!providers[show.chain]?.fetchSeatPlan || !show.cinema_id) return;
  seatShows.set(node, show);
  node.classList.add("seat-hold");
}

/** A show's live seats or prices. GSC's premium halls need the cinema's hall group. */
function fetchSeatData(show, signal, method) {
  const cinema = [...state.sheet.cinemas, ...state.main.cinemas].find((c) => c.chain === show.chain && c.name === show.cinema_name);
  return providers[show.chain][method]({ ...show, hall_group: cinema?.hall_group || "" }, signal);
}
let seatPreview = null;

function timeChip(show, now) {
  const overnight = show.start.slice(0, 10) > show.business_date;
  const past = show.start < now;
  const label = `${hhmm(show.start)} ${show.experience} · ${show.cinema_name} · ${show.hall}${overnight ? " · after midnight" : ""}${
    show.sold_out ? " · sold out" : ""
  }${past ? " · started" : ""}`;
  const chip = el(
    show.booking_url ? "a" : "span",
    { class: `time${show.sold_out ? " full" : ""}${past ? " past" : ""}`, title: label, "aria-label": label },
    el("b", {}, hhmm(show.start)),
    overnight ? el("span", { class: "overnight", title: "After midnight, on the following calendar day" }, "+1") : null,
    show.experience ? el("i", {}, show.experience) : null,
  );
  if (show.booking_url) Object.assign(chip, { href: show.booking_url, target: "_blank", rel: "noopener" });
  allowSeatPreview(chip, show);
  return chip;
}

function venueBlock(key, shows, now, forceOpen) {
  const [chain, name] = splitKey(key);
  const ahead = shows.filter((s) => s.start >= now);
  const previewFrom = ahead.length ? ahead : shows;
  const preview = previewFrom.slice(0, 4).map((s) => overnightLabel(s)).join("  ");
  const upcoming = shows.find((s) => s.start >= now && !s.sold_out);
  const km = kmLabel(kmTo(key));
  return el(
    "details",
    {
      class: `venue${isStarred(key) ? " starred" : ""}`,
      open: forceOpen || state.openVenues.has(key),
      ontoggle: (e) => {
        if (e.currentTarget.open) state.openVenues.add(key);
        else state.openVenues.delete(key);
      },
    },
    el(
      "summary",
      {},
      starButton(key, shows[0].region),
      el(
        "span",
        { class: "venue-id" },
        el("span", { class: `chain ${chain}` }, chain),
        el("span", { class: "venue-name" }, name),
        km ? el("span", { class: "venue-km mono" }, km) : null,
      ),
      el(
        "span",
        { class: "venue-sum mono" },
        el("span", { class: "venue-preview" }, preview + (previewFrom.length > 4 ? "  …" : "")),
        el("span", {}, upcoming ? `${plural(shows.length, "show")} · next ${overnightLabel(upcoming)}` : plural(shows.length, "show")),
      ),
      el("span", { class: "chev", "aria-hidden": "true" }),
    ),
    el("div", { class: "times" }, shows.map((s) => timeChip(s, now))),
  );
}

function timeRow(show, now) {
  const overnight = show.start.slice(0, 10) > show.business_date;
  const past = show.start < now;
  const key = venueKey(show);
  const km = kmLabel(kmTo(key));
  const row = el(
    show.booking_url ? "a" : "div",
    { class: `trow${show.sold_out ? " full" : ""}${past ? " past" : ""}${isStarred(key) ? " starred" : ""}` },
    el("span", { class: "trow-time" }, hhmm(show.start), overnight ? el("span", { class: "overnight", title: "After midnight, on the following calendar day" }, "+1") : null),
    el(
      "span",
      { class: "trow-where" },
      isStarred(key) ? el("span", { class: "card-star", title: "Starred cinema" }, "★") : null,
      el("span", { class: `chain ${show.chain}` }, show.chain),
      el("span", {}, show.cinema_name),
    ),
    el("span", { class: "trow-what mono" }, [show.experience, show.hall, km].filter(Boolean).join(" · ")),
    el("span", { class: "trow-go mono" }, show.sold_out ? "Sold out" : past ? "Started" : show.booking_url ? "Book ↗" : ""),
  );
  if (show.booking_url) Object.assign(row, { href: show.booking_url, target: "_blank", rel: "noopener" });
  allowSeatPreview(row, show);
  return row;
}

let sheetKey = null;
let trackedMovieKey = null;
// Large enough that the browser takes the highest-resolution poster for the movie view.
const HERO_SIZES = "500px";

function renderSheet() {
  const key = state.movieKey;
  const view = state.sheet;
  const all = view.shows.filter((s) => movieGroupKey(s) === key);
  const summary = summarizeMovies(all)[0] || state.lastSummary.get(key);
  if (summary && trackedMovieKey !== key) {
    track("movie_open", { movie: key });
    trackedMovieKey = key;
  }
  if (summary && state.lastSummary.has(key)) summary.title = state.lastSummary.get(key).title;

  if (sheetKey !== key) {
    sheetKey = key;
    state.openVenues.clear();
    $("m-sort").value = state.here ? "near" : "time";
    $("m-poster").replaceChildren(summary ? posterFrame(summary, HERO_SIZES) : el("div", { class: "poster no-img" }));
    // Start from the main page's cinema choice.
    $("m-cinema").dataset.sig = "";
    $("m-cinema").replaceChildren(...[...$("cinema").selectedOptions].map((o) => new Option(o.text, o.value, true, true)));
  } else if (summary) {
    const img = $("m-poster").querySelector("img");
    if (img) setPoster(img, summary.posters);
    else if (summary.posters.length) $("m-poster").replaceChildren(posterFrame(summary, HERO_SIZES));
  }

  $("m-title").textContent = summary?.title || (view.loading ? "Loading…" : "Movie not found");
  document.title = summary ? `${summary.title} · 52 Frames` : "52 Frames";
  const subtitleRow = ([chain, info]) => {
    const text = info.subtitles == null ? "Not listed" : info.subtitles.length ? info.subtitles.join(", ") : "None listed";
    const value = info.info_url
      ? el("a", { href: info.info_url, target: "_blank", rel: "noopener", title: `${chain}'s page for this movie` }, text, el("span", { class: "ext", "aria-hidden": "true" }, " ↗"))
      : text;
    return [`Subtitles (${chain})`, value, info.subtitles?.length ? "" : "muted"];
  };
  const facts = summary
    ? [
        ["Runtime", runtime(summary.duration_mins)],
        ["Rating", summary.rating],
        ["Language", summary.language],
        ["Genres", [...new Set(all.flatMap(s => s.genres || []))].join(", ")],
        ...Object.entries(summary.byChain || {}).map(subtitleRow),
      ].filter(([, v]) => v)
    : [];
  $("m-facts").replaceChildren(...facts.flatMap(([k, v, cls]) => [el("dt", {}, k), el("dd", { class: cls || null }, v)]));
  renderDateStrip($("m-dates"), "m-date", view.date);

  const keys = [...new Set(all.map(venueKey))];
  fillCinemaSelect($("m-cinema"), keys, `All cinemas (${keys.length})`);

  const now = nowMyt();
  let after = $("m-after").value;
  if (after === "now") after = now.slice(11);
  const shows = filterShowtimes(all, { after: after || undefined }).filter(matchesCinema($("m-cinema")));

  const group = selectedGroup();
  $("m-sort-field").hidden = group !== "cinema";
  $("m-count").textContent = all.length
    ? `${plural(shows.length, "show")} · ${plural(new Set(shows.map(venueKey)).size, "cinema")}`
    : "";
  $("m-status").textContent = view.loading ? progressLabel(view) : "";
  $("m-status").classList.toggle("on", view.loading);

  if (!shows.length) {
    const p = dateParts(view.date);
    const text = !selectedChains().length
      ? "Pick GSC, TGV or both to see what's showing."
      : view.loading
      ? "Loading showtimes…"
      : all.length
        ? onlyStarred($("m-cinema"))
          ? "Not showing at your starred cinemas on this day."
          : "No shows match these filters."
        : state.emptyDates.has(emptyKey(view))
          ? notPublishedText(view)
          : `Not showing on ${p.weekday} ${p.day} ${p.month} in ${regionLabel($("m-region"))}. Try another date.`;
    $("m-schedule").replaceChildren(el("p", { class: "empty" }, text));
    return;
  }

  if (group === "time") {
    $("m-schedule").replaceChildren(el("div", { class: "trows" }, shows.map((s) => timeRow(s, now))));
    return;
  }

  const byVenue = new Map();
  for (const s of shows) {
    if (!byVenue.has(venueKey(s))) byVenue.set(venueKey(s), []);
    byVenue.get(venueKey(s)).push(s);
  }
  const sort = $("m-sort").value;
  const nextStart = (list) => (list.find((s) => s.start >= now) || list[0]).start;
  const far = (k) => kmTo(k) ?? Infinity;
  const entries = [...byVenue].sort(
    ([ka, a], [kb, b]) =>
      // Starred cinemas always come first.
      Number(isStarred(kb)) - Number(isStarred(ka)) ||
      (sort === "name"
        ? splitKey(ka)[1].localeCompare(splitKey(kb)[1])
        : sort === "shows"
          ? b.length - a.length
          : sort === "near"
            ? far(ka) - far(kb)
            : cmp(nextStart(a), nextStart(b))) ||
      ka.localeCompare(kb),
  );
  const forceOpen = entries.length === 1;
  $("m-schedule").replaceChildren(...entries.map(([k, list]) => venueBlock(k, list, now, forceOpen)));
}

// ---------------------------------------------------------------- routing

let returnFocus = null;
let cameFromGrid = false;

function route() {
  const match = /^#\/movie\/(.+)$/.exec(location.hash);
  const key = match ? decodeURIComponent(match[1]) : null;
  const opening = key && !state.movieKey;
  state.movieKey = key;
  $("sheet").hidden = !key;
  document.body.classList.toggle("locked", Boolean(key) || !$("stars").hidden);
  if (opening) {
    $("m-region").value = $("region").value;
    $("to-top").hidden = true;
    state.sheet.date = state.pendingSheetDate || movieDates(state.main.shows, key, matchesCinema($("cinema")))[0] || todayMyt();
    state.pendingSheetDate = null;
    load(state.sheet);
    returnFocus = document.activeElement;
    $("sheet").querySelector(".sheet-panel").scrollTop = 0;
    requestAnimationFrame(() => $("sheet").querySelector(".close").focus({ preventScroll: true }));
  }
  if (!key) {
    seatPreview?.close();
    sheetKey = null;
    trackedMovieKey = null;
    document.title = "52 Frames";
    returnFocus?.focus?.({ preventScroll: true });
    returnFocus = null;
  }
  render();
}

function closeSheet() {
  if (cameFromGrid) history.back();
  else location.hash = "#/";
  cameFromGrid = false;
}

const dropdowns = [];

/** What the folded filter button says on phones: only what differs from the defaults. */
function renderFilterSummary() {
  $("clear-search").hidden = !searchText();
  const parts = [regionLabel()];
  if (chosenCinemas($("cinema")).length) parts.push(cinemaSummary($("cinema")));
  if ($("sort").value !== "shows") parts.push($("sort").selectedOptions[0].text);
  const chains = selectedChains();
  if (chains.length !== 2) parts.push(chains.length ? `${chains[0]} only` : "No chain");
  parts.push($("hide-concerts").checked ? "Concerts hidden" : "Concerts included");
  if (searchText()) parts.push(`“${searchText()}”`);
  $("filters-summary").textContent = parts.join(" · ");
}

function toggleFilters(open = !$("filters").classList.contains("open")) {
  $("filters").classList.toggle("open", open);
  $("filters-toggle").setAttribute("aria-expanded", String(open));
}

function render() {
  renderTools();
  renderFilterSummary();
  renderStatus();
  renderGrid();
  if (state.movieKey) renderSheet();
  renderStars();
  for (const d of dropdowns) d.sync();
}

// ---------------------------------------------------------------- wiring

async function init() {
  import("./analytics.js?v=26").then((analytics) => {
    analytics.initAnalytics();
    track = analytics.track;
  }).catch(() => {}); // A blocked/missing analytics module must not prevent the app from starting.
  const saved = readLocal("showtimes:prefs", {});
  // All Malaysia by default. ("area", not the old "region": that one saved the old Klang Valley default.)
  if (typeof saved.area === "string" && [...$("region").options].some((o) => o.value === saved.area)) {
    $("region").value = saved.area;
  }
  $("m-region").replaceChildren(...[...$("region").options].map((o) => new Option(o.text, o.value)));
  if (Array.isArray(saved.chains) && saved.chains.length) {
    for (const box of document.querySelectorAll("input[name=chain]")) box.checked = saved.chains.includes(box.value);
  }
  // "By time" by default; once someone picks a grouping, keep it.
  if (saved.group === "cinema") document.querySelector("input[name=group][value=cinema]").checked = true;
  $("hide-concerts").checked = saved.hideConcerts !== false;
  fillAfterOptions();
  for (const id of ["region", "sort", "cinema", "m-region", "m-cinema", "m-after", "m-sort", "stars-region", "stars-chain"]) {
    dropdowns.push(enhanceSelect($(id), id.endsWith("cinema") ? { summary: cinemaSummary } : {}));
  }
  tickClock();
  setInterval(tickClock, 15000);
  // Back to top on the movie list too, once it has scrolled a screen or so.
  window.addEventListener("scroll", () => { $("page-top").hidden = window.scrollY < 600; }, { passive: true });
  $("page-top").addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });

  $("toolbar").addEventListener("submit", (e) => e.preventDefault());
  const reloadAll = () => {
    load(state.main);
    if (state.movieKey) load(state.sheet);
  };
  $("region").addEventListener("change", reloadAll);
  for (const box of document.querySelectorAll("input[name=chain]")) box.addEventListener("change", reloadAll);
  // The two date strips are independent: the movie view's date doesn't move the main page's.

  $("m-dates").addEventListener("change", (e) => setDate(state.sheet, e.target.value));
  $("m-region").addEventListener("change", () => load(state.sheet));
  // Back to top: shown once the schedule has scrolled a screen or so.
  const panel = $("sheet").querySelector(".sheet-panel");
  panel.addEventListener("scroll", () => { $("to-top").hidden = panel.scrollTop < 600; }, { passive: true });
  $("to-top").addEventListener("click", () => {
    panel.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    $("sheet").querySelector(".close").focus({ preventScroll: true });
  });
  for (const id of ["cinema", "m-cinema"]) $(id).addEventListener("change", (e) => tidyCinemaChoice(e.target));
  for (const id of ["cinema", "sort"]) $(id).addEventListener("change", render);
  $("hide-concerts").addEventListener("change", () => { savePrefs(); render(); });
  $("q").addEventListener("input", render);
  // Debounce analytics only; search still renders immediately. Never send the search text.
  let searchTimer;
  $("q").addEventListener("input", () => {
    clearTimeout(searchTimer);
    if (searchText()) searchTimer = setTimeout(() => track("search_used"), 800);
  });
  for (const id of ["region", "cinema", "sort", "hide-concerts", "m-region", "m-cinema", "m-after", "m-sort"]) {
    $(id).addEventListener("change", () => track("filter_change", {
      control: id,
      value: id.endsWith("cinema") ? (onlyStarred($(id)) ? "starred" : "selection") : id === "hide-concerts" ? String($(id).checked) : $(id).value,
    }));
  }
  for (const input of document.querySelectorAll("input[name=chain], input[name=group]")) {
    input.addEventListener("change", () => track("filter_change", { control: input.name, value: input.name === "chain" ? selectedChains().join(",") : selectedGroup() }));
  }
  $("m-dates").addEventListener("change", () => track("filter_change", { control: "date" }));
  $("clear-search").addEventListener("click", () => {
    $("q").value = "";
    render();
    $("q").focus();
  });
  $("filters-toggle").addEventListener("click", () => toggleFilters());
  $("q").addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("q").value) {
      e.stopPropagation();
      $("q").value = "";
      render();
    }
  });

  $("grid").addEventListener("click", (e) => {
    const card = e.target.closest("a.card");
    if (!card || e.metaKey || e.ctrlKey || e.shiftKey) return;
    cameFromGrid = true;
    state.pendingSheetDate = card.dataset.next || null;
  });
  for (const id of ["m-cinema", "m-after", "m-sort"]) $(id).addEventListener("change", render);
  for (const radio of document.querySelectorAll("input[name=group]")) {
    radio.addEventListener("change", () => {
      savePrefs();
      render();
    });
  }
  seatPreview = enableSeatPreview($("m-schedule"), {
    selector: ".seat-hold",
    onEvent: (name, params) => track(name, params),
    showFor: (node) => seatShows.get(node),
    fetchPlan: (show, signal) => fetchSeatData(show, signal, "fetchSeatPlan"),
    fetchPrices: (show, signal) => fetchSeatData(show, signal, "fetchSeatPrices"),
  });
  // The seat-map capture handler suppresses the click after a touch hold before it gets here.
  $("m-schedule").addEventListener("click", (e) => {
    const node = e.target.closest("a.seat-hold");
    const show = node && seatShows.get(node);
    if (show && !e.defaultPrevented) track("booking_click", { chain: show.chain, movie: movieGroupKey(show) });
  });
  $("sheet").addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) closeSheet();
  });

  $("locate").addEventListener("click", toggleLocation);
  $("open-stars").addEventListener("click", openStars);
  $("stars").addEventListener("click", (e) => {
    if (e.target.closest("[data-close-stars]")) closeStars();
  });
  for (const id of ["stars-region", "stars-chain"]) $(id).addEventListener("change", renderStars);
  $("stars-clear").addEventListener("click", () => {
    if (!confirm(`Unstar all ${plural(state.starred.size, "cinema")}?`)) return;
    track("stars_clear");
    state.starred.clear();
    saveStars();
    render();
  });

  document.addEventListener("keydown", (e) => {
    // "/" jumps to the search box (unless typing somewhere already).
    if (e.key === "/" && !state.movieKey && $("stars").hidden && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) {
      e.preventDefault();
      toggleFilters(true);
      $("q").focus();
      return;
    }
    if (e.key !== "Escape") return;
    if (!$("stars").hidden) closeStars();
    else if (state.movieKey) closeSheet();
  });
  window.addEventListener("hashchange", route);
  // The poster column pins just below the movie header, whatever height the header has.
  new ResizeObserver(([entry]) => {
    $("sheet").style.setProperty("--head-h", `${Math.ceil(entry.target.getBoundingClientRect().height)}px`);
  }).observe(document.querySelector(".m-head"));
  // Another tab changed the stars: pick them up.
  window.addEventListener("storage", (e) => {
    if (e.key !== "showtimes:starred") return;
    state.starred = readStars();
    render();
  });

  load(state.main);
  route();
  snapshotOnce().then((snap) => {
    if (snap) render();
  });

  // Turn location back on without a prompt if the visitor already allowed it.
  if (saved.location) {
    try {
      const status = await navigator.permissions?.query({ name: "geolocation" });
      if (status?.state === "granted") locate();
    } catch {
      // Permissions API unavailable: wait for the button.
    }
  }
}

init();
