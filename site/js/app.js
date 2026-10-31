// Page code: a poster grid of what's showing, a list of cinemas and a page per cinema, a movie
// sheet with its schedule, and a panel to manage starred cinemas. Fetching and parsing live in providers.js; grouping and caching in
// aggregator.js.

import { collectShowtimes, createCache, filterShowtimes, summarizeMovies, uniqueShows } from "./aggregator.js?v=30";
import { REGIONS, movieGroupKey, distanceKm, normalizeLanguage, normalizeTitle, todayMyt } from "./models.js?v=30";
import { GSC_PREMIUM_HALL_GROUPS, TGV_LOCATIONS, TGV_NAMES } from "./places.js?v=30";
import { createProviders, domParseXml } from "./providers.js?v=30";
import { enhanceSelect } from "./select.js?v=30";
import { collectCatalogue } from "./catalog.js?v=30";
import { browseMovies, isConcert, screeningLabel, overnightLabel } from "./browse.js?v=30";
import { loadSnapshot } from "./snapshot.js?v=30";
import { hallLabel, hallTypes, sortHallTypes } from "./halls.js?v=30";
import { enableSeatPreview } from "./seatmap.js?v=30";
// Keep early interactions while the optional module loads, without delaying the app.
let pendingAnalytics = [];
let track = (...event) => {
  if (pendingAnalytics.length < 100) pendingAnalytics.push(event);
};

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
  // The movies grid, the cinema list and the cinema pages share one date: "" is every date.
  date: "",
  page: "movies", // "movies", "cinemas" or "cinema" (under the movie sheet, when one is open)
  cinemaKey: null, // venue key of the cinema page
  snap: null, // the shared snapshot once loaded: every region and chain, for the cinema pages
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
    index = { size: shows.length, byMovie: new Map(), byDay: new Map(), byVenue: new Map() };
    const add = (map, key, show) => (map.get(key) || map.set(key, []).get(key)).push(show);
    for (const show of shows) {
      add(index.byMovie, movieGroupKey(show), show);
      add(index.byDay, show.business_date, show);
      add(index.byVenue, venueKey(show), show);
    }
    indexes.set(shows, index);
  }
  return index;
}

/** The booking dates a movie has in `shows`, among those passing `keep`, in order. */
const movieDates = (shows, key, keep) => [...new Set((indexOf(shows).byMovie.get(key) || []).filter(keep).map((s) => s.business_date))].sort();

/** The booking dates in `shows` from today on. */
const upcomingDates = (shows) => [...indexOf(shows).byDay.keys()].filter((d) => d >= todayMyt()).sort();

/** The shows on the shared date, or from today on when it's "All". */
function onPickedDate(shows) {
  if (state.date) return indexOf(shows).byDay.get(state.date) || [];
  const today = todayMyt();
  return shows.filter((s) => s.business_date >= today);
}

/** Text as searched: case, stars and punctuation don't matter. */
const looseText = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
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

// ---------------------------------------------------------------- premium halls

/** A premium hall's own cinema name -> the cinema it's in and its hall group, learned from each cinema list. */
const premiumHalls = new Map();
const isPremiumHall = (c) => c.chain === "GSC" && GSC_PREMIUM_HALL_GROUPS.has(c.hall_group);

/** The cinemas to list: premium halls (places.js) left out, after noting which cinema each is in. */
function foldCinemas(cinemas) {
  for (const hall of cinemas.filter(isPremiumHall)) {
    const parent = cinemas.find((c) => c.chain === "GSC" && c.cinema_id === hall.cinema_id && !c.hall_group);
    if (!parent) continue; // its cinema isn't listed: keep the hall as a cinema
    premiumHalls.set(hall.name, { parent: parent.name, hall_group: hall.hall_group });
    // A star on the hall moves to its cinema.
    if (state.starred.delete(`GSC|${hall.name}`)) {
      state.starred.set(`GSC|${parent.name}`, { chain: "GSC", name: parent.name, region: parent.region });
      saveStars();
    }
  }
  return cinemas.filter((c) => !(c.chain === "GSC" && premiumHalls.has(c.name)));
}

/** Shows in a premium hall, moved to the cinema it's in. They keep the hall group: GSC's seat maps and prices need it. */
function foldShows(shows) {
  if (!premiumHalls.size) return shows;
  return shows.map((s) => {
    const hall = s.chain === "GSC" && premiumHalls.get(s.cinema_name);
    return hall ? { ...s, cinema_name: hall.parent, hall_group: hall.hall_group } : s;
  });
}

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

/** What to do about a failed location request, by GeolocationPositionError code. */
const LOCATION_HELP = {
  1: "Location is blocked for this site. Click the icon at the left of the address bar (on a phone: the browser's site settings), allow Location, then press Location again.",
  2: "Your device couldn't work out where it is. On a computer, check that location services are on (Windows: Settings › Privacy & security › Location; Mac: System Settings › Privacy & Security › Location Services), then press Location again.",
  3: "Finding your location took too long. Press Location to try again.",
};

