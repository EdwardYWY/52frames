# Cinema Showtimes: GSC + TGV

Check **GSC** (Golden Screen Cinemas) and **TGV Cinemas** showtimes across Malaysia in one place,
on the web, from the command line or in a small local web page.

**Website: <https://edwardywy.github.io/52frames/>** (no server: your browser calls GSC and TGV
directly).

- Pure Python 3.10+ standard library, so there is nothing to `pip install`.
- Same movie from both chains is grouped together (e.g. GSC "(IMAX) Jailer 2" and TGV
  "Jailer 2 (Tamil)"). Only whitelisted title tags are ignored (formats, language versions,
  years, original titles: `SAME_MOVIE_TAGS` in `site/js/models.js` and
  `cinema_showtimes/models.py`). Special screenings like "(GUARANTEED POSTER)" or "(SPECIAL)" keep
  their own card.
- Both chains are mapped onto the same regions: Klang Valley, Northern, Southern, East Coast,
  East Malaysia.
- If one chain or cinema fails to respond, the rest still load, and you get a warning.

## Command line

Run from the repository root (or `pip install .` to get a `cinema-showtimes` command):

```bash
# Today, every cinema in Klang Valley, both chains
python3 -m cinema_showtimes --region "klang valley"

# Tomorrow, one movie, evening shows only
python3 -m cinema_showtimes --date tomorrow --region "klang valley" --movie jailer --after 19:00

# A specific mall, TGV only, a specific date
python3 -m cinema_showtimes --date 2026-10-18 --cinema pavilion --chain tgv

# JSON output (for scripts)
python3 -m cinema_showtimes --cinema "1 utama" --json

# List cinemas
python3 -m cinema_showtimes cinemas --region southern
```

Example output:

```
Showtimes for Thu 15 Oct 2026

Go For Broke 2  (132 min · 18 · MAN)
  GSC  Petaling Jaya - 1 Utama (New Wing)  15:00 2D, 22:15 2D
  TGV  TGV 1 Utama                         18:00 JUNIOR-HOTWHEEL
```

| Option | Meaning |
|---|---|
| `--date` | `today` (default), `tomorrow`, `+N` days, or `YYYY-MM-DD` |
| `--region` | Region substring: `klang valley`, `northern`, `southern`, `east coast`, `east malaysia` |
| `--cinema` | Cinema name substring, e.g. `mid valley`, `pavilion` |
| `--movie` | Movie title substring |
| `--chain` | `gsc` or `tgv` (repeatable; default both) |
| `--after` | Only shows starting at/after `HH:MM` (after-midnight shows are kept) |
| `--json` | Machine-readable output |

Tip: narrow by `--region` or `--cinema`. Fetching all ~100 cinemas nationwide takes noticeably
longer than one region (about 10 s for Klang Valley).

## Website (GitHub Pages)

<https://edwardywy.github.io/52frames/> is a static page in [`site/`](site/): plain ES modules, no
build step, no dependencies.

- **Movies**: a poster grid across all published booking dates, including advance sales.
  A date strip (All by default) shows only what's on a chosen day.
  Search by title or language ("CAN" or "Cantonese"; `/` focuses search), filter by region
  (All Malaysia by default), cinemas and chain. Concerts are hidden
  by default; the Content checkbox includes them. Musicals stay visible.
  Posters have no overlays or corner decoration; the show count sits below the title, followed by "Showing now"
  or "Next screening" using the booking business date.
  Sort labels remain Most shows, Title A–Z and Earliest show. Earliest show orders today's movies
  A–Z, then future movies by booking date with A–Z ties. Most shows counts all published sessions.
