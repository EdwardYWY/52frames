"""Watch for European Film Festival (EUFF) news and TGV ticket sales, and send alerts.

Run on a schedule (see .github/workflows/festival-watch.yml):

    python3 -m cinema_showtimes.festival_watch --state festival-state.json

What it checks on each run:

1. TGV's festival movie list (``movielist-film-festival``). TGV already created it; it is empty
   until the films are published. Any new film in it is an alert.
2. Every TGV movie list (Now Showing, Coming Soon, Special, ... and any list TGV adds later) for
   a film whose title or synopsis mentions the European Film Festival / EUFF, and any new list
   whose name mentions a film festival.
3. For each festival film found, whether TGV has published booking dates: that means tickets are
   on sale, the most urgent alert.
4. TGV's own news items, and Google News, for European Film Festival news in Malaysia.

State (what was already seen) is kept in a JSON file so each thing is alerted once.

Alerts go to every channel that is configured through environment variables:

- ``NTFY_TOPIC``: push notification to the ntfy app (https://ntfy.sh), phone or desktop.
  ``NTFY_SERVER`` overrides the server (default https://ntfy.sh).
- ``CALLMEBOT_TELEGRAM_USER``: a Telegram voice call through CallMeBot, for tickets-open alerts
  only (your Telegram @username, after authorising the bot once).
- ``GITHUB_TOKEN`` + ``GITHUB_REPOSITORY``: a GitHub issue per alert (GitHub app push / email).

Instagram is not checked: it does not allow reading profiles without logging in. Turn on post
notifications for those accounts in the Instagram app instead.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

from . import http

API = "https://api.tgv.com.my/api"
MOVIE_LISTS_URL = f"{API}/movies/v1/movielist/getmoviepagemovielist"
MOVIE_LIST_URL = f"{API}/movies/v1/movielist/{{key}}"
BUSINESS_DATES_URL = f"{API}/boxoffice/v1/moviesession_getsessionbusinessdates"
NEWS_URL = f"{API}/news/v1/getnewsitems"
MOVIE_PAGE = "https://www.tgv.com.my/movies/details/{key}"
NEWS_PAGE = "https://www.tgv.com.my/news"

# TGV's festival list. It exists (the API answers "Items not found!!" instead of "Item not
# found!") but has no published films yet.
FESTIVAL_LIST_KEY = "movielist-film-festival"

GOOGLE_NEWS_QUERIES = (
    "EUFF26",
    '"European Film Festival" Malaysia',
    '"EU Film Festival" Malaysia',
    "EUFF Malaysia",
    '"European Film Festival" TGV',
)
GOOGLE_NEWS_URL = "https://news.google.com/rss/search"
# Ignore news older than this, so the first run doesn't alert on past editions.
NEWS_MAX_AGE = timedelta(days=45)

# A film or news item is about the festival if it says so plainly. A bare "festival" is not
# enough (e.g. TGV synopses mention the Hungry Ghost Festival).
FESTIVAL_RE = re.compile(
    # "EUFF", "EUFF26", "EUFF 26", "(EUFF2026)" but not words that merely contain "euff".
    r"europ\w*\s+(union\s+)?film\s+fest|\bEU\s+film\s+fest|\bEUFF(\s*(20)?\d\d)?\b",
    re.IGNORECASE,
)
FESTIVAL_LIST_RE = re.compile(r"festival|europ|euff", re.IGNORECASE)
MALAYSIA_RE = re.compile(
    r"malaysia|kuala lumpur|\bKL\b|penang|kuching|johor|selangor|\bTGV\b|\bGSC\b",
    re.IGNORECASE,
)

# Alert after this many runs in a row where TGV could not be reached (about 2 hours at 10 min).
FAILURE_ALERT_AFTER = 12

Fetch = Callable[[str], object]
Post = Callable[[str, dict], object]


@dataclass
class Alert:
    key: str  # unique; the same key is never alerted twice
    title: str
    body: str
    url: str = ""
    urgent: bool = False  # tickets on sale: loudest channel (phone call)


@dataclass
class State:
    seen: dict[str, str] = field(default_factory=dict)  # alert key -> ISO time first alerted
    known_lists: list[str] = field(default_factory=list)
    festival_movies: dict[str, dict] = field(default_factory=dict)  # itemkey -> {name, recid}
    tgv_failures: int = 0
    initialised: bool = False

    @classmethod
    def load(cls, path: Path) -> State:
        if not path.exists():
            return cls()
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})

    def save(self, path: Path) -> None:
        path.write_text(json.dumps(self.__dict__, indent=2, ensure_ascii=False), encoding="utf-8")


def _strip_html(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text or "")).strip()


def _movie_text(movie: dict) -> str:
    """Title plus synopsis/description, for keyword matching."""
    extdata = movie.get("extdata") or {}
    movieinfo = extdata.get("movieinfo") or {}
    parts = [movie.get("name", ""), movie.get("itemkey", "")]
    for key in ("synopsis", "description", "shortdesc", "tagline"):
        value = movieinfo.get(key) or extdata.get(key) or movie.get(key)
        if isinstance(value, str):
            parts.append(_strip_html(value))
    tags = extdata.get("tags")
    if isinstance(tags, list):
        parts.extend(str(t) for t in tags)
    elif isinstance(tags, str):
        parts.append(tags)
    return " ".join(parts)


def is_festival_movie(movie: dict) -> bool:
    return bool(FESTIVAL_RE.search(_movie_text(movie)))


def _get_list(fetch: Fetch, key: str) -> list[dict] | None:
    """Movies in a TGV list, [] for a list with nothing published, None if the request failed."""
    payload = fetch(MOVIE_LIST_URL.format(key=urllib.parse.quote(key)))
    if not isinstance(payload, dict):
        return None
    if not payload.get("success"):
        # "Item(s) not found" = empty or unpublished list, which is a valid answer.
        error = payload.get("error") or {}
        return [] if error.get("code") == "inv.itemkey" else None
    return (payload.get("results") or {}).get("movies") or []


def check_tgv_movies(fetch: Fetch, post: Post, state: State) -> list[Alert]:
    alerts: list[Alert] = []
    lists_payload = fetch(MOVIE_LISTS_URL)
    if not isinstance(lists_payload, dict) or not lists_payload.get("success"):
        raise RuntimeError("TGV movie lists unavailable")
    list_info = (lists_payload.get("results") or {}).get("movielistinfo") or []
    list_names = {item["key"]: item.get("name", item["key"]) for item in list_info if "key" in item}

    # New list tabs on TGV's movie page (e.g. a "EUROPEAN FILM FESTIVAL" tab).
    for key, name in list_names.items():
        if key not in state.known_lists and state.initialised and FESTIVAL_LIST_RE.search(
            f"{key} {name}"
        ):
            alerts.append(
                Alert(
                    key=f"tgv-list:{key}",
                    title=f"TGV added a '{name}' movie list",
                    body=f"A new list '{name}' appeared on TGV's movies page.",
                    url="https://www.tgv.com.my/movies",
                )
            )
    state.known_lists = sorted(set(state.known_lists) | set(list_names))

    candidates: dict[str, dict] = {}
    keys = [FESTIVAL_LIST_KEY, *[k for k in list_names if k != FESTIVAL_LIST_KEY]]
    for key in keys:
        movies = _get_list(fetch, key)
        if movies is None:
            if key == FESTIVAL_LIST_KEY:
                raise RuntimeError(f"TGV list {key} unavailable")
            continue
        in_festival_list = key == FESTIVAL_LIST_KEY or bool(
            FESTIVAL_LIST_RE.search(f"{key} {list_names.get(key, '')}")
        )
        for movie in movies:
            if not movie.get("itemkey"):
                continue
            if in_festival_list or is_festival_movie(movie):
                candidates.setdefault(movie["itemkey"], movie)

    for itemkey, movie in candidates.items():
        name = (movie.get("name") or itemkey).strip()
        if itemkey not in state.festival_movies:
            state.festival_movies[itemkey] = {"name": name, "recid": movie.get("recid", "")}
            alerts.append(
                Alert(
                    key=f"tgv-movie:{itemkey}",
                    title=f"EUFF on TGV: '{name}' listed",
                    body=f"TGV published a festival film: {name}. Tickets not on sale yet.",
                    url=MOVIE_PAGE.format(key=itemkey),
                )
            )

    # Tickets on sale = TGV has published booking dates for the film.
    for itemkey, info in state.festival_movies.items():
        dates = booking_dates(post, info.get("recid") or itemkey)
        if dates:
            alerts.append(
                Alert(
                    key=f"tgv-tickets:{itemkey}",
                    title=f"TICKETS OPEN on TGV: {info['name']}",
                    body=(
                        f"Booking is open for {info['name']} on TGV, "
                        f"dates {dates[0]} to {dates[-1]}. Book now."
                    ),
                    url=MOVIE_PAGE.format(key=itemkey),
                    urgent=True,
                )
            )
    return alerts


def booking_dates(post: Post, movie_id: str) -> list[str]:
    try:
        payload = post(BUSINESS_DATES_URL, {"movieid": movie_id, "cinemaid": "", "experience": ""})
    except Exception as exc:  # noqa: BLE001 - one film failing shouldn't stop the others
        print(f"warning: booking dates for {movie_id}: {exc}", file=sys.stderr)
        return []
    if not isinstance(payload, dict) or not payload.get("success"):
        return []
    return sorted((payload.get("results") or {}).get("businessdates") or [])


def check_tgv_news(post: Post) -> list[Alert]:
    payload = post(NEWS_URL, {"startrowindex": 0, "maxrows": 100})
    alerts = []
    for item in ((payload or {}).get("results") or {}).get("newstabitems") or []:
        text = f"{item.get('name', '')} {_strip_html(json.dumps(item.get('extdata') or {}))}"
        if FESTIVAL_RE.search(text):
            alerts.append(
                Alert(
                    key=f"tgv-news:{item.get('itemkey') or item.get('recid')}",
                    title=f"TGV news: {item.get('name', '').strip()}",
                    body="TGV posted European Film Festival news.",
                    url=NEWS_PAGE,
                )
            )
    return alerts


def parse_google_news(xml_text: str, now: datetime) -> list[Alert]:
    alerts = []
    root = ET.fromstring(xml_text)
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        description = _strip_html(item.findtext("description") or "")
        try:
            published = parsedate_to_datetime(item.findtext("pubDate") or "")
        except (TypeError, ValueError):
            continue
        if published.tzinfo is None:
            published = published.replace(tzinfo=timezone.utc)
        if now - published > NEWS_MAX_AGE:
            continue
        text = f"{title} {description}"
        if not (FESTIVAL_RE.search(text) and MALAYSIA_RE.search(text)):
            continue
        guid = (item.findtext("guid") or link or title).strip()
        alerts.append(
            Alert(
                key=f"news:{guid}",
                title=f"News: {title}",
                body=f"Published {published:%d %b %Y}.",
                url=link,
            )
        )
    return alerts


def check_google_news(get_text: Callable[[str], str], now: datetime) -> list[Alert]:
    alerts: dict[str, Alert] = {}
    for query in GOOGLE_NEWS_QUERIES:
        params = urllib.parse.urlencode({"q": query, "hl": "en-MY", "gl": "MY", "ceid": "MY:en"})
        try:
            xml_text = get_text(f"{GOOGLE_NEWS_URL}?{params}")
        except Exception as exc:  # noqa: BLE001
            print(f"warning: Google News '{query}': {exc}", file=sys.stderr)
            continue
        for alert in parse_google_news(xml_text, now):
            alerts.setdefault(alert.key, alert)
    return list(alerts.values())


def run_checks(
    state: State,
    fetch: Fetch = http.get_json,
    post: Post = http.post_json,
    get_text: Callable[[str], str] = http.get_text,
    now: datetime | None = None,
) -> list[Alert]:
    """Run every check and return the alerts not sent before (marking them as seen)."""
    now = now or datetime.now(timezone.utc)
    found: list[Alert] = []
    try:
        found += check_tgv_movies(fetch, post, state)
        state.tgv_failures = 0
    except Exception as exc:  # noqa: BLE001
        state.tgv_failures += 1
        print(f"warning: TGV movies ({state.tgv_failures} in a row): {exc}", file=sys.stderr)
        if state.tgv_failures == FAILURE_ALERT_AFTER:
            found.append(
                Alert(
                    key=f"tgv-down:{now:%Y-%m-%dT%H}",
                    title="Festival watch can't reach TGV",
                    body=f"TGV's API failed {FAILURE_ALERT_AFTER} checks in a row: {exc}",
                    url="https://www.tgv.com.my/movies",
                )
            )
    try:
        found += check_tgv_news(post)
    except Exception as exc:  # noqa: BLE001
        print(f"warning: TGV news: {exc}", file=sys.stderr)
    found += check_google_news(get_text, now)

    new = [a for a in found if a.key not in state.seen]
    for alert in new:
        state.seen[alert.key] = now.isoformat(timespec="seconds")
    if not state.initialised:
        # First run: remember what already exists, but still alert on festival films and
        # open tickets (those are new to the user either way). Skip old news and lists.
        new = [a for a in new if a.key.startswith(("tgv-movie:", "tgv-tickets:"))]
        state.initialised = True
    return new


# --- Notification channels -------------------------------------------------------------------


def _request(url: str, data: bytes | None = None, headers: dict | None = None, method="GET"):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=20) as response:
        return response.read()


def ntfy_message(alert: Alert, topic: str) -> dict:
    """ntfy's JSON publish format (UTF-8 safe, unlike its header format)."""
    message = {
        "topic": topic,
        "title": alert.title,
        "message": alert.body,
        "priority": 5 if alert.urgent else 4,  # 5 = urgent: long vibration, pop-over
        "tags": ["rotating_light", "ticket"] if alert.urgent else ["clapper"],
    }
    if alert.url:
        message["click"] = alert.url
        message["actions"] = [{"action": "view", "label": "Open", "url": alert.url}]
    return message


