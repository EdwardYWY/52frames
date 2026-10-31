// GSC and TGV: fetch + parse, run in the visitor's browser.
// Ports cinema_showtimes/gsc.py and tgv.py. If a chain changes its API, change both.
//
// Nothing here touches the page. Network and XML parsing are injectable so Node tests can
// run the parsers against tests/fixtures/ without a browser.

import { floatOrNull, intOrNull, makeShowtime, normalizeSubtitles } from "./models.js?v=30";
import { tgvCinemaName } from "./places.js?v=30";

// ---------------------------------------------------------------------------- GSC

export const GSC = {
  chain: "GSC",
  locationsUrl: "https://epaymentapi.gsc.com.my/gsc/epay/GetEpaymentLocations",
  showtimesUrl:
    "https://epaymentapi.gsc.com.my/showtimews/service.asmx/getShowTimesByLocation_ParentChild_V2",
  bookingBase: "https://epaymentwebapp.gsc.com.my/showtime-by-movies",
  pricesUrl: "https://epaymentapi.gsc.com.my/showtimews/service.asmx/getTicketPricingEpaySpecialV5",
  seatsUrl: "https://epaymentapi.gsc.com.my/showtimews/service.asmx/getHallSeatStatus",
};

export function parseGscCinemas(payload) {
  const locations = payload?.Response?.Body?.Locations || [];
  return locations
    .filter((loc) => !loc.IsEpayHidden)
    .map((loc) => ({
      chain: GSC.chain,
      cinema_id: String(loc.CinemaCode),
      name: loc.EpaymentName || loc.CinemaName || "",
      region: loc.Region || "",
      state: "",
      // Premium venues (Aurum, Velvet, ...) list nothing unless their hall group is sent.
      hall_group: loc.HallGroup || "",
      latitude: floatOrNull(loc.Latitude),
      longitude: floatOrNull(loc.Longitude),
    }));
}