- **Movie view** (tap a poster; the back button or Esc returns to the grid): a pinned header with
  the back button, title and only that movie's available booking dates (including month labels).
  The schedule shows **by time** (the default) or **by cinema**
  (collapsed rows with the next times; starred cinemas first; sort by earliest show, nearest, name
  or most shows); starred cinemas get a star pattern in both. Region (starts from the main page's),
  cinema (several at once, or ★ Starred) and start-time dropdowns stay pinned under the header
  while the schedule scrolls (not on phones); a Top button returns to the top. Each time links to the chain's booking page, where seats are chosen. Sold-out times
  are struck through, started ones dimmed, after-midnight ones marked `+1`.
  Hidden extra: rest the mouse on a showtime for 1.5 seconds (or press and hold it for 1.5 seconds on a
  phone) to see that show's live seat map, fetched from GSC or TGV on the spot; a normal click or tap still books.
- **Subtitles** per chain ("Subtitles (GSC)", "Subtitles (TGV)") with a link to each chain's page
  about the movie; they often differ. TGV lists them in its sessions data. GSC only shows them on
  its public movie pages, so the snapshot job reads those (one page per movie per run; titles are
  matched to GSC's page links by their letters and digits). Pages that don't say show
  "Not listed"; the live fallback has TGV's only.
- **Background** uses a static, seamless contour pattern with wide spacing and 40% line opacity.
  The site is dark only; phones crop rather than shrink the pattern.
  No contour generation or animation runs in the browser.
- **Posters** come from both chains; when both have one, the higher-resolution one is used where
  it matters (GSC's 500 px poster in the movie view) and the browser picks a lighter one for the grid.
- **Cinema names** use GSC's "Town - Mall" style for both chains: TGV's "TGV 1 Utama" shows as
  "Petaling Jaya - 1 Utama" (table `TGV_NAMES` in `site/js/places.js`, mirrored in
  `cinema_showtimes/tgv.py`; a new TGV cinema shows as "<State> - <name>" until it's added there).
  Languages are matched across chains (GSC's "IND" is TGV's "Bahasa Indonesia"), and a session
  TGV lists under two movie entries is shown once.
- **Cinemas** (tab next to Movies): every cinema in the chosen region and chains, with how many
  movies and shows it has on the chosen date. Search by cinema, mall or town; sort by name,
  nearest or most movies; starred cinemas first. The date is shared with the Movies tab.
  A cinema's page lists its movies, each with its times (grouped by day when the date is All);
  a movie's title opens its movie view on that date.
- **Filters in use** show as chips above the results ("GSC only", a cinema, a date…), each with ×
  to remove it, so a narrowed list is never a surprise. The cinema dropdowns have a search box.
- **Location** (optional, top bar): shows the distance to each cinema and enables "Nearest". GSC
  sends cinema coordinates; TGV's are in `site/js/places.js` (looked up once from OpenStreetMap,
  © OpenStreetMap contributors), because TGV's own map links are missing or wrong for many cinemas.
- **Starred cinemas** (top bar → Starred): star or unstar any cinema, clear all. Only the stars
  are kept between visits (this browser's `localStorage`); every other setting starts from its
  default each time. Analytics records feature
  actions without sending the saved star list or precise location.

Live seat maps (the hidden 1.5-second hold) use the chains' public read-only endpoints, with no login:
TGV's `moviesession_getseatplan` and GSC's `getHallSeatStatus`. Shows don't carry the chains' session
or hall ids, so the page first looks the show up in that cinema's day of showtimes (kept for 2
minutes). Seats and ticket prices then load in parallel, using TGV's `moviesession_gettickets`
(one request per area category) or GSC's `getTicketPricingEpaySpecialV5` with the child film code.
The legend shows tax-inclusive prices for the hall's seat categories, with concessions labelled
and pair tickets marked. TGV adds RM 0.50 at checkout. If prices are unavailable, the seats still
appear normally. Nothing is fetched until a hold completes, and an open map isn't refreshed on a timer.

How it works:

1. **Shared snapshot (normal case).** Every 6 hours a GitHub Action (`scripts/snapshot.mjs`)
   discovers movies and available booking dates from both chains, including advance sales.
   GSC sessions are fetched per movie/date; TGV movie dates identify cinema/date pairs, fetched
   once each. Four requests run at a time. Genres and tags are retained in snapshot version 3.
   One compact `data/showtimes.json` serves all visitors; date and region changes need no requests.
   Pushes reuse a compatible, fresh snapshot. A schema change fetches a new one automatically.
   Failed catalogue refreshes do not replace a good snapshot with incomplete data.

2. **Live fallback.** If the snapshot is missing or older than 13 hours, the movie list
   discovers the catalogue live for the selected region and chains. Movie details reuse those
   sessions; a date missing from the snapshot can still load per cinema/date. Failures are shown
   while the remaining results stay available. Session requests are cached for 10 minutes.

The browser fallback uses the chains' public website endpoints and requires their CORS headers.

```
site/
  index.html        the page
  css/style.css
  js/models.js      normalizeTitle, showtime shape, distance (port of models.py)
  js/places.js      TGV cinema coordinates
  js/snapshot.js    the shared snapshot: pack / unpack / load
scripts/
  snapshot.mjs      builds data/showtimes.json (run by the Pages workflow)
  xml.mjs           tiny XML reader for Node (the snapshot script and tests)
  bench-movie-view.mjs  times opening a movie, switching dates and closing it in Chromium
  js/providers.js   GSC + TGV fetch and parse (port of gsc.py / tgv.py); no DOM access
  js/aggregator.js  concurrency limit, sessionStorage cache, filter, group (port of aggregator.py)
  js/app.js         page code: grid, search, movie view, stars, location
  js/seatmap.js     hold a showtime for 1.5 s to see its live seat map
  js/select.js      styled dropdowns over real <select>s (keyboard, screen readers, bottom sheet on phones)
```

`.github/workflows/pages.yml` runs the Python and JavaScript tests on every push and pull request,
deploys `site/` to Pages on pushes to `main`, and rebuilds the snapshot every 6 hours
(00:17, 06:17, 12:17, 18:17 UTC = 08:17, 14:17, 20:17, 02:17 in Malaysia). To refresh it by hand:
Actions → "Deploy site to GitHub Pages" → Run workflow. In the repository settings, **Settings → Pages →
Source** must be **GitHub Actions**.

## Local web page

```bash
python3 -m cinema_showtimes serve            # http://127.0.0.1:8000
python3 -m cinema_showtimes serve --port 9000
```

From a repository checkout this serves the same `site/` page as GitHub Pages (both chains also
accept `localhost` as an origin). When installed with `pip`, `site/` isn't included, so it serves
the older page in `cinema_showtimes/static/`, which uses the server-side API below (cached in
memory for 10 minutes).

JSON endpoints:

- `GET /api/showtimes?date=YYYY-MM-DD&region=...&chain=GSC&chain=TGV&cinema=...&movie=...&after=HH:MM`
- `GET /api/cinemas?region=...&chain=...`
- `GET /api/regions`

## How it works

Both chains' own websites load showtimes from public JSON/XML endpoints, and this tool calls the
same ones:

| Chain | Cinemas | Showtimes |
|---|---|---|
| GSC | `epaymentapi.gsc.com.my/gsc/epay/GetEpaymentLocations` | `.../showtimews/service.asmx/getShowTimesByLocation_ParentChild_V2` (XML, one call per cinema per day) |
| TGV | `api.tgv.com.my/api/cinemas/v1/getstatecinema` | `.../api/boxoffice/v1/moviesession_get` (JSON, one call per cinema per day) |

These are **unofficial, undocumented** endpoints. They can change without notice. If a chain
suddenly returns nothing, its website has probably changed. **There are two parsers for each chain,
and both must be updated:** the Python one (`cinema_showtimes/gsc.py`, `tgv.py`) and the JavaScript
one (`site/js/providers.js`). `tests/js/parity.test.mjs` fails if the two give different results
for the fixtures. Please keep usage personal and light; the caches and the concurrency limit help.

```
cinema_showtimes/
  models.py      Cinema / Showtime dataclasses, title normalisation, regions
  gsc.py         GSC fetch + parse
  tgv.py         TGV fetch + parse
  aggregator.py  concurrent fetching, filtering, grouping by movie
  cli.py         command line
  web.py         local web server + /api endpoints
  static/        fallback web page for pip installs (uses /api/showtimes)
site/            the browser-only web page (GitHub Pages)
tests/           Python tests; tests/js/ has the Node tests for site/js/
```

## Tests

Offline tests run against trimmed real API responses in `tests/fixtures/`:

```bash
python3 -m unittest discover -s tests -t .
# or, if you have pytest:  pytest tests

# JavaScript (Node 22+, built-in test runner, no npm install needed)
node --test "tests/js/*.test.mjs"     # or: npm test
```

The JavaScript tests check the same counts, fields, after-midnight handling and title
normalisation as the Python tests, and `parity.test.mjs` runs the Python parsers on the same fixtures
and compares the output field by field. Node has no `DOMParser`, so the tests pass a small XML reader
(`tests/js/xml.mjs`) to the GSC parser.

To time the movie view in a real browser (needs Playwright, which is not a project dependency),
download a snapshot and run:

```bash
curl -o /tmp/showtimes.json https://edwardywy.github.io/52frames/data/showtimes.json
node scripts/bench-movie-view.mjs --snapshot /tmp/showtimes.json --cpu 4   # 4x slower CPU, like a phone
```

It prints the time until the next frame for each action, split into script, style and layout, and the
functions that took longest (`--profile 0` skips the profiler for cleaner totals; `--group cinema`
times the by-cinema layout).

## Website analytics (GA4)

The published `/52frames/` site uses measurement ID `G-HJQD0PND68`; this is public configuration,
not a secret. No API secret, backend, npm dependency or hosting change is required. Local development
and other hostnames/Pages projects do not load Google. Do Not Track and Global Privacy Control are
honoured. A bounded startup queue preserves early interactions while the optional module loads;
failed imports discard the queue. The asynchronous tag never blocks showtimes; blocked/failed analytics silently stops tracking. A successfully loaded blocker stub also has a
bounded queue; a working Google tag continues processing events normally.

The code denies ad storage, ad user data and ad personalization, disables Google Signals and
advertising personalization, and strips query strings and hashes from the configured page URL and
referrer. Analytics storage is enabled for visit/session measurement; this implementation adds no
consent interface. This does not represent a visitor consent choice. If consent collection is needed
for the intended audience, gate analytics loading on that choice before deployment.

Account settings are separate from website code. In GA Admin, keep **all Account details data-sharing
options off**, including Google products & services and Modeling contributions & business insights.
Keep Google Signals, user-provided data collection and advertising integrations off. These settings
cannot be verified or changed using the measurement ID, and disabling sharing is not a blanket switch
for all AI processing within the Analytics service.

**Before deployment:** turn off the web stream's **Enhanced measurement**. This integration sends one
explicit page view and its own feature events; automatic history/outbound/search measurement is not
needed and could add duplicate events or collect extra URL details. Existing account settings are
not changed by this PR. There is no custom analytics dashboard in the website; use GA4 Reports/Explore.

| Event | Details sent |
|---|---|
| `page_view` | Fixed site title, page URL/referrer without query/hash |
| `movie_open` | Normalized movie key (including language) |
| `search_used` | No search text; counted after an 800 ms pause |
| `filter_change` | Control and option; one event per option toggle, including multi-selects. Cinema filters send only selection/starred, not the list |
| `cinema_star` | Chain and add/remove action, not the saved list |
| `stars_open`, `stars_clear` | No additional details |
| `location_toggle` | Request/off action, never coordinates |
| `booking_click` | Chain and normalized movie key, including middle-clicks; does not indicate a purchase |
| `seat_preview_open`, `seat_preview_loaded`, `seat_preview_failed` | Chain only; no raw error text |

For breakdowns, register event-scoped custom dimensions for `movie`, `chain`, `control`, `value` and
`action` in GA4. Feature events are distinct from page views; movie sheets do not count as additional
page views. Search rendering remains immediate; only its analytics event is debounced.

To verify after publishing, browse the production site and check GA4 Realtime/DebugView and browser
network requests. Local tests validate queued commands and mocked tag loading without sending real
visitor data; they do not prove that the property is receiving production events. To disable analytics,
remove the optional `import("./analytics.js?v=26")` initialization block in `site/js/app.js`. Replace the startup tracking queue with a no-op when removing that block.

Browser regression checks use Playwright installed separately: `node scripts/check-analytics.mjs`.
Set `CHROMIUM_PATH` if using an existing Chromium executable. The checks mock Google and provider
responses, run desktop/mobile scenarios with tracking available, blocked or delayed, and do not send real events.
Mobile booking checks use real touch taps; long holds dispatch touch-pointer events to exercise suppression.

Run the browser regression checks before changing analytics, event wiring or seat-preview behavior.
The Pages workflow runs the Python/JavaScript unit suites; it does not install Playwright or run these browser checks.
