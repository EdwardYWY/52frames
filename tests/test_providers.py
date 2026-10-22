"""Parser tests for the GSC and TGV providers, using trimmed real API responses."""

from __future__ import annotations

import json
import unittest
from datetime import date, datetime
from pathlib import Path

from cinema_showtimes import gsc, tgv

FIXTURES = Path(__file__).parent / "fixtures"


def _text(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _json(name: str):
    return json.loads(_text(name))


class GscCinemaParsingTest(unittest.TestCase):
    def test_parses_locations_with_region_and_hall_group(self):
        cinemas = gsc.parse_cinemas(_json("gsc_locations.json"))

        self.assertEqual(len(cinemas), 2)
        queensbay, aurum = cinemas
        self.assertEqual(queensbay.chain, "GSC")
        self.assertEqual(queensbay.cinema_id, "120")
        self.assertEqual(queensbay.name, "Penang - Queensbay Mall")
        self.assertEqual(queensbay.region, "Northern")
        self.assertEqual(queensbay.hall_group, "")
        self.assertEqual(aurum.region, "Klang Valley")
        self.assertEqual(aurum.hall_group, "AURUMTRX")
        self.assertEqual((queensbay.latitude, queensbay.longitude), (5.33306, 100.30667))


class GscShowtimeParsingTest(unittest.TestCase):
    def setUp(self):
        self.cinema = gsc.parse_cinemas(_json("gsc_locations.json"))[0]
        self.shows = gsc.parse_showtimes(_text("gsc_showtimes_120.xml"), self.cinema)

    def test_parses_every_show(self):
        self.assertEqual(len(self.shows), 5)

    def test_show_fields(self):
        first = self.shows[0]
        self.assertEqual(first.chain, "GSC")
        self.assertEqual(first.cinema_name, "Penang - Queensbay Mall")
        self.assertEqual(first.region, "Northern")
        self.assertEqual(first.movie_title, "Go For Broke 2")
        self.assertEqual(first.start, datetime(2026, 10, 15, 17, 15))
        self.assertEqual(first.business_date, date(2026, 10, 15))
        self.assertEqual(first.experience, "2D")
        self.assertEqual(first.hall, "Hall 5")
        self.assertEqual(first.duration_mins, 132)
        self.assertEqual(first.rating, "18")
        self.assertEqual(first.language, "MAN")
        self.assertFalse(first.sold_out)
        self.assertIn("showtime-by-movies/6495", first.booking_url)
        self.assertEqual((first.latitude, first.longitude), (5.33306, 100.30667))

    def test_posters_come_from_the_child_film(self):
        first = self.shows[0]
        self.assertEqual(first.poster_url, "https://poster.gsc.com.my/2026/261012_GoForBroke2_big.jpg")
        self.assertEqual(
            first.poster_small_url, "https://poster.gsc.com.my/2026/261012_GoForBroke2_med.jpg"
        )

    def test_after_midnight_show_keeps_business_date(self):
        late = [s for s in self.shows if s.start.day == 16]
        self.assertEqual(len(late), 1)
        self.assertEqual(late[0].start, datetime(2026, 10, 16, 0, 15))
        self.assertEqual(late[0].business_date, date(2026, 10, 15))
        self.assertEqual(late[0].experience, "IMAX")
        self.assertTrue(late[0].sold_out)

    def test_special_screening_tag_stays_in_its_key(self):
        special = [s for s in self.shows if "Good Trip" in s.movie_title]
        self.assertEqual(special[0].movie_title, "(SPECIAL) Good Trip")
        self.assertEqual(special[0].movie_key, "special good trip")

    def test_empty_response_returns_no_shows(self):
        empty = '<?xml version="1.0" encoding="utf-8"?><films><filters /></films>'
        self.assertEqual(gsc.parse_showtimes(empty, self.cinema), [])


class TgvCinemaParsingTest(unittest.TestCase):
    def test_parses_states_skipping_the_all_bucket(self):
        cinemas = tgv.parse_cinemas(_json("tgv_states.json"))

        self.assertEqual([c.cinema_id for c in cinemas], ["PKL", "BI0"])
        pkl, bukit_indah = cinemas
        self.assertEqual(pkl.chain, "TGV")
        self.assertEqual(pkl.name, "Kuala Lumpur - Pavilion Kuala Lumpur")
        self.assertEqual(pkl.region, "Klang Valley")
        self.assertEqual(pkl.state, "Klang Valley")
        self.assertEqual(bukit_indah.name, "Johor Bahru - AEON Bukit Indah")
        self.assertEqual(bukit_indah.region, "Southern")
        self.assertEqual(bukit_indah.state, "Johor")


class TgvShowtimeParsingTest(unittest.TestCase):
    def setUp(self):
        self.cinema = tgv.parse_cinemas(_json("tgv_states.json"))[0]
        self.shows = tgv.parse_showtimes(_json("tgv_sessions_PKL.json"), self.cinema)

    def test_parses_every_session(self):
        self.assertEqual(len(self.shows), 9)

    def test_show_fields(self):
        indulge = [s for s in self.shows if s.experience == "INDULGE"][0]
        self.assertEqual(indulge.chain, "TGV")
        self.assertEqual(indulge.movie_title, "Other Mommy")
        self.assertEqual(indulge.movie_key, "other mommy")
        self.assertEqual(indulge.start, datetime(2026, 10, 14, 13, 45))
        self.assertEqual(indulge.business_date, date(2026, 10, 14))
        self.assertEqual(indulge.hall, "INDULGE 2")
        self.assertEqual(indulge.duration_mins, 93)
        self.assertEqual(indulge.rating, "16")
        self.assertEqual(indulge.language, "English")
        self.assertEqual(indulge.booking_url, "https://www.tgv.com.my/movies/details/other-mommy")

    def test_location_comes_from_the_map_link(self):
        self.assertAlmostEqual(self.shows[0].latitude, 3.1489607, places=6)
        self.assertAlmostEqual(self.shows[0].longitude, 101.7134125, places=6)

    def test_poster_asset_is_used_and_missing_ones_are_blank(self):
        mommy = [s for s in self.shows if s.movie_title == "Other Mommy"][0]
        self.assertTrue(mommy.poster_url.endswith("d1d22010-1a21-4f66-b272-39d8727fed90.jpg"))
        self.assertEqual(mommy.poster_small_url, "")
        digger = [s for s in self.shows if s.movie_title == "Digger"][0]
        self.assertEqual(digger.poster_url, "")

    def test_subtitles_and_movie_page(self):
        mommy = [s for s in self.shows if s.movie_title == "Other Mommy"][0]
        self.assertEqual(mommy.subtitles, ("BM", "Chinese"))
        self.assertEqual(mommy.info_url, "https://www.tgv.com.my/movie/other-mommy")
        digger = [s for s in self.shows if s.movie_title == "Digger"][0]
        self.assertEqual(digger.subtitles, ())

    def test_blank_runtime_becomes_none(self):
        digger = [s for s in self.shows if s.movie_title == "Digger"][0]
        self.assertIsNone(digger.duration_mins)

    def test_failed_response_returns_no_shows(self):
        failed = {"success": False, "error": {"code": "x", "message": "nope"}}
        self.assertEqual(tgv.parse_showtimes(failed, self.cinema), [])

    def test_sessions_for_a_movie_without_details_are_skipped(self):
        payload = _json("tgv_sessions_PKL.json")
        payload["results"]["movies"] = [m for m in payload["results"]["movies"] if m["name"] != "Digger"]
        titles = {s.movie_title for s in tgv.parse_showtimes(payload, self.cinema)}
        self.assertNotIn("Unknown movie", titles)
        self.assertNotIn("Digger", titles)
        self.assertIn("Other Mommy", titles)


if __name__ == "__main__":
    unittest.main()
