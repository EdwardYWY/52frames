"""Tests for the European Film Festival watcher, with TGV and Google News faked."""

from __future__ import annotations

import unittest
from datetime import datetime, timezone

from cinema_showtimes import festival_watch as fw

NOW = datetime(2026, 11, 7, 12, 0, tzinfo=timezone.utc)

LISTS = {
    "success": True,
    "results": {
        "movielistinfo": [
            {"key": "nowselling", "name": "NOW SHOWING"},
            {"key": "comingsoon", "name": "COMING SOON"},
        ]
    },
}
EMPTY_LIST = {"success": False, "error": {"code": "inv.itemkey", "message": "Items not found!!"}}


def movie(itemkey, name, recid="", synopsis=""):
    return {
        "itemkey": itemkey,
        "name": name,
        "recid": recid or f"rec-{itemkey}",
        "extdata": {"movieinfo": {"synopsis": synopsis}},
    }


def tgv_list(*movies):
    return {"success": True, "results": {"movies": list(movies)}}


class FakeTgv:
    def __init__(self):
        self.lists = {"nowselling": tgv_list(), "comingsoon": tgv_list()}
        self.festival = EMPTY_LIST
        self.list_info = LISTS
        self.booking = {}  # movie id -> dates
        self.news = []

    def fetch(self, url):
        if url == fw.MOVIE_LISTS_URL:
            return self.list_info
        key = url.rsplit("/", 1)[-1]
        if key == fw.FESTIVAL_LIST_KEY:
            return self.festival
        return self.lists.get(key, {"success": False, "error": {"code": "inv.itemkey"}})

    def post(self, url, payload):
        if url == fw.BUSINESS_DATES_URL:
            dates = self.booking.get(payload["movieid"], [])
            return {"success": True, "results": {"businessdates": dates}}
        if url == fw.NEWS_URL:
            return {"success": True, "results": {"newstabitems": self.news}}
        raise AssertionError(url)


def rss(*items):
    body = "".join(
        f"<item><title>{t}</title><link>{link}</link><guid>{link}</guid>"
        f"<pubDate>{date}</pubDate><description>{d}</description></item>"
        for t, link, date, d in items
    )
    return f"<rss><channel>{body}</channel></rss>"