// Python's urllib.parse.quote(s, safe=""): like encodeURIComponent, but also escapes !'()*
function pyQuote(text) {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function gscBookingUrl(parentCode, title) {
  const slug = title.trim().toLowerCase().replace(/\s+/g, "-");
  return `${GSC.bookingBase}/${parentCode}/${pyQuote(slug)}`;
}

const attr = (node, name) => node.getAttribute(name) ?? "";

function gscStart(day, hhmm) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{4}$/.test(hhmm)) {
    throw new Error(`unexpected GSC show time ${day} ${hhmm}`);
  }
  return `${day}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
}

const gscHall = (show) => {
  const hall = attr(show, "hname");
  return /^\d+$/.test(hall) ? `Hall ${hall}` : hall;
};

/** Browser XML adapter. Tests pass their own `parseXml` with the same tiny interface. */
export function domParseXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("GSC sent invalid XML");
  return doc;
}

/**
 * Parse GSC's showtimes XML. `parseXml(text)` must return a node with
 * getElementsByTagName(name) (descendants, document order) and getAttribute(name).
 */
export function parseGscShowtimes(xmlText, cinema, parseXml = domParseXml) {
  const root = parseXml(xmlText);
  const shows = [];
  for (const oprn of root.getElementsByTagName("oprn")) {
    const businessDate = attr(oprn, "date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      throw new Error(`unexpected GSC business date ${businessDate}`);
    }
    for (const parent of oprn.getElementsByTagName("parent")) {
      const title = attr(parent, "title");
      const bookingUrl = gscBookingUrl(attr(parent, "code"), title);
      for (const child of parent.getElementsByTagName("child")) {
        for (const show of child.getElementsByTagName("show")) {
          shows.push(
            makeShowtime({
              chain: GSC.chain,
              cinema_id: cinema.cinema_id,
              cinema_name: cinema.name,
              region: cinema.region,
              movie_title: title,
              start: gscStart(attr(show, "date"), attr(show, "time")),
              business_date: businessDate,
              experience: attr(show, "type"),
              hall: gscHall(show),
              duration_mins: intOrNull(attr(child, "duration")),
              rating: attr(child, "rating"),
              language: attr(child, "lang"),
              genres: attr(child, "genre") ? [attr(child, "genre")] : [],
              sold_out: attr(show, "hallfull") === "1",
              booking_url: bookingUrl,
              poster_url: attr(child, "thumb_big"),
              poster_small_url: attr(child, "thumb_medium"),
              latitude: cinema.latitude ?? null,
              longitude: cinema.longitude ?? null,
            }),
          );
        }
      }
    }
  }
  return shows;
}

/**
 * Where GSC keeps a show's seats and prices: { hid, filmid, date, time } from its showtimes XML, or null.
 * Shows don't carry GSC's hall id (the snapshot leaves it out), so they're matched by start and hall.
 */
export function findGscHall(xmlText, show, parseXml = domParseXml) {
  for (const child of parseXml(xmlText).getElementsByTagName("child")) {
    for (const node of child.getElementsByTagName("show")) {
      const date = attr(node, "date");
      const time = attr(node, "time");
      if (`${date}T${time.slice(0, 2)}:${time.slice(2)}` === show.start && gscHall(node) === show.hall) {
        return { hid: attr(node, "hid"), filmid: attr(child, "code"), date, time };
      }
    }
  }
  return null;
}

// Seat types nobody can book online: house, reservation, repair, locked, blocked.
const GSC_CLOSED_TYPES = new Set(["H", "R", "D", "L", "X"]);
const GSC_PAIR_TYPES = new Set(["T", "TS", "4S"]);

/**
 * GSC's getHallSeatStatus XML as rows of cells, in the same shape as parseTgvSeatPlan, laid out
 * the way GSC draws it: rows in order of y (y counts from the screen, so the row nearest the
 * screen comes first, usually the highest letter), seat 1 on the left.
 */
export function parseGscSeatPlan(xmlText, parseXml = domParseXml) {
  const root = parseXml(xmlText);
  const categories = new Map([...root.getElementsByTagName("category")].map((node) => [attr(node, "id"), attr(node, "name")]));
  const grid = new Map(); // y -> { label, seats: Map(x -> seat) }
  for (const row of root.getElementsByTagName("row")) {
    const y = Number(attr(row, "y"));
    if (!grid.has(y)) grid.set(y, { label: attr(row, "value"), seats: new Map() });
    const line = grid.get(y);
    for (const col of row.getElementsByTagName("col")) {
      const status = attr(col, "status");
      const type = attr(col, "type");
      line.seats.set(Number(attr(col, "x")), {
        number: `${attr(row, "value")}${attr(col, "value")}`,
        state: status === "A" && !GSC_CLOSED_TYPES.has(type) ? "free" : status === "B" ? "sold" : "blocked",
        pair: GSC_PAIR_TYPES.has(type),
        category: attr(col, "seatcategory"),
        categoryName: categories.get(attr(col, "seatcategory")) || "",
        oku: type === "W", // wheelchair space
      });
    }
  }
  const xs = [...grid.values()].flatMap((line) => [...line.seats.keys()]);
  if (!xs.length) throw new Error("No seat plan for this show");
  const ys = [...grid.keys()];
  const rows = [];
  for (let y = Math.min(...ys); y <= Math.max(...ys); y++) {
    const line = grid.get(y);
    const seats = [];
    for (let x = Math.min(...xs); x <= Math.max(...xs); x++) seats.push(line?.seats.get(x) || null);
    rows.push({ label: line?.label || "", seats });
  }
  const all = rows.flatMap((row) => row.seats).filter(Boolean);
  return { rows, free: all.filter((seat) => seat.state === "free").length, total: all.length };
}

// GSC's showtime data has no subtitles; its public movie pages (www.gsc.com.my/movie/<slug>/) do.
// Those pages are server-rendered HTML with no data feed, so only the snapshot job reads them
// (once per movie per run), never the visitor's browser.

GSC.siteUrl = "https://www.gsc.com.my";

/** Movie page slugs linked from the GSC homepage. */
export function gscMovieSlugs(html) {
  return [...new Set([...String(html).matchAll(/href="\/movie\/([a-z0-9-]+)\/?"/g)].map((m) => m[1]))];
}

const squash = (text) => String(text).toLowerCase().replace(/&amp;/g, "and").replace(/[^a-z0-9]/g, "");

/**
 * The slug of a GSC title: its letters and digits match the slug's, with or without a leading
 * "(RERUN)"-style tag. GSC cuts slugs at 50 characters, so a long slug may match a title's start.
 */
export function findGscSlug(title, slugs) {
  for (const candidate of [title, String(title).replace(/[([][^)\]]*[)\]]/g, " ")]) {
    const want = squash(candidate);
    if (!want) continue;
    const exact = slugs.find((slug) => squash(slug) === want);
    if (exact) return exact;
    const cut = slugs.find((slug) => slug.length >= 45 && want.startsWith(squash(slug)));
    if (cut) return cut;
  }
  return null;
}

/** Subtitles from a GSC movie page ("BM / CHI / ENG"), or null when the page doesn't say. */
export function parseGscSubtitles(html) {
  const match = />Subtitles<\/span>\s*<span[^>]*>\s*:?\s*([^<]*)<\/span>/.exec(String(html));
  return match ? normalizeSubtitles(match[1].split("/")) : null;
}

// ---------------------------------------------------------------------------- TGV

export const TGV = {
  chain: "TGV",
  statesUrl: "https://api.tgv.com.my/api/cinemas/v1/getstatecinema",
  sessionsUrl: "https://api.tgv.com.my/api/boxoffice/v1/moviesession_get",
  pricesUrl: "https://api.tgv.com.my/api/boxoffice/v1/moviesession_gettickets",
  seatPlanUrl: "https://api.tgv.com.my/api/boxoffice/v1/moviesession_getseatplan",
  movieUrl: "https://www.tgv.com.my/movies/details",
  infoUrl: "https://www.tgv.com.my/movie",
};

// TGV groups cinemas by state; map them onto the shared regions GSC uses.
export const TGV_STATE_TO_REGION = {
  klangvalley: "Klang Valley",
  selangor: "Klang Valley",
  kualalumpur: "Klang Valley",
  pinang: "Northern",
  perak: "Northern",
  kedah: "Northern",
  perlis: "Northern",
  johor: "Southern",
  melaka: "Southern",
  negerisembilan: "Southern",
  pahang: "East Coast",
  terengganu: "East Coast",
  kelantan: "East Coast",
  sabah: "East Malaysia",
  sarawak: "East Malaysia",
};

// "PAVILION KUALA LUMPUR (NEW)" -> "Pavilion Kuala Lumpur (New)"; skips leading punctuation.
function titleCase(name) {
  return String(name)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const i = word.search(/\p{L}/u);
      if (i < 0) return word;
      const ch = String.fromCodePoint(word.codePointAt(i));
      return word.slice(0, i) + ch.toUpperCase() + word.slice(i + ch.length).toLowerCase();
    })
    .join(" ");
}

export function parseTgvCinemas(payload) {
  const cinemas = [];
  const seen = new Set();
  for (const state of payload?.results || []) {
    if (state.value === "all") continue;
    const region = TGV_STATE_TO_REGION[state.value ?? ""] ?? state.label ?? "";
    for (const item of state.cinemas || []) {
      const id = item.cinemaid;
      if (seen.has(id)) continue;
      seen.add(id);
      const name = tgvCinemaName(id, titleCase(item.name ?? id), state.label ?? "");
      cinemas.push({
        chain: TGV.chain,
        cinema_id: id,
        name,
        region,
        state: state.label ?? "",
        hall_group: "",
        latitude: null,
        longitude: null,
      });
    }
  }
  return cinemas;
}

function tgvStart(value) {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(value ?? "");
  if (!match) throw new Error(`unexpected TGV show time ${value}`);
  return `${match[1]}T${match[2]}`;
}

function tgvPosterUrl(info) {
  const poster = (info.assets || []).find((asset) => asset?.assetkey === "poster");
  return poster?.extdata?.fileinfo?.fileurl || "";
}

// Google Maps embed links carry the point as "!2d<longitude>!3d<latitude>".
const MAP_POINT_RE = /!2d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/;

function tgvMapPoint(dayCinema) {
  const match = MAP_POINT_RE.exec(dayCinema.extdata?.cinema?.mapurl || "");
  return match ? [floatOrNull(match[2]), floatOrNull(match[1])] : [null, null];
}

export function parseTgvShowtimes(payload, cinema) {
  if (!payload?.success) return [];
  const results = payload.results || {};
  const movies = new Map((results.movies || []).map((m) => [m.recid, m]));
  const shows = [];
  for (const dayCinema of results.businessday?.cinemas || []) {
    const [latitude, longitude] = tgvMapPoint(dayCinema);
    for (const movie of dayCinema.movies || []) {
      // TGV sometimes lists sessions for a film it sends no details for (no name, poster or
      // booking page); there is nothing to show or book, so skip them.
      const info = movies.get(movie.movieid);
      if (!info?.name) continue;
      const movieinfo = info.extdata?.movieinfo || {};
      const title = info.name;
      const bookingUrl = info.itemkey ? `${TGV.movieUrl}/${info.itemkey}` : "";
      const posterUrl = tgvPosterUrl(info);
      const infoUrl = info.itemkey ? `${TGV.infoUrl}/${info.itemkey}` : "";
      const subtitles = "subtitlelang" in movieinfo ? normalizeSubtitles(movieinfo.subtitlelang) : null;
      for (const experience of movie.experiences || []) {
        for (const session of experience.sessions || []) {
          shows.push(
            makeShowtime({
              chain: TGV.chain,
              cinema_id: cinema.cinema_id,
              cinema_name: cinema.name,
              region: cinema.region,
              movie_title: title,
              start: tgvStart(session.showtimemy),
              business_date: String(session.businessdate).slice(0, 10),
              experience: (session.experience || "").toUpperCase(),
              hall: session.screenname || "",
              duration_mins: intOrNull(movieinfo.runtimemins),
              rating: String(movieinfo.rating || ""),
              language: movieinfo.lang || "",
              genres: movieinfo.genre || [],
              tags: Array.isArray(info.extdata?.tags) ? info.extdata.tags : info.extdata?.tags ? [info.extdata.tags] : [],
              booking_url: bookingUrl,
              poster_url: posterUrl,
              subtitles,
              info_url: infoUrl,
              latitude,
              longitude,
            }),
          );
        }
      }
    }
  }
  return shows;
}

/**
 * The TGV session id of a show, from a moviesession_get payload, or "" when it isn't listed.
 * Shows don't carry ids (the snapshot leaves them out), so they're matched by start and hall.
 */
export function findTgvSession(payload, show) {
  return String(findTgvSessionDetails(payload, show)?.sessionid || "");
}

function findTgvSessionDetails(payload, show) {
  let fallback = null;
  for (const dayCinema of payload?.results?.businessday?.cinemas || []) {
    for (const movie of dayCinema.movies || []) {
      for (const experience of movie.experiences || []) {
        for (const session of experience.sessions || []) {
          if (tgvStart(session.showtimemy) !== show.start || (session.screenname || "") !== show.hall) continue;
          if ((session.experience || "").toUpperCase() === show.experience) return session;
          fallback ||= session;
        }
      }
    }
  }
  return fallback;
}

// TGV's seat statuses (Vista): 0 empty, 1 sold, 2 house, 3 special, 4 reserved, 5 unavailable,
// 6 placeholder (no seat), 7 companion, 8 wheelchair-friendly.
const SEAT_STATE = { 0: "free", 1: "sold", 7: "free", 8: "free" };

/**
 * A TGV seat plan as rows of cells, laid out the way TGV draws it: screen side first, and
 * mirrored left to right (both reversed from the API's order).
 * Returns { rows: [{ label, seats: [null | { number, state, pair }] }], free, total }.
 */
export function parseTgvSeatPlan(payload) {
  const areas = payload?.results?.seatlayout?.areas;
  if (!payload?.success || !Array.isArray(areas)) throw new Error("No seat plan for this show");
  // Every area (single, twin, beanie...) uses the same row and column grid, so they merge.
  const grid = new Map(); // rowIndex -> { label, seats: Map(columnIndex -> seat) }
  let columns = 0;
  for (const area of areas) {
    columns = Math.max(columns, area.columnCount || 0);
    for (const row of area.rows || []) {
      for (const seat of row.seats || []) {
        if (!seat?.position || seat.status === 6) continue;
        const { rowIndex, columnIndex } = seat.position;
        columns = Math.max(columns, columnIndex + 1);
        if (!grid.has(rowIndex)) grid.set(rowIndex, { label: "", seats: new Map() });
        const line = grid.get(rowIndex);
        line.label ||= row.physicalName || "";
        line.seats.set(columnIndex, {
          number: `${row.physicalName || ""}${seat.id ?? ""}`,
          state: SEAT_STATE[seat.status] || "blocked",
          pair: (seat.seatsInGroup?.length || 0) > 1,
          category: String(area.areaCategoryCode || ""),
          categoryName: ({ SINGLE: "Normal", TWIN: "Twin" })[area.description] || area.description || "",
          oku: seat.status === 8, // wheelchair space
        });
      }
    }
  }
  const used = [...grid.values()].flatMap((line) => [...line.seats.keys()]);
  const first = Math.min(...used);
  const last = Math.max(...used);
  const indexes = [...grid.keys()];
  const rows = [];
  // Gaps between rows (aisles) stay as empty rows; nothing is drawn outside the seats.
  for (let r = Math.max(...indexes); r >= Math.min(...indexes); r--) {
    const line = grid.get(r);
    const seats = [];
    for (let c = last; c >= first; c--) seats.push(line?.seats.get(c) || null);
    rows.push({ label: line?.label || "", seats });
  }
  const all = rows.flatMap((row) => row.seats).filter(Boolean);
  return { rows, free: all.filter((s) => s.state === "free").length, total: all.length };
}

// Ticket amounts already include tax; tax fields are a breakdown, not an extra charge.
const enabled = (value) => value === true || value === 1 || value === "1" || value === "true";

export function parseTgvPrices(payload) {
  if (!payload?.success) return [];
  return (payload.results?.tickets || []).flatMap((ticket) => {
    const amount = floatOrNull(ticket.priceInCents);
    if (enabled(ticket.isChildOnlyTicket) || enabled(ticket.isComplimentaryTicket) || amount === null || amount <= 0) return [];
    return [{ category: String(ticket.areaCategoryCode || ""), label: ticket.description || ticket.longDescription || "Ticket", amount: amount / 100, seatsTaken: /TWIN/i.test(ticket.description || "") ? 2 : 1 }];
  });
}

export function parseGscPrices(xmlText, parseXml = domParseXml) {
  const root = parseXml(xmlText);
  const data = [...root.getElementsByTagName("ticketdata")].find((node) => attr(node, "code") === "0");
  if (!data) return [];
  return [...data.getElementsByTagName("ticket")].flatMap((ticket) => {
    const amount = floatOrNull(attr(ticket, "price"));
    const label = attr(ticket, "type");
    if (enabled(attr(ticket, "hide_epay")) || /child|complimentary/i.test(label) || amount === null || amount <= 0) return [];
    return [{ category: attr(ticket, "seatcategory"), label, amount, seatsTaken: intOrNull(attr(ticket, "seats_taken")) || 1 }];
  });
}

// ---------------------------------------------------------------------------- network

export const REQUEST_TIMEOUT_MS = 20000;

async function request(fetchImpl, url, init = {}, signal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err?.name === "AbortError") throw new Error("timed out");
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// The seat map first looks up the show's id in that cinema's day of showtimes. Holding several
// times at one cinema reuses that list for a while, for both seats and ticket prices.
const SEAT_LOOKUP_TTL_MS = 2 * 60 * 1000;

/**
 * The two chains, each with fetchCinemas(), fetchShowtimes(cinema, isoDate) and
 * fetchSeatPlan(show) and fetchSeatPrices(show) for the live seat map.
 */
export function createProviders({
  fetch: fetchImpl = globalThis.fetch.bind(globalThis),
  parseXml = domParseXml,
  now = () => Date.now(),
} = {}) {
  const lookups = new Map(); // url + body -> { t, value: Promise }
  const lookup = (url, init, read, signal) => {
    const key = `${url} ${init.body || ""}`;
    const hit = lookups.get(key);
    if (hit && now() - hit.t < SEAT_LOOKUP_TTL_MS) return hit.value;
    const value = request(fetchImpl, url, init, signal).then(read);
    value.catch(() => lookups.delete(key)); // a failure isn't remembered
    lookups.set(key, { t: now(), value });
    return value;
  };
  return {
    GSC: {
      async fetchCinemas(signal) {
        const res = await request(fetchImpl, GSC.locationsUrl, {}, signal);
        return parseGscCinemas(await res.json());
      },
      async fetchShowtimes(cinema, day, signal) {
        const params = new URLSearchParams({
          locationid: cinema.cinema_id,
          oprndate: day,
          hallGroup: cinema.hall_group || "",
        });
        const res = await request(fetchImpl, `${GSC.showtimesUrl}?${params}`, {}, signal);
        return parseGscShowtimes(await res.text(), cinema, parseXml);
      },
      async fetchSeatPrices(show, signal) {
        const params = new URLSearchParams({ locationid: show.cinema_id, oprndate: show.business_date, hallGroup: show.hall_group || "" });
        const xml = await lookup(`${GSC.showtimesUrl}?${params}`, {}, (res) => res.text(), signal);
        const hall = findGscHall(xml, show, parseXml);
        if (!hall?.filmid) return [];
        const prices = new URLSearchParams({ locationid: show.cinema_id, hallid: hall.hid, filmid: hall.filmid, showdate: hall.date, showtime: hall.time });
        const res = await request(fetchImpl, `${GSC.pricesUrl}?${prices}`, {}, signal);
        return parseGscPrices(await res.text(), parseXml);
      },
      /** The live seat plan of one show (needs show.hall_group for premium halls). */
      async fetchSeatPlan(show, signal) {
        const params = new URLSearchParams({ locationid: show.cinema_id, oprndate: show.business_date, hallGroup: show.hall_group || "" });
        const xml = await lookup(`${GSC.showtimesUrl}?${params}`, {}, (res) => res.text(), signal);
        const hall = findGscHall(xml, show, parseXml);
        if (!hall) throw new Error("This show is no longer listed");
        const seats = new URLSearchParams({ locationid: show.cinema_id, hallid: hall.hid, showdate: hall.date, showtime: hall.time });
        const res = await request(fetchImpl, `${GSC.seatsUrl}?${seats}`, {}, signal);
        return parseGscSeatPlan(await res.text(), parseXml);
      },
    },
    TGV: {
      async fetchCinemas(signal) {
        const res = await request(fetchImpl, TGV.statesUrl, {}, signal);
        return parseTgvCinemas(await res.json());
      },
      async fetchShowtimes(cinema, day, signal) {
        const res = await request(
          fetchImpl,
          TGV.sessionsUrl,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cinemaid: cinema.cinema_id, businessdate: day }),
          },
          signal,
        );
        return parseTgvShowtimes(await res.json(), cinema);
      },
      async fetchSeatPrices(show, signal) {
        const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const sessions = await lookup(TGV.sessionsUrl, post({ cinemaid: show.cinema_id, businessdate: show.business_date }), (res) => res.json(), signal);
        const session = findTgvSessionDetails(sessions, show);
        const codes = [...new Set(session?.extdata?.areacategorycodes || [])];
        const prices = await Promise.all(codes.map(async (code) => {
          try {
            const res = await request(fetchImpl, TGV.pricesUrl, post({ cinemaid: show.cinema_id, sessionid: String(session.sessionid), areacategorycodes: String(code), req: {} }), signal);
            return parseTgvPrices(await res.json());
          } catch {
            return []; // one unavailable area must not hide the others
          }
        }));
        return prices.flat();
      },
      /** The live seat plan of one show: finds its session, then asks for the plan. */
      async fetchSeatPlan(show, signal) {
        const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const sessions = await lookup(TGV.sessionsUrl, post({ cinemaid: show.cinema_id, businessdate: show.business_date }), (res) => res.json(), signal);
        const sessionid = findTgvSession(sessions, show);
        if (!sessionid) throw new Error("This show is no longer listed");
        const plan = await request(fetchImpl, TGV.seatPlanUrl, post({ cinemaid: show.cinema_id, sessionid }), signal);
        return parseTgvSeatPlan(await plan.json());
      },
    },
  };
}
