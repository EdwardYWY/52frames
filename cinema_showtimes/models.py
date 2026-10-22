"""Chain-neutral data models shared by the GSC and TGV providers."""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta, timezone

MYT = timezone(timedelta(hours=8), "MYT")

# Common regions both chains are mapped onto.
REGIONS = ("Klang Valley", "Northern", "Southern", "East Coast", "East Malaysia")

_TAG_RE = re.compile(r"[\(\[][^\)\]]*[\)\]]")
_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")
# Bracket tags that name the same movie, so they are dropped from the key; every other tag
# ("(SPECIAL)", "(GUARANTEED POSTER)", "[REBROADCAST]") is a different screening and stays in it.
# Compared without case, spaces or punctuation. Keep in sync with site/js/models.js.
_SAME_MOVIE_TAGS = frozenset(
    {
        # Screen formats
        "imax", "bed", "infinityvision",
        # Language versions ("Jailer 2 (Tamil)")
        "tamil", "hindi",
        # Original-language titles ("(KINOFF26) Hello Betty (Hallo Betty)")
        "gelbebriefe", "hallobetty", "wilmawillmehr", "zirkuskind",
        # Part of the title ("EXO PLANET #6 - EXhOrizon [dot] in CINEMAS")
        "dot",
    }
)
_YEAR_TAG_RE = re.compile(r"(19|20)[0-9]{2}")  # "Terbang (2026)"


def _tag_text(match: re.Match) -> str:
    tag = match.group(0)[1:-1]
    key = _NON_ALNUM_RE.sub("", tag.lower())
    return " " if key in _SAME_MOVIE_TAGS or _YEAR_TAG_RE.fullmatch(key) else f" {tag} "


def normalize_title(title: str) -> str:
    """Reduce a movie title to a key that matches across chains.

    Drops same-movie tags such as ``(IMAX)`` or ``(Tamil)``, non-Latin words, case and punctuation,
    so "(IMAX) Jailer 2" (GSC) and "Jailer 2" (TGV) group together. Other tags are kept as words,
    so "(SPECIAL) Clayface" is its own movie.
    """
    without_tags = _TAG_RE.sub(_tag_text, title).lower()
    # TGV appends Chinese/Tamil titles ("Go for Broke 2 重生2"); keep Latin-script words only.
    latin_words = [w for w in without_tags.split() if all(ord(ch) <= 0x24F for ch in w)]
    return _NON_ALNUM_RE.sub(" ", " ".join(latin_words)).strip()


def float_or_none(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


# Both chains name subtitle languages differently ("Bahasa Melayu" vs "BM", "Chinese" vs "CHI").
_SUBTITLE_NAMES = {
    "bm": "BM",
    "bahasa melayu": "BM",
    "malay": "BM",
    "chi": "Chinese",
    "chinese": "Chinese",
    "eng": "English",
    "english": "English",
    "tam": "Tamil",
    "tamil": "Tamil",
}


def normalize_subtitles(names) -> tuple[str, ...]:
    out: list[str] = []
    for name in names or ():
        name = str(name).strip()
        if not name or name in {"-", "NA", "N/A"}:
            continue
        label = _SUBTITLE_NAMES.get(name.lower(), name)
        if label not in out:
            out.append(label)
    return tuple(out)


def today_myt() -> date:
    return datetime.now(MYT).date()


@dataclass(frozen=True)
class Cinema:
    chain: str
    cinema_id: str
    name: str
    region: str
    state: str = ""
    # GSC premium venues (Aurum, Velvet, ...) need their hall group to list shows.
    hall_group: str = ""
    latitude: float | None = None
    longitude: float | None = None


@dataclass(frozen=True)
class Showtime:
    chain: str
    cinema_id: str
    cinema_name: str
    region: str
    movie_title: str
    start: datetime
    business_date: date
    experience: str = ""
    hall: str = ""
    duration_mins: int | None = None
    rating: str = ""
    language: str = ""
    genres: tuple[str, ...] = ()
    tags: tuple[str, ...] = ()
    sold_out: bool = False
    booking_url: str = ""
    # Largest poster this chain offers, and a smaller one if it has one.
    poster_url: str = ""
    poster_small_url: str = ""
    # Subtitle languages as the chain lists them ("BM", "Chinese", ...); None when unknown.
    subtitles: tuple[str, ...] | None = None
    # The chain's page about the movie (not the booking page).
    info_url: str = ""
    # Where the cinema is, when the chain says (GSC: cinema list; TGV: map link per cinema).
    latitude: float | None = None
    longitude: float | None = None
    movie_key: str = field(default="", compare=False)

    def __post_init__(self):
        if not self.movie_key:
            object.__setattr__(self, "movie_key", normalize_title(self.movie_title))
        aliases = {"action adventure": ("Action", "Adventure"), "drama and romance": ("Drama", "Romance")}
        genres = []
        for label in self.genres:
            for part in str(label).split(","):
                for genre in aliases.get(part.strip().lower(), (part.strip(),)):
                    if genre and genre not in genres:
                        genres.append(genre)
        object.__setattr__(self, "genres", tuple(genres))

    def to_dict(self) -> dict:
        data = asdict(self)
        data["start"] = self.start.isoformat(timespec="minutes")
        data["business_date"] = self.business_date.isoformat()
        return data
