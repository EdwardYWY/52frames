"""Tests for combining GSC and TGV showtimes and filtering them."""

from __future__ import annotations

import unittest
from datetime import date, datetime

from cinema_showtimes.aggregator import collect_showtimes, filter_showtimes, group_by_movie
from cinema_showtimes.models import Cinema, Showtime, normalize_title


def _show(chain, cinema, title, hour, region="Klang Valley"):
    return Showtime(
        chain=chain,
        cinema_id=cinema,
        cinema_name=cinema,
        region=region,
        movie_title=title,
        start=datetime(2026, 10, 15, hour, 0),
        business_date=date(2026, 10, 15),
    )


class NormalizeTitleTest(unittest.TestCase):
    def test_strips_tags_case_and_punctuation(self):
        self.assertEqual(normalize_title("(IMAX) Jailer 2"), "jailer 2")
        self.assertEqual(normalize_title("[BED] OTHER MOMMY"), "other mommy")
        self.assertEqual(
            normalize_title("(InfinityVision) Avengers:Endgame Encore"),
            "avengers endgame encore",
        )

    def test_drops_non_latin_words_so_bilingual_titles_match(self):
        self.assertEqual(normalize_title("Go for Broke 2 重生2"), "go for broke 2")
        self.assertEqual(normalize_title("Good Trip 我阿爹想旅行"), "good trip")
        self.assertEqual(normalize_title("Jailer 2 (Tamil)"), "jailer 2")

    def test_only_same_movie_tags_are_dropped(self):
        self.assertEqual(normalize_title("Terbang (2026)"), "terbang")
        self.assertEqual(normalize_title("(Infinity Vision) Avengers: Doomsday"), "avengers doomsday")
        self.assertEqual(
            normalize_title("(GUARANTEED POSTER) Godzilla Minus Zero"),
            "guaranteed poster godzilla minus zero",
        )
        self.assertEqual(normalize_title("(SPECIAL) Clayface"), "special clayface")
        self.assertEqual(normalize_title("[REBROADCAST] BTS LIVE"), "rebroadcast bts live")


class FilterShowtimesTest(unittest.TestCase):
    def setUp(self):
        self.shows = [
            _show("GSC", "Mid Valley", "Jailer 2", 20),
            _show("TGV", "Pavilion KL", "Jailer 2", 21),
            _show("TGV", "Bukit Indah", "Other Mommy", 19, region="Southern"),
        ]

    def test_no_filters_returns_all_sorted_by_start(self):
        result = filter_showtimes(self.shows)
        self.assertEqual([s.start.hour for s in result], [19, 20, 21])

    def test_filters_by_chain_region_cinema_and_movie(self):
        self.assertEqual(len(filter_showtimes(self.shows, chains=["gsc"])), 1)
        self.assertEqual(len(filter_showtimes(self.shows, region="southern")), 1)
        self.assertEqual(len(filter_showtimes(self.shows, cinema="pavilion")), 1)
        self.assertEqual(len(filter_showtimes(self.shows, movie="JAILER")), 2)

    def test_filters_by_earliest_start_time(self):
        result = filter_showtimes(self.shows, after="20:30")
        self.assertEqual([s.cinema_name for s in result], ["Pavilion KL"])


class GroupByMovieTest(unittest.TestCase):
    def test_same_movie_from_both_chains_is_grouped(self):
        shows = [
            _show("GSC", "Mid Valley", "(IMAX) Jailer 2", 20),
            _show("TGV", "Pavilion KL", "Jailer 2", 21),
        ]
        groups = group_by_movie(shows)
        self.assertEqual(list(groups), ["jailer 2"])
        self.assertEqual(len(groups["jailer 2"]), 2)


class CollectShowtimesTest(unittest.TestCase):
    def test_one_chain_failing_still_returns_the_other(self):
        good = Cinema(chain="TGV", cinema_id="PKL", name="TGV Pavilion", region="Klang Valley")

        class FakeTgv:
            @staticmethod
            def fetch_cinemas():
                return [good]

            @staticmethod
            def fetch_showtimes(cinema, day):
                return [_show("TGV", cinema.name, "Jailer 2", 20)]

        class FakeGsc:
            @staticmethod
            def fetch_cinemas():
                raise OSError("network down")

            @staticmethod
            def fetch_showtimes(cinema, day):
                raise AssertionError("should not be called")

        result = collect_showtimes(date(2026, 10, 15), providers={"GSC": FakeGsc, "TGV": FakeTgv})

        self.assertEqual(len(result.showtimes), 1)
        self.assertEqual(result.showtimes[0].chain, "TGV")
        self.assertEqual(len(result.errors), 1)
        self.assertIn("GSC", result.errors[0])

    def test_only_fetches_cinemas_matching_region(self):
        kv = Cinema(chain="TGV", cinema_id="A", name="A", region="Klang Valley")
        south = Cinema(chain="TGV", cinema_id="B", name="B", region="Southern")
        fetched = []

        class FakeTgv:
            @staticmethod
            def fetch_cinemas():
                return [kv, south]

            @staticmethod
            def fetch_showtimes(cinema, day):
                fetched.append(cinema.cinema_id)
                return []

        collect_showtimes(date(2026, 10, 15), region="southern", providers={"TGV": FakeTgv})
        self.assertEqual(fetched, ["B"])


if __name__ == "__main__":
    unittest.main()