function locate() {
  if (!navigator.geolocation) {
    state.locationError = "This browser can't share a location.";
    render();
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
      if ($("c-sort").value === "name") $("c-sort").value = "near";
      render();
    },
    (err) => {
      state.locating = false;
      state.here = null;
      state.locationError = LOCATION_HELP[err.code] || "Couldn't get your location. Press Location to try again.";
      // "Nearest" was picked before the location came through: back to the default order.
      if ($("m-sort").value === "near") $("m-sort").value = "time";
      if ($("c-sort").value === "near") $("c-sort").value = "name";
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
    if ($("c-sort").value === "near") $("c-sort").value = "name";
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
  return foldCinemas(lists.flat());
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
  const dates = movieDates(state.main.shows, state.movieKey, matchesSheetStart());
  if (!dates.includes(date)) dates.push(date);
  dates.sort();
  strip.replaceChildren(...dates.map(iso => {
    const p = dateParts(iso);
    return el("label", { class: "day", title: p.long },
      el("input", { type: "radio", name, value: iso, checked: iso === date }),
      el("span", {}, el("small", {}, iso === todayMyt() ? "Today" : p.weekday), el("b", {}, String(p.day)), el("small", { class: "day-month" }, p.month)));
  }));
}

/** A shared date strip: "All", then `dates`. Rebuilt only when the dates change, so focus stays put. */
function renderPickStrip(strip, name, dates) {
  if (state.date && !dates.includes(state.date)) dates = [...dates, state.date].sort();
  const today = todayMyt();
  const sig = `${today}|${dates.join(",")}`;
  if (strip.dataset.sig !== sig) {
    strip.dataset.sig = sig;
    strip.replaceChildren(
      el("label", { class: "day day-all", title: "Every date" },
        el("input", { type: "radio", name, value: "" }),
        el("span", {}, el("small", {}, "Every"), el("b", {}, "All"), el("small", { class: "day-month" }, "date"))),
      ...dates.map((iso) => {
        const p = dateParts(iso);
        return el("label", { class: "day", title: p.long },
          el("input", { type: "radio", name, value: iso }),
          el("span", {}, el("small", {}, iso === today ? "Today" : p.weekday), el("b", {}, String(p.day)), el("small", { class: "day-month" }, p.month)));
      }),
    );
    // A strip rebuilt with a later date picked (another page, a new day) shows that date.
    const picked = state.date && strip.querySelector(`input[value="${state.date}"]`)?.closest(".day");
    strip.scrollLeft = picked ? picked.offsetLeft - strip.clientWidth / 2 + picked.offsetWidth / 2 : 0;
  }
  for (const input of strip.querySelectorAll("input")) input.checked = input.value === state.date;
}

/** Date strips scroll sideways; on a computer the mouse wheel scrolls them too, until they reach an end. */
function wheelScrolls(strip) {
  strip.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const max = strip.scrollWidth - strip.clientWidth;
    if (max <= 0 || (e.deltaY < 0 && strip.scrollLeft <= 0) || (e.deltaY > 0 && strip.scrollLeft >= max - 1)) return;
    e.preventDefault();
    strip.scrollLeft += e.deltaY;
  }, { passive: false });
}

function pickDate(iso) {
  if (iso === state.date) return;
  state.date = iso;
  track("filter_change", { control: "date", value: iso ? "day" : "all" });
  render();
}

/** "Thu 29 Oct", or "Today 29 Oct". */
function shortDate(iso) {
  const p = dateParts(iso);
  return `${iso === todayMyt() ? "Today" : p.weekday} ${p.day} ${p.month}`;
}

function setDate(view, iso) {
  if (iso === view.date) return;
  view.date = iso;
  load(view);
}

/**
 * Cinema <select>: "All", "Starred only", then starred cinemas, then the rest by chain
 * (nearest first when the location is known). Keeps the current choice if it's still listed.
 */
function fillCinemaSelect(select, keys, allLabel) {
  // Nothing listed yet (still loading): keep the choice, e.g. the one the movie view starts from.
  if (!keys.length) return;
  const keep = new Set(chosenValues(select));
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
  setChosen(select, [...valid]);
}

/** "All cinemas", or "All GSC cinemas" when one chain is picked. */
const allCinemasLabel = () => {
  const chains = selectedChains();
  return chains.length === 1 ? `All ${chains[0]} cinemas` : "All cinemas";
};

/** A checklist's choices ([] means "All"). Cinemas may hold STARRED and cinema keys. */
const chosenValues = (select) => [...select.selectedOptions].map((o) => o.value).filter(Boolean);

function setChosen(select, values) {
  for (const option of select.options) option.selected = values.length ? values.includes(option.value) : option.value === "";
  select.dataset.prev = JSON.stringify(chosenValues(select));
}

/** After a click in a checklist: "All" clears the rest; picking anything else unticks "All". */
function tidyChoice(select) {
  const before = new Set(JSON.parse(select.dataset.prev || "[]"));
  const allTicked = select.options[0]?.selected;
  const now = chosenValues(select);
  const added = now.filter((v) => !before.has(v));
  setChosen(select, allTicked && !added.length && before.size ? [] : now);
}

function cinemaSummary(select) {
  const chosen = chosenValues(select);
  // The button leaves out the movie view's count: the schedule heading shows it.
  const all = (select.options[0]?.text || "All cinemas").replace(/ \(\d+\)$/, "");
  if (!chosen.length) return all;
  const names = chosen.map((v) => (v === STARRED ? "★ Starred" : splitKey(v)[1]));
  return names.length === 1 ? names[0] : chosen.includes(STARRED) ? `★ Starred + ${names.length - 1}` : `${names.length} cinemas`;
}