class FestivalWatchTest(unittest.TestCase):
    def setUp(self):
        self.tgv = FakeTgv()
        self.rss = rss()
        self.state = fw.State()

    def run_checks(self):
        return fw.run_checks(
            self.state, self.tgv.fetch, self.tgv.post, lambda url: self.rss, now=NOW
        )

    def test_quiet_while_the_festival_list_is_empty(self):
        self.assertEqual(self.run_checks(), [])
        self.assertEqual(self.run_checks(), [])

    def test_alerts_once_when_films_appear_then_when_tickets_open(self):
        self.run_checks()
        self.tgv.festival = tgv_list(movie("the-shepherd", "The Shepherd", recid="r1"))

        alerts = self.run_checks()
        self.assertEqual([a.key for a in alerts], ["tgv-movie:the-shepherd"])
        self.assertFalse(alerts[0].urgent)
        self.assertEqual(self.run_checks(), [])  # no repeat

        self.tgv.booking["r1"] = ["2026-11-20", "2026-11-21"]
        alerts = self.run_checks()
        self.assertEqual(len(alerts), 1)
        self.assertTrue(alerts[0].urgent)
        self.assertIn("TICKETS OPEN", alerts[0].title)
        self.assertIn("2026-11-20", alerts[0].body)
        self.assertEqual(self.run_checks(), [])

    def test_first_run_still_alerts_if_tickets_are_already_open(self):
        self.tgv.festival = tgv_list(movie("film-a", "Film A", recid="ra"))
        self.tgv.booking["ra"] = ["2026-11-20"]
        keys = {a.key for a in self.run_checks()}
        self.assertEqual(keys, {"tgv-movie:film-a", "tgv-tickets:film-a"})

    def test_finds_festival_films_in_other_lists_by_title_or_synopsis(self):
        self.run_checks()
        self.tgv.lists["comingsoon"] = tgv_list(
            movie("lunar-july", "Lunar July", synopsis="the annual Hungry Ghost Festival"),
            movie("euff-opening", "(EUFF) Opening Night"),
            movie("tatami", "Tatami", synopsis="Screening at the 26th European Film Festival."),
        )
        keys = sorted(a.key for a in self.run_checks())
        self.assertEqual(keys, ["tgv-movie:euff-opening", "tgv-movie:tatami"])

    def test_matches_the_euff26_name(self):
        names = ("EUFF26: The Shepherd", "The Shepherd (EUFF26)", "EUFF 26 Opening", "EUFF2026")
        for name in names:
            self.assertTrue(fw.is_festival_movie(movie("x", name)), name)
        self.assertFalse(fw.is_festival_movie(movie("x", "Reuffle")))

    def test_matches_announced_euff26_titles_by_title_only(self):
        for name, key in (
            ("Silent Friend", "silent-friend"),
            ("FJORD", "fjord-2026"),
            ("Sentimental Value (Norwegian)", "x"),
            ("Untitled", "sentimental-value"),
        ):
            self.assertTrue(fw.is_festival_movie(movie(key, name)), name)
        self.assertFalse(fw.is_festival_movie(movie("x", "Frozen 3", synopsis="a frozen fjord")))
        self.assertFalse(fw.is_festival_movie(movie("x", "Fjords of Norway")))

    def test_announced_title_in_coming_soon_alerts_then_tickets(self):
        self.run_checks()
        self.tgv.lists["comingsoon"] = tgv_list(movie("fjord", "Fjord", recid="rf"))
        self.assertEqual([a.key for a in self.run_checks()], ["tgv-movie:fjord"])
        self.tgv.booking["rf"] = ["2026-11-25"]
        alerts = self.run_checks()
        self.assertEqual([a.key for a in alerts], ["tgv-tickets:fjord"])
        self.assertTrue(alerts[0].urgent)

    def test_alerts_on_a_new_festival_tab_but_not_other_new_tabs(self):
        self.run_checks()
        self.tgv.list_info = {
            "success": True,
            "results": {
                "movielistinfo": LISTS["results"]["movielistinfo"]
                + [
                    {"key": "movielist-kids", "name": "KIDS"},
                    {"key": "movielist-euff", "name": "EUROPEAN FILM FESTIVAL"},
                ]
            },
        }
        self.tgv.lists["movielist-euff"] = tgv_list(movie("film-b", "Film B"))
        keys = sorted(a.key for a in self.run_checks())
        self.assertEqual(keys, ["tgv-list:movielist-euff", "tgv-movie:film-b"])

    def test_news_matches_festival_in_malaysia_and_skips_old_news(self):
        self.run_checks()
        self.rss = rss(
            ("26th European Film Festival opens at TGV", "https://n/1",
             "Thu, 05 Nov 2026 08:00:00 GMT", "Kuala Lumpur"),
            ("European Film Festival in Fiji", "https://n/2", "Thu, 05 Nov 2026 08:00:00 GMT", ""),
            ("24th European Film Fest in Malaysia", "https://n/3",
             "Fri, 06 Oct 2023 07:00:00 GMT", ""),
        )
        self.assertEqual([a.key for a in self.run_checks()], ["news:https://n/1"])

    def test_first_run_does_not_alert_on_existing_news(self):
        self.rss = rss(
            ("EU Film Festival returns to Malaysia", "https://n/1",
             "Thu, 05 Nov 2026 08:00:00 GMT", ""),
        )
        self.assertEqual(self.run_checks(), [])
        self.assertIn("news:https://n/1", self.state.seen)

    def test_tgv_outage_alerts_once_after_repeated_failures(self):
        self.tgv.list_info = None
        alerts = []
        for _ in range(fw.FAILURE_ALERT_AFTER + 3):
            alerts += self.run_checks()
        self.assertEqual(len([a for a in alerts if a.key.startswith("tgv-down")]), 1)

    def test_notify_returns_undelivered_alerts(self):
        alert = fw.Alert(key="k", title="t", body="b")
        self.assertEqual(fw.notify([alert], env={}), [alert])


if __name__ == "__main__":
    unittest.main()