def send_ntfy(alert: Alert, topic: str, server: str = "https://ntfy.sh") -> None:
    body = json.dumps(ntfy_message(alert, topic)).encode("utf-8")
    _request(server.rstrip("/"), body, {"Content-Type": "application/json"}, "POST")


def send_callmebot_call(alert: Alert, telegram_user: str) -> None:
    user = telegram_user if telegram_user.startswith("@") else f"@{telegram_user}"
    params = urllib.parse.urlencode(
        {"user": user, "text": alert.title, "lang": "en-GB-Standard-B", "rpt": 2}
    )
    _request(f"https://api.callmebot.com/start.php?{params}")


def send_github_issue(alert: Alert, token: str, repo: str) -> None:
    body = f"{alert.body}\n\n{alert.url}\n\n_Opened by the festival watch workflow._"
    payload = {"title": alert.title, "body": body}
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "festival-watch",
    }
    url = f"https://api.github.com/repos/{repo}/issues"
    _request(url, json.dumps(payload).encode(), headers, "POST")


def notify(alerts: list[Alert], env: dict[str, str] | None = None) -> list[Alert]:
    """Send each alert to every configured channel. Returns the alerts no channel delivered."""
    env = os.environ if env is None else env
    undelivered: list[Alert] = []
    channels: list[tuple[str, Callable[[Alert], None], bool]] = []
    if env.get("NTFY_TOPIC"):
        server = env.get("NTFY_SERVER") or "https://ntfy.sh"
        channels.append(("ntfy", lambda a: send_ntfy(a, env["NTFY_TOPIC"], server), False))
    if env.get("CALLMEBOT_TELEGRAM_USER"):
        user = env["CALLMEBOT_TELEGRAM_USER"]
        channels.append(("call", lambda a: send_callmebot_call(a, user), True))
    issues_on = env.get("FESTIVAL_ISSUES") != "0"
    if env.get("GITHUB_TOKEN") and env.get("GITHUB_REPOSITORY") and issues_on:
        token, repo = env["GITHUB_TOKEN"], env["GITHUB_REPOSITORY"]
        channels.append(("github", lambda a: send_github_issue(a, token, repo), False))
    if not channels:
        print("warning: no notification channel configured (set NTFY_TOPIC)", file=sys.stderr)
    for alert in alerts:
        print(f"ALERT: {alert.title} | {alert.body} | {alert.url}")
        delivered = False
        for name, send, urgent_only in channels:
            if urgent_only and not alert.urgent:
                continue
            try:
                send(alert)
                delivered = True
            except Exception as exc:  # noqa: BLE001
                print(f"error: {name} failed for '{alert.title}': {exc}", file=sys.stderr)
        if not delivered:
            undelivered.append(alert)
    return undelivered


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--state", default="festival-state.json", type=Path)
    parser.add_argument("--dry-run", action="store_true", help="print alerts, send nothing")
    parser.add_argument("--test-alert", action="store_true", help="send one test alert and exit")
    args = parser.parse_args(argv)

    if args.test_alert:
        alert = Alert(
            key="test",
            title="Festival watch test alert",
            body="Notifications work. You'll hear from this when EUFF tickets open on TGV.",
            url="https://www.tgv.com.my/movies",
            urgent=True,
        )
        return 1 if notify([alert]) else 0

    state = State.load(args.state)
    alerts = run_checks(state)
    if args.dry_run:
        for alert in alerts:
            urgent = " (URGENT)" if alert.urgent else ""
            print(f"ALERT{urgent}: {alert.title} | {alert.body} | {alert.url}")
        undelivered: list[Alert] = []
    else:
        undelivered = notify(alerts)
        # Try these again on the next run instead of losing them.
        for alert in undelivered:
            state.seen.pop(alert.key, None)
    state.save(args.state)
    print(
        f"checked: {len(state.festival_movies)} festival film(s) known, "
        f"{len(alerts)} new alert(s), {len(undelivered)} undelivered"
    )
    return 1 if undelivered else 0


if __name__ == "__main__":
    sys.exit(main())