function matchesCinema(select) {
  const chosen = chosenValues(select);
  if (!chosen.length) return () => true;
  const keys = new Set(chosen);
  const starred = keys.has(STARRED);
  return (s) => keys.has(venueKey(s)) || (starred && isStarred(venueKey(s)));
}

/**
 * Hall type <select>: "All hall types", then the types these shows have (Standard first, Kids last).
 * Keeps the current choice if it's still listed.
 */
function fillHallSelect(select, shows) {
  // Nothing listed yet (still loading): keep the choice, e.g. the one the movie view starts from.
  if (!shows.length) return;
  const keep = chosenValues(select);
  const present = new Set(shows.flatMap((s) => hallTypes(s.experience)));
  const types = sortHallTypes(present);
  const sig = types.join("|");
  if (select.dataset.sig !== sig) {
    select.dataset.sig = sig;
    select.replaceChildren(new Option("All hall types", ""), ...types.map((t) => new Option(hallLabel(t), t)));
  }
  setChosen(select, keep.filter((id) => present.has(id)));
}

function hallSummary(select) {
  const chosen = chosenValues(select);
  if (!chosen.length) return "All hall types";
  return chosen.length === 1 ? hallLabel(chosen[0]).split(" · ")[0] : `${chosen.length} hall types`;
}

function matchesHall(select) {
  const chosen = new Set(chosenValues(select));
  if (!chosen.size) return () => true;
  return (s) => hallTypes(s.experience).some((t) => chosen.has(t));
}

/** The main page's cinema and hall type filters together. */
function matchesMain() {
  const atCinema = matchesCinema($("cinema"));
  const atHall = matchesHall($("hall"));
  return (s) => atCinema(s) && atHall(s);
}

/** The movie view's dates follow the movies grid's filters, unless it opened from a cinema page. */
const matchesSheetStart = () => (state.page === "movies" ? matchesMain() : () => true);

const onlyStarred = (select) => {
  const chosen = chosenValues(select);
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
  for (const id of ["m-sort", "c-sort"]) {
    $(id).querySelector("option[value=near]").textContent = state.here ? "Nearest" : "Nearest (asks for your location)";
  }
  // Shown on every page (and over the movie view) until it's closed or the location comes through.
  $("location-notice").hidden = !state.locationError;
  $("location-notice-text").textContent = state.locationError;
}

// ---------------------------------------------------------------- loading

async function load(view = state.main) {
  view.controller?.abort();
  const controller = new AbortController();
  const current = () => view.controller === controller;
  const date = view.date;
  Object.assign(view, { controller, shows: [], cinemas: [], errors: [], progress: { done: 0, total: 0 }, loading: true, source: null });

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
      view.cinemas = foldCinemas(result.cinemas);
      view.shows = foldShows(result.showtimes);
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
        view.cinemas = foldCinemas(cinemas);
        rememberCinemaPlaces(view.cinemas);
      },
      onShowtimes: (shows) => {
        if (!current()) return;
        view.shows.push(...foldShows(shows));
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
// Premium halls are folded into their cinemas once, as the snapshot arrives.
const snapshotOnce = () =>
  (snapshotPromise ??= loadSnapshot().then((snap) => snap && { ...snap, cinemas: foldCinemas(snap.cinemas), showtimes: foldShows(snap.showtimes) }));

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

  const errors = view.errors;
  if (!errors.length) {
    $("warnings").replaceChildren();
    return;
  }
  const list = el("ul", {}, errors.map((e) => el("li", {}, e)));
  $("warnings").replaceChildren(
    errors.length <= 2
      ? el("div", { class: "warn" }, el("strong", {}, "Some cinemas didn't answer, so a few times may be missing."), list)
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
    view.shows.length, view.cinemas.length, view.loading, chosenValues($("cinema")), chosenValues($("hall")), searchText(), $("hide-concerts").checked,
    $("sort").value, todayMyt(), [...state.starred.keys()], state.here, state.places.size, state.date, selectedChains(), $("region").value,
  ]);
  if (gridDrawn.shows === view.shows && gridDrawn.sig === sig) return;
  gridDrawn = { shows: view.shows, sig };
  const keys = view.cinemas.length ? view.cinemas.map(c => `${c.chain}|${c.name}`) : [...new Set(view.shows.map(venueKey))];
  fillCinemaSelect($("cinema"), keys, allCinemasLabel());
  fillHallSelect($("hall"), view.shows);
  const atMain = matchesMain();
  const query = searchText();
  const hideConcerts = $("hide-concerts").checked;
  const visible = onPickedDate(view.shows).filter(s => atMain(s) && matchesSearch(s, query) && (!hideConcerts || !isConcert(s)));
  const movies = browseMovies(visible, { today: todayMyt(), sort: $("sort").value });
  // Titles come from every show (not just the visible ones), so they only change with the data.
  if (titlesOf.shows !== view.shows) titlesOf = { shows: view.shows, titles: new Map(summarizeMovies(view.shows).map(m => [m.key, m.title])) };
  const { titles } = titlesOf;
  for (const movie of movies) movie.title = titles.get(movie.key) || movie.title;
  for (const m of movies) state.lastSummary.set(m.key, m);
  $("count").textContent = `${plural(movies.length, "movie")} · ${plural(new Set(visible.map(venueKey)).size, "cinema")}`;
  const empty = !selectedChains().length
    ? "Pick GSC, TGV or both in the Cinema menu to see what's showing."
    : view.loading ? "Loading movies and advance sales…" : state.date ? `No movies match these filters on ${shortDate(state.date)}.` : "No movies match these filters.";
  $("grid").replaceChildren(...(movies.length ? movies.map(m => movieCard(m)) : [emptyNote(empty, "movies")]));
}

