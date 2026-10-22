// Chain-neutral helpers shared by the GSC and TGV parsers.
// Mirrors cinema_showtimes/models.py: keep the two in sync.

// Common regions both chains are mapped onto.
export const REGIONS = ["Klang Valley", "Northern", "Southern", "East Coast", "East Malaysia"];

const NON_ALNUM_RE = /[^a-z0-9]+/g;
const TAG_RE = /[([][^)\]]*[)\]]/g;
// Bracket tags that name the same movie, so they are dropped from the key; every other tag
// ("(SPECIAL)", "(GUARANTEED POSTER)", "[REBROADCAST]") is a different screening and stays in it.
// Compared without case, spaces or punctuation. Keep in sync with cinema_showtimes/models.py.
const SAME_MOVIE_TAGS = new Set([
  // Screen formats
  "imax", "bed", "infinityvision",
  // Language versions ("Jailer 2 (Tamil)")
  "tamil", "hindi",
  // Original-language titles ("(KINOFF26) Hello Betty (Hallo Betty)")
  "gelbebriefe", "hallobetty", "wilmawillmehr", "zirkuskind",
  // Part of the title ("EXO PLANET #6 - EXhOrizon [dot] in CINEMAS")
  "dot",
]);
const YEAR_TAG_RE = /^(19|20)[0-9]{2}$/; // "Terbang (2026)"

const isSameMovieTag = (tag) => {
  const key = tag.slice(1, -1).toLowerCase().replace(NON_ALNUM_RE, "");
  return SAME_MOVIE_TAGS.has(key) || YEAR_TAG_RE.test(key);
};
// The characters Python's str.split() treats as whitespace.
const PY_WHITESPACE_RE = new RegExp(
  "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+",
);

const isLatinWord = (word) => [...word].every((ch) => ch.codePointAt(0) <= 0x24f);

/**
 * Reduce a movie title to a key that matches across chains.
 * Drops same-movie tags ("(IMAX)", "(Tamil)"), non-Latin words (TGV appends Chinese and Tamil
 * titles), case and punctuation, so "(IMAX) Jailer 2" (GSC) and "Jailer 2" (TGV) group together.
 * Other tags are kept as words, so "(SPECIAL) Clayface" is its own movie.
 */
export function normalizeTitle(title) {
  return titleKey(String(title).replace(TAG_RE, (tag) => (isSameMovieTag(tag) ? " " : ` ${tag.slice(1, -1)} `)));
}

/** The title with every tag dropped: "(FAN SCREENING) Godzilla Minus Zero" -> "godzilla minus zero". */
export function untaggedTitle(title) {
  return titleKey(String(title).replace(TAG_RE, " "));
}

function titleKey(text) {
  const withoutTags = text.toLowerCase();
  const latinWords = withoutTags.split(PY_WHITESPACE_RE).filter((w) => w && isLatinWord(w));
  return latinWords.join(" ").replace(NON_ALNUM_RE, " ").trim();
}

/**
 * One name per language, whichever chain it came from: GSC sends codes ("IND", "BM"), TGV full
 * names ("Bahasa Indonesia"). Movies are grouped by this, so both must map to the same name.
 */
const LANGUAGE_ALIASES = { eng: 'English', english: 'English', tam: 'Tamil', tamil: 'Tamil', hin: 'Hindi', hindi: 'Hindi', chi: 'Chinese', chinese: 'Chinese', man: 'Mandarin', mandarin: 'Mandarin', bm: 'Malay', malay: 'Malay', 'bahasa melayu': 'Malay', ind: 'Bahasa Indonesia', indonesian: 'Bahasa Indonesia', 'bahasa indonesia': 'Bahasa Indonesia', can: 'Cantonese', cantonese: 'Cantonese', tha: 'Thai', thai: 'Thai', tel: 'Telugu', telugu: 'Telugu', mal: 'Malayalam', malayalam: 'Malayalam', jpn: 'Japanese', japanese: 'Japanese', kor: 'Korean', korean: 'Korean' };

export function normalizeLanguage(language) {
  const value = String(language || '').trim();
  return LANGUAGE_ALIASES[value.toLowerCase()] || value;
}

// Shows are never changed once made, so each one's key is worked out once: the page asks for it
// tens of thousands of times per render (a snapshot holds ~20k shows).
const groupKeys = new WeakMap();

export function movieGroupKey(show) {
  let key = groupKeys.get(show);
  if (key === undefined) {
    const language = normalizeLanguage(show.language).toLowerCase();
    key = `${show.movie_key}${language ? `|${language}` : ''}`;
    groupKeys.set(show, key);
  }
  return key;
}

export function normalizeGenres(genres) {
  const aliases = { 'action adventure': ['Action', 'Adventure'], 'drama and romance': ['Drama', 'Romance'] };
  return [...new Set((genres || []).flatMap(label => String(label).split(',').flatMap(part => aliases[part.trim().toLowerCase()] || [part.trim()])).filter(Boolean))];
}

export function makeShowtime(fields) {
  const show = {
    chain: "",
    cinema_id: "",
    cinema_name: "",
    region: "",
    movie_title: "",
    start: "",
    business_date: "",
    experience: "",
    hall: "",
    duration_mins: null,
    rating: "",
    language: "",
    genres: [],
    tags: [],
    sold_out: false,
    booking_url: "",
    poster_url: "",
    poster_small_url: "",
    subtitles: null, // ["BM", "Chinese", ...]; null when unknown
    info_url: "", // the chain's page about the movie
    latitude: null,
    longitude: null,
    movie_key: "",
    ...fields,
  };
  if (!show.movie_key) show.movie_key = normalizeTitle(show.movie_title);
  show.genres = normalizeGenres(show.genres);
  return show;
}

/** Python's int(value) for strings/numbers, or null when it would fail or be empty. */
export function intOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string" && /^\s*[+-]?\d+(_\d+)*\s*$/.test(value)) {
    return parseInt(value.replace(/_/g, ""), 10);
  }
  return null;
}

/** Today's date in Malaysia (UTC+8) as YYYY-MM-DD, whatever the visitor's own time zone. */
export function todayMyt(now = new Date()) {
  return addDays(new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10), 0);
}

export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Python's float(value) when finite, else null. */
export function floatOrNull(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Great-circle distance in km between two {latitude, longitude} points, or null. */
export function distanceKm(a, b) {
  if (a?.latitude == null || a?.longitude == null || b?.latitude == null || b?.longitude == null) return null;
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Both chains name subtitle languages differently ("Bahasa Melayu" vs "BM", "Chinese" vs "CHI").
const SUBTITLE_NAMES = {
  bm: "BM",
  "bahasa melayu": "BM",
  malay: "BM",
  chi: "Chinese",
  chinese: "Chinese",
  eng: "English",
  english: "English",
  tam: "Tamil",
  tamil: "Tamil",
};

export function normalizeSubtitles(names) {
  const out = [];
  for (const raw of names || []) {
    const name = String(raw).trim();
    if (!name || ["-", "NA", "N/A"].includes(name)) continue;
    const label = SUBTITLE_NAMES[name.toLowerCase()] ?? name;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}