/** An empty-list note, with a way out when filters are what emptied it. */
function emptyNote(text, page) {
  const filters = activeFilters(page);
  return el("div", { class: "empty" },
    el("p", {}, text),
    filters.length && !state.main.loading
      ? el("button", { type: "button", class: "clear-filters", onclick: () => clearFilters(filters) }, filters.length === 1 ? `Remove filter: ${filters[0].label}` : "Clear all filters")
      : null);
}

// ---------------------------------------------------------------- active filters

/** Everything narrowing a page, so a saved-looking choice (GSC only, one cinema) is never invisible. */
function activeFilters(page) {
  const list = [];
  const chains = selectedChains();
  if (state.date) list.push({ kind: "date", label: shortDate(state.date), clear: () => { state.date = ""; } });
  if ($("region").value) list.push({ kind: "region", label: regionLabel(), clear: () => { $("region").value = ""; return "reload"; } });
  if (chains.length !== 2) {
    list.push({ kind: "chain", label: chains.length ? `${chains[0]} only` : "No chain", clear: () => {
      for (const box of document.querySelectorAll("input[name=chain]")) box.checked = true;
      return "reload";
    } });
  }
  if (page === "movies") {
    if (chosenValues($("cinema")).length) list.push({ kind: "cinema", label: cinemaSummary($("cinema")), clear: () => setChosen($("cinema"), []) });
    if (chosenValues($("hall")).length) list.push({ kind: "hall", label: hallSummary($("hall")), clear: () => setChosen($("hall"), []) });
    if (searchText()) list.push({ kind: "search", label: `“${searchText()}”`, clear: () => { $("q").value = ""; } });
    if (!$("hide-concerts").checked) list.push({ kind: "concerts", label: "Concerts included", clear: () => { $("hide-concerts").checked = true; } });
  } else if (cinemaQuery()) {
    list.push({ kind: "cinema_search", label: `“${cinemaQuery()}”`, clear: () => { $("cq").value = ""; } });
  }
  return list;
}

function clearFilters(filters) {
  track("filter_change", { control: "clear", value: filters.map((f) => f.kind).join(",") });
  const reload = filters.map((f) => f.clear()).includes("reload");
  if (reload) reloadAll();
  else render();
}

function renderActiveFilters(box, page) {
  const filters = activeFilters(page);
  box.hidden = !filters.length;
  const sig = filters.map((f) => f.label).join("|");
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.replaceChildren(
    ...(filters.length ? [el("span", { class: "label" }, "Filtered by")] : []),
    ...filters.map((f) =>
      el("button", { type: "button", class: "chip", title: "Remove this filter", "aria-label": `Remove filter: ${f.label}`, onclick: () => clearFilters([f]) },
        el("span", {}, f.label), el("span", { class: "chip-x", "aria-hidden": "true" }, "×"))),
    ...(filters.length > 1 ? [el("button", { type: "button", class: "link-btn mono", onclick: () => clearFilters(activeFilters(page)) }, "Clear all")] : []),
  );
}

// ---------------------------------------------------------------- cinema list

const cinemaQuery = () => $("cq").value.trim();

let cinemasDrawn = { shows: null, sig: "" };

function renderCinemas() {
  const view = state.main;
  const today = todayMyt();
  renderPickStrip($("c-dates"), "c-date", upcomingDates(view.shows));
  const sig = JSON.stringify([view.shows.length, view.cinemas.length, view.loading, state.date, cinemaQuery(), $("c-sort").value, today,
    [...state.starred.keys()], state.here, state.places.size, selectedChains(), $("region").value]);
  if (cinemasDrawn.shows === view.shows && cinemasDrawn.sig === sig) return;
  cinemasDrawn = { shows: view.shows, sig };
  const seen = new Map(); // venue key -> {movies, shows}
  for (const s of onPickedDate(view.shows)) {
    const k = venueKey(s);
    const row = seen.get(k) || seen.set(k, { movies: new Set(), shows: 0 }).get(k);
    row.movies.add(movieGroupKey(s));
    row.shows++;
  }
  const listed = view.cinemas.length
    ? view.cinemas.map((c) => ({ key: `${c.chain}|${c.name}`, chain: c.chain, name: c.name, region: c.region }))
    : [...new Map(view.shows.map((s) => [venueKey(s), { key: venueKey(s), chain: s.chain, name: s.cinema_name, region: s.region }])).values()];
  const query = looseText(cinemaQuery());
  const rows = [...new Map(listed.map((c) => [c.key, c])).values()]
    .filter((c) => !query || looseText(`${c.chain} ${c.name} ${c.region}`).includes(query))
    .map((c) => ({ ...c, movies: seen.get(c.key)?.movies.size || 0, shows: seen.get(c.key)?.shows || 0 }));
  const sort = $("c-sort").value;
  const far = (k) => kmTo(k) ?? Infinity;
  rows.sort((a, b) =>
    // Starred first, then cinemas with something on.
    Number(isStarred(b.key)) - Number(isStarred(a.key)) ||
    Number(b.shows > 0) - Number(a.shows > 0) ||
    (sort === "near" ? far(a.key) - far(b.key) : sort === "movies" ? b.movies - a.movies || b.shows - a.shows : 0) ||
    a.name.localeCompare(b.name));
  const open = rows.filter((c) => c.shows).length;
  $("c-count").textContent = rows.length ? `${plural(rows.length, "cinema")} · ${open} showing${state.date ? ` ${shortDate(state.date)}` : ""}` : "";
  if (!rows.length) {
    const text = !selectedChains().length ? "Pick GSC, TGV or both to see their cinemas." : view.loading ? "Loading cinemas…" : "No cinemas match these filters.";
    $("c-list").replaceChildren(emptyNote(text, "cinemas"));
    return;
  }
  $("c-list").replaceChildren(el("div", { class: "crows" }, rows.map(cinemaRow)));
}

function cinemaRow(c) {
  const km = kmLabel(kmTo(c.key));
  return el("div", { class: `crow${isStarred(c.key) ? " starred" : ""}${c.shows ? "" : " none"}` },
    starButton(c.key, c.region),
    el("a", { class: "crow-link", href: `#/cinema/${encodeURIComponent(c.key)}` },
      el("span", { class: "crow-id" }, el("span", { class: `chain ${c.chain}` }, c.chain), el("span", { class: "crow-name" }, c.name)),
      el("span", { class: "crow-meta mono" }, [c.region, km].filter(Boolean).join(" · ")),
      el("span", { class: "crow-sum mono" }, c.shows ? `${plural(c.movies, "movie")} · ${plural(c.shows, "show")}` : state.date ? "Nothing this day" : "No shows listed"),
      el("span", { class: "chev", "aria-hidden": "true" })));
}

// ---------------------------------------------------------------- cinema page

let cinemaDrawn = "";
const CINEMA_POSTER_SIZES = "96px";

/** Every show of the cinema page's cinema: the snapshot has all regions and chains; live, the main page's. */
function cinemaShows(key) {
  const pool = state.snap?.showtimes || state.main.shows;
  const today = todayMyt();
  return (indexOf(pool).byVenue.get(key) || []).filter((s) => s.business_date >= today);
}

function renderCinema() {
  const key = state.cinemaKey;
  const [chain, name] = splitKey(key);
  const all = cinemaShows(key);
  const cinema = [...state.main.cinemas, ...(state.snap?.cinemas || [])].find((c) => c.chain === chain && c.name === name);
  const region = cinema?.region || all[0]?.region || "";
  if (cinema) rememberPlace(key, cinema);
  renderPickStrip($("v-dates"), "v-date", [...new Set(all.map((s) => s.business_date))].sort());

  const now = nowMyt();
  const sig = JSON.stringify([key, all.length, state.main.loading, state.date, now, isStarred(key), state.here, state.places.size]);
  if (cinemaDrawn === sig) return;
  cinemaDrawn = sig;

  $("v-star").replaceChildren(starButton(key, region), el("span", { class: `chain ${chain}` }, chain));
  $("v-name").textContent = name;
  document.title = `${name} · 52 Frames`;
  const shows = filterShowtimes(state.date ? all.filter((s) => s.business_date === state.date) : all);
  const movies = summarizeMovies(shows);
  for (const m of movies) m.title = state.lastSummary.get(m.key)?.title || m.title;
  // The next one still to start first; ones that are all over for today go last.
  const next = (m) => (m.shows.find((s) => s.start >= now) || { start: `~${m.shows[0].start}` }).start;
  movies.sort((a, b) => cmp(next(a), next(b)) || a.title.localeCompare(b.title));
  $("v-meta").textContent = [region, kmLabel(kmTo(key))].filter(Boolean).join(" · ");
  $("v-count").textContent = movies.length ? `${plural(movies.length, "movie")} · ${plural(shows.length, "show")}` : "";

  if (!movies.length) {
    const loading = state.main.loading && !state.snap;
    const text = loading
      ? "Loading showtimes…"
      : state.date && all.length
        ? `Nothing on at this cinema on ${shortDate(state.date)}.`
        : "No showtimes listed for this cinema yet.";
    $("v-movies").replaceChildren(el("div", { class: "empty" }, el("p", {}, text),
      state.date && all.length ? el("button", { type: "button", class: "clear-filters", onclick: () => pickDate("") }, "Show all dates") : null));
    return;
  }
  $("v-movies").replaceChildren(...movies.map((m) => cinemaMovie(m, now)));
}

/** One movie at the cinema page's cinema: poster, title, then its times (by day when showing all dates). */
function cinemaMovie(summary, now) {
  const href = `#/movie/${encodeURIComponent(summary.key)}`;
  const opensOn = state.date || summary.shows[0].business_date;
  const days = new Map();
  for (const s of summary.shows) (days.get(s.business_date) || days.set(s.business_date, []).get(s.business_date)).push(s);
  const times = (list) => el("div", { class: "times" }, list.map((s) => timeChip(s, now)));
  return el("section", { class: "cm" },
    el("a", { class: "cm-poster", href, "data-next": opensOn, tabindex: "-1", "aria-hidden": "true" }, posterFrame(summary, CINEMA_POSTER_SIZES)),
    el("div", { class: "cm-body" },
      el("h3", {}, el("a", { href, "data-next": opensOn, title: "All cinemas showing this movie" }, summary.title)),
      el("div", { class: "cm-meta mono" }, [runtime(summary.duration_mins), summary.rating, summary.language].filter(Boolean).join(" · ")),
      state.date
        ? times(summary.shows)
        : [...days].map(([day, list]) => el("div", { class: "cm-day" }, el("span", { class: "cm-date mono" }, shortDate(day)), times(list)))));
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
  const cinema = [...state.sheet.cinemas, ...state.main.cinemas, ...(state.snap?.cinemas || [])].find((c) => c.chain === show.chain && c.name === show.cinema_name);
  // A premium hall's show carries its own hall group (foldShows); other shows take their cinema's.
  return providers[show.chain][method]({ ...show, hall_group: show.hall_group ?? cinema?.hall_group ?? "" }, signal);
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
    // Start from the movies grid's cinema and hall choice; from a cinema page, from all of them.
    const inherit = (select) => (state.page === "movies" ? [...select.selectedOptions] : []).map((o) => new Option(o.text, o.value, true, true));
    $("m-cinema").dataset.sig = "";
    $("m-cinema").replaceChildren(...inherit($("cinema")));
    $("m-hall").dataset.sig = "";
    $("m-hall").replaceChildren(...inherit($("hall")));
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
  fillCinemaSelect($("m-cinema"), keys, `${allCinemasLabel()} (${keys.length})`);

  const now = nowMyt();
  fillHallSelect($("m-hall"), all);
  const atCinema = matchesCinema($("m-cinema"));
  const atHall = matchesHall($("m-hall"));
  const shows = filterShowtimes(all).filter((s) => atCinema(s) && atHall(s));

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
      ? "Pick GSC, TGV or both in the Cinema menu to see what's showing."
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
let cameFromGrid = false; // the movie sheet opened from a link on this page: Back is history.back()
let cameFromCinemas = false; // the same for a cinema page opened from the cinema list
const pageScroll = new Map(); // page id -> scroll position, restored on the way back
const pageId = () => (state.page === "cinema" ? `cinema:${state.cinemaKey}` : state.page);
const pageHash = () => (state.page === "cinema" ? `#/cinema/${encodeURIComponent(state.cinemaKey)}` : state.page === "cinemas" ? "#/cinemas" : "#/");
const pageTitle = () => (state.page === "cinema" ? `${splitKey(state.cinemaKey)[1]} · 52 Frames` : state.page === "cinemas" ? "Cinemas · 52 Frames" : "52 Frames");

/** Show the movies grid, the cinema list or a cinema page. True when the page changed. */
function showPage(page, cinemaKey = null) {
  const before = pageId();
  if (page === state.page && cinemaKey === state.cinemaKey) return false;
  pageScroll.set(before, window.scrollY);
  seatPreview?.close();
  state.page = page;
  state.cinemaKey = cinemaKey;
  cinemaDrawn = "";
  $("list").hidden = page !== "movies";
  $("cinemas-page").hidden = page !== "cinemas";
  $("cinema-page").hidden = page !== "cinema";
  for (const [id, on] of [["tab-movies", page === "movies"], ["tab-cinemas", page !== "movies"]]) {
    if (on) $(id).setAttribute("aria-current", "page");
    else $(id).removeAttribute("aria-current");
  }
  if (page === "cinema") track("cinema_open", { chain: splitKey(cinemaKey)[0] });
  if (page !== "cinema") cameFromCinemas = false;
  return true;
}

function route() {
  const match = /^#\/movie\/(.+)$/.exec(location.hash);
  const key = match ? decodeURIComponent(match[1]) : null;
  // A movie opens over whichever page was showing (the movies grid for a direct link).
  let moved = false;
  if (!key) {
    const cinema = /^#\/cinema\/(.+)$/.exec(location.hash);
    if (cinema) moved = showPage("cinema", decodeURIComponent(cinema[1]));
    else moved = showPage(location.hash === "#/cinemas" ? "cinemas" : "movies");
  }
  const opening = key && !state.movieKey;
  state.movieKey = key;
  $("sheet").hidden = !key;
  document.body.classList.toggle("locked", Boolean(key) || !$("stars").hidden);
  if (opening) {
    // From a cinema page outside the chosen region (a shared link), start from all of Malaysia.
    const at = state.page === "cinema" ? cinemaShows(state.cinemaKey)[0] : null;
    const outside = at && !inScope(at.chain, at.region, [at.chain], $("region").value);
    $("m-region").value = outside ? "" : $("region").value;
    $("to-top").hidden = true;
    state.sheet.date = state.pendingSheetDate || movieDates(state.main.shows, key, matchesSheetStart())[0] || todayMyt();
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
    document.title = pageTitle();
    returnFocus?.focus?.({ preventScroll: true });
    returnFocus = null;
  }
  render();
  if (moved) window.scrollTo(0, pageScroll.get(pageId()) || 0);
}

function closeSheet() {
  if (cameFromGrid) history.back();
  else location.hash = pageHash();
  cameFromGrid = false;
}

function reloadAll() {
  load(state.main);
  if (state.movieKey) load(state.sheet);
}

const dropdowns = [];

/** What the folded filter buttons say on phones: the date, then only what differs from the defaults. */
function renderFilterSummary() {
  $("clear-search").hidden = !searchText();
  $("c-clear-search").hidden = !cinemaQuery();
  const date = state.date ? shortDate(state.date) : "All dates";
  const parts = [date, regionLabel()];
  if (chosenValues($("cinema")).length) parts.push(cinemaSummary($("cinema")));
  if (chosenValues($("hall")).length) parts.push(hallSummary($("hall")));
  if ($("sort").value !== "shows") parts.push($("sort").selectedOptions[0].text);
  const chains = selectedChains();
  if (chains.length !== 2) parts.push(chains.length ? `${chains[0]} only` : "No chain");
  parts.push($("hide-concerts").checked ? "Concerts hidden" : "Concerts included");
  if (searchText()) parts.push(`“${searchText()}”`);
  $("filters-summary").textContent = parts.join(" · ");

  const cinemaParts = [date, regionLabel()];
  if (chains.length !== 2) cinemaParts.push(chains.length ? `${chains[0]} only` : "No chain");
  if ($("c-sort").value !== "name") cinemaParts.push($("c-sort").selectedOptions[0].text);
  if (cinemaQuery()) cinemaParts.push(`“${cinemaQuery()}”`);
  $("c-filters-summary").textContent = cinemaParts.join(" · ");
}

/** Fold or unfold a page's filters on phones ("" for the movies page, "c-" for the cinema list). */
function toggleFilters(open, prefix = "") {
  const box = $(`${prefix}filters`);
  open ??= !box.classList.contains("open");
  box.classList.toggle("open", open);
  $(`${prefix}filters-toggle`).setAttribute("aria-expanded", String(open));
}

function render() {
  for (const pill of document.querySelectorAll(".toggle[data-chain]")) {
    pill.setAttribute("aria-pressed", String(selectedChains().includes(pill.dataset.chain)));
  }
  // A date that has passed (the page stayed open overnight) goes back to every date.
  if (state.date && state.date < todayMyt()) state.date = "";
  $("c-region").value = $("region").value;
  renderTools();
  renderFilterSummary();
  if (state.page === "movies") {
    renderStatus();
    renderPickStrip($("dates"), "date", upcomingDates(state.main.shows));
    renderActiveFilters($("active-filters"), "movies");
    renderGrid();
  } else if (state.page === "cinemas") {
    renderActiveFilters($("c-active-filters"), "cinemas");
    renderCinemas();
  } else renderCinema();
  if (state.movieKey) renderSheet();
  renderStars();
  for (const d of dropdowns) d.sync();
}

// ---------------------------------------------------------------- wiring

function init() {
  import("./analytics.js?v=30").then((analytics) => {
    analytics.initAnalytics();
    track = analytics.track;
    const pending = pendingAnalytics;
    pendingAnalytics = null;
    for (const event of pending) track(...event);
  }).catch(() => {
    track = () => {};
    pendingAnalytics = null;
  }); // A blocked/missing analytics module must not prevent the app from starting.
  // Only the starred cinemas are kept between visits; every other setting starts from its default.
  try {
    storage("localStorage")?.removeItem("showtimes:prefs"); // what older versions saved
  } catch {
    // Storage blocked: nothing saved anyway.
  }
  for (const id of ["m-region", "c-region"]) $(id).replaceChildren(...[...$("region").options].map((o) => new Option(o.text, o.value)));
  for (const id of ["region", "sort", "cinema", "hall", "m-region", "m-cinema", "m-hall", "m-sort", "c-region", "c-sort", "stars-region", "stars-chain"]) {
    const options = id.endsWith("cinema") ? { summary: cinemaSummary, search: "Search cinemas" } : id.endsWith("hall") ? { summary: hallSummary } : {};
    // GSC / TGV pills at the top of the cinema lists.
    if (id === "cinema") options.header = $("chains");
    if (id === "m-cinema") options.header = $("m-chains");
    dropdowns.push(enhanceSelect($(id), options));
  }
  for (const id of ["dates", "c-dates", "v-dates", "m-dates"]) wheelScrolls($(id));
  tickClock();
  setInterval(tickClock, 15000);
  // Back to top on the movie list too, once it has scrolled a screen or so.
  window.addEventListener("scroll", () => { $("page-top").hidden = window.scrollY < 600; }, { passive: true });
  $("page-top").addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });

  for (const id of ["toolbar", "c-toolbar"]) $(id).addEventListener("submit", (e) => e.preventDefault());
  $("region").addEventListener("change", reloadAll);
  // The cinema list's region is the main page's region.
  $("c-region").addEventListener("change", () => {
    $("region").value = $("c-region").value;
    $("region").dispatchEvent(new Event("change", { bubbles: true }));
  });
  for (const box of document.querySelectorAll("input[name=chain]")) box.addEventListener("change", reloadAll);
  // Both cinema lists' chain pills flip the one chain setting (the hidden checkboxes), whose
  // listeners reload both views; the movie view only has the chains the page loaded.
  for (const id of ["chains", "m-chains", "c-chains"]) {
    $(id).addEventListener("click", (e) => {
      const pill = e.target.closest("[data-chain]");
      if (!pill) return;
      const box = document.querySelector(`input[name=chain][value=${pill.dataset.chain}]`);
      box.checked = !box.checked;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  // The movies grid, cinema list and cinema pages share one date; the movie view keeps its own.
  for (const id of ["dates", "c-dates", "v-dates"]) $(id).addEventListener("change", (e) => pickDate(e.target.value));

  $("m-dates").addEventListener("change", (e) => setDate(state.sheet, e.target.value));
  $("m-region").addEventListener("change", () => load(state.sheet));
  // Back to top: shown once the schedule has scrolled a screen or so.
  const panel = $("sheet").querySelector(".sheet-panel");
  panel.addEventListener("scroll", () => { $("to-top").hidden = panel.scrollTop < 600; }, { passive: true });
  $("to-top").addEventListener("click", () => {
    panel.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    $("sheet").querySelector(".close").focus({ preventScroll: true });
  });
  for (const id of ["cinema", "m-cinema", "hall", "m-hall"]) $(id).addEventListener("change", (e) => tidyChoice(e.target));
  for (const id of ["cinema", "hall", "sort"]) $(id).addEventListener("change", render);
  $("hide-concerts").addEventListener("change", render);
  $("c-sort").addEventListener("change", render);
  // Picking "Nearest" without a location asks for one.
  for (const id of ["m-sort", "c-sort"]) {
    $(id).addEventListener("change", () => {
      if ($(id).value !== "near" || state.here || state.locating) return;
      track("location_toggle", { action: "request" });
      locate();
    });
  }
  $("location-notice-close").addEventListener("click", () => {
    state.locationError = "";
    render();
  });
  $("c-sort").addEventListener("change", () => track("filter_change", { control: "c-sort", value: $("c-sort").value }));
  $("cq").addEventListener("input", render);
  $("c-clear-search").addEventListener("click", () => {
    $("cq").value = "";
    render();
    $("cq").focus();
  });
  $("cq").addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("cq").value) {
      e.stopPropagation();
      $("cq").value = "";
      render();
    }
  });
  $("q").addEventListener("input", render);
  // Debounce analytics only; search still renders immediately. Never send the search text.
  let searchTimer;
  $("q").addEventListener("input", () => {
    clearTimeout(searchTimer);
    if (searchText()) searchTimer = setTimeout(() => {
      if (searchText()) track("search_used");
    }, 800);
  });
  for (const id of ["region", "cinema", "hall", "sort", "hide-concerts", "m-region", "m-cinema", "m-hall", "m-sort"]) {
    $(id).addEventListener("change", () => track("filter_change", {
      control: id,
      value: id.endsWith("cinema")
        ? (onlyStarred($(id)) ? "starred" : "selection")
        : id.endsWith("hall") ? chosenValues($(id)).join(",") || "all"
        : id === "hide-concerts" ? String($(id).checked) : $(id).value,
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
  $("c-filters-toggle").addEventListener("click", () => toggleFilters(undefined, "c-"));
  $("q").addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("q").value) {
      e.stopPropagation();
      $("q").value = "";
      render();
    }
  });

  // A movie link on any page (grid card, cinema page) opens the movie on the day it next shows there.
  document.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    const link = e.target.closest?.('a[href^="#/movie/"]');
    if (link) {
      cameFromGrid = true;
      state.pendingSheetDate = link.dataset.next || null;
    }
    if (e.target.closest?.("a.crow-link")) cameFromCinemas = true;
  });
  $("v-back").addEventListener("click", (e) => {
    if (!cameFromCinemas) return;
    e.preventDefault();
    history.back();
  });
  for (const id of ["m-cinema", "m-hall", "m-sort"]) $(id).addEventListener("change", render);
  for (const radio of document.querySelectorAll("input[name=group]")) radio.addEventListener("change", render);
  const seatOptions = {
    selector: ".seat-hold",
    onEvent: (name, params) => track(name, params),
    showFor: (node) => seatShows.get(node),
    fetchPlan: (show, signal) => fetchSeatData(show, signal, "fetchSeatPlan"),
    fetchPrices: (show, signal) => fetchSeatData(show, signal, "fetchSeatPrices"),
  };
  seatPreview = enableSeatPreview($("m-schedule"), seatOptions);
  const cinemaSeatPreview = enableSeatPreview($("v-movies"), seatOptions);
  // The seat-map capture handler suppresses the click after a touch hold before it gets here.
  const trackBooking = (e) => {
    if (e.type === "auxclick" && e.button !== 1) return;
    const node = e.target.closest("a.seat-hold");
    const show = node && seatShows.get(node);
    if (show && !e.defaultPrevented) track("booking_click", { chain: show.chain, movie: movieGroupKey(show) });
  };
  for (const id of ["m-schedule", "v-movies"]) {
    $(id).addEventListener("click", trackBooking);
    $(id).addEventListener("auxclick", trackBooking);
  }
  window.addEventListener("hashchange", () => cinemaSeatPreview.close());
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
    // "/" jumps to the page's search box (unless typing somewhere already).
    if (e.key === "/" && !state.movieKey && $("stars").hidden && state.page !== "cinema" && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) {
      e.preventDefault();
      if (state.page === "movies") {
        toggleFilters(true);
        $("q").focus();
      } else {
        toggleFilters(true, "c-");
        $("cq").focus();
      }
      return;
    }
    if (e.key !== "Escape") return;
    if (!$("stars").hidden) closeStars();
    else if (state.movieKey) closeSheet();
    else if (state.page === "cinema") $("v-back").click();
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
    state.snap = snap;
    if (snap) {
      rememberCinemaPlaces(snap.cinemas);
      render();
    }
  });
}

init();
