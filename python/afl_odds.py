#!/usr/bin/env python3
"""
Pull AFL head-to-head odds from the PuntersEdge API, normalise every bookmaker's
prices into one fixture x bookmaker x price table, and print the best available
price per team with the bookmaker offering it, the implied probability and the
market overround.

Runs with no API key at all (sandbox endpoints, 0 credits). With PE_API_KEY set
it uses the keyed endpoints instead: the whole grid in one call, and every
bookmaker quoting the fixture rather than the sandbox's subset (measured
2026-09-15 on AFL, 6 bookmakers keyed against 5 in the sandbox).

Standard library only. Python 3.9+.

    python3 afl_odds.py                 # keyless sandbox
    PE_API_KEY=... python3 afl_odds.py  # full market
    python3 afl_odds.py --sport aflw
    python3 afl_odds.py --json
    python3 afl_odds.py --html out.html

Docs: https://puntersedge.online/developers/sports-odds-api-australia?utm_source=afl-odds-api-example&utm_medium=code
"""

import argparse
import gzip
import http.client
import io
import json
import os
import re
import socket
import sys
import time
from datetime import datetime, timedelta, timezone

HOST = "api.puntersedge.online"
PREFIX = "/v1"
USER_AGENT = "afl-odds-api-example/1.0 (+https://github.com/Propertyscout001/afl-odds-api-example)"
SIGNUP_URL = ("https://puntersedge.online/api"
              "?utm_source=afl-odds-api-example&utm_medium=code")

# The 14 Australian bookmakers the API serves, as of 2026-09-15.
# Live list: https://puntersedge.online/coverage-report
BOOKMAKERS = [
    "tab", "tabtouch", "betdeluxe", "betr_au", "pointsbetau", "betright",
    "playup", "palmerbet", "unibet", "neds", "ladbrokes_au", "sportsbet",
    "betgold", "boostbet",
]

# The keyless demo endpoint has its OWN bookmaker vocabulary. It is narrower
# than the keyed API's and it is spelled differently, which is easy to miss
# because both take a `book` parameter. Send a keyed name like "betr_au" or
# "pointsbetau" and you get a 400, whose body lists the accepted set:
#
#   book must be one of: betr, ladbrokes, neds, pointsbet, sportsbet, tab, unibet
#
DEMO_BOOKS = ["betr", "ladbrokes", "neds", "pointsbet", "sportsbet", "tab", "unibet"]

# Which keyed bookmaker each demo key actually serves. The five marked VERIFIED
# were established 2026-09-15 by comparing the demo price vectors against
# /v1/sports/afl/odds rather than by guessing from the spelling, which matters:
# demo "betr" matched betright on 4 of 4 prices, so it is betright, NOT betr_au.
# Each of the five matched exactly one keyed book outright. neds and unibet
# returned no data in the sandbox for afl or nrl, so there were no prices to
# compare and their mapping is only assumed from the name. Re-derive if the
# sandbox changes.
DEMO_TO_KEYED = {
    "betr": "betright",         # VERIFIED 4/4 prices
    "ladbrokes": "ladbrokes_au",  # VERIFIED 4/4 prices
    "pointsbet": "pointsbetau",   # VERIFIED 4/4 prices
    "sportsbet": "sportsbet",     # VERIFIED 6/6 prices
    "tab": "tab",                 # VERIFIED 4/4 prices
    "neds": "neds",               # ASSUMED - no sandbox data to compare
    "unibet": "unibet",           # ASSUMED - no sandbox data to compare
}

# The reverse direction, so --books accepts either spelling.
KEYED_TO_DEMO = {v: k for k, v in DEMO_TO_KEYED.items()}

# The demo `sport` vocabulary differs too, and has no aflw:
#   afl, cricket, greyhound-racing, horse-racing, mma, nba, nrl, rugby-union,
#   soccer, tennis
DEMO_SPORTS = ["afl", "cricket", "greyhound-racing", "horse-racing", "mma",
               "nba", "nrl", "rugby-union", "soccer", "tennis"]

# /v1/demo/* is capped at 30 requests per minute per IP. Probing all seven demo
# books costs 8 calls including the best-odds call, which fits. Two runs (16)
# also fit; three do not.
DEMO_RATE_LIMIT_PER_MIN = 30

# Tokens that carry no identity when matching one bookmaker's spelling of a team
# against another's. "Hawthorn (W)" and "Hawthorn Hawks Women" are one team.
NOISE_TOKENS = {"w", "women", "womens", "ladies", "fc", "afc", "the"}

# /v1/sports/afl/odds returns more than team-vs-team matches. On 2026-09-15 it
# also carried "AFL Brownlow H2H's" - Brodie Grundy v Christian Petracca, a
# player-vs-player market with one bookmaker on it. Same shape, same sport key,
# not a fixture. Filter on the `competition` field, which the keyed endpoints
# return and the demo envelope does not.
NON_MATCH_MARKERS = ("brownlow", "h2h's", "player", "special", "medal",
                     "margin", "futures", "outright")


class ApiError(Exception):
    """An RFC 9457 problem+json response, or a transport failure."""

    def __init__(self, status, title, detail, url):
        text = title if (not detail or detail == title) else "%s: %s" % (title, detail)
        super().__init__("%s %s (%s)" % (status, text, url))
        self.status = status
        self.title = title
        self.detail = detail
        self.url = url


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

class Client:
    """One HTTPS connection, held open across every request.

    A cold request pays a TCP connect plus a TLS handshake before the request
    is even sent; on a reused connection both are zero. Measured 2026-09-15
    from a residential connection in Australia: 46ms TCP and a further 104ms
    TLS. Your own latency will differ - the point is that the handshake is paid
    once rather than once per call, and the keyless path makes 8 calls in a row.
    """

    def __init__(self, api_key=None, timeout=15.0, verbose=False):
        self.api_key = api_key
        self.timeout = timeout
        self.verbose = verbose
        self._conn = None
        self.calls = 0
        self.bytes_on_wire = 0
        self.bytes_decoded = 0
        self.credits_used = 0

    def _connect(self):
        if self._conn is None:
            self._conn = http.client.HTTPSConnection(HOST, timeout=self.timeout)
        return self._conn

    def close(self):
        if self._conn is not None:
            try:
                self._conn.close()
            finally:
                self._conn = None

    def get(self, path, params=None):
        url = PREFIX + path
        if params:
            url += "?" + "&".join(
                "%s=%s" % (k, v) for k, v in params.items() if v is not None
            )

        headers = {
            "Accept": "application/json",
            # Responses compress about 7x. Measured 2026-09-15 on
            # /v1/sports/afl/odds?markets=h2h: 7,491 bytes of JSON arrived as
            # 1,048 bytes on the wire.
            "Accept-Encoding": "gzip",
            "User-Agent": USER_AGENT,
            "Connection": "keep-alive",
        }
        if self.api_key:
            headers["X-API-Key"] = self.api_key

        # Retry ONLY when the connection died before any response byte arrived,
        # and say so out loud. A silent retry on a price endpoint can hand you a
        # price that was recorded before a move, which is worse than an error.
        for attempt in (1, 2):
            try:
                conn = self._connect()
                conn.request("GET", url, headers=headers)
                resp = conn.getresponse()
                raw = resp.read()
                break
            except (http.client.BadStatusLine, http.client.RemoteDisconnected,
                    socket.timeout, ConnectionError, OSError) as exc:
                self.close()
                if attempt == 2:
                    raise ApiError(0, "connection failed", str(exc), url)
                sys.stderr.write(
                    "note: connection dropped on %s (%s), reconnecting once\n"
                    % (url, exc.__class__.__name__)
                )

        self.calls += 1
        self.bytes_on_wire += len(raw)

        if resp.getheader("Content-Encoding", "") == "gzip":
            body = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
        else:
            body = raw
        self.bytes_decoded += len(body)

        used = resp.getheader("X-Credits-Cost")
        if used and used.isdigit():
            self.credits_used += int(used)

        if self.verbose:
            sys.stderr.write(
                "  GET %-52s %s  %5d B wire  cost=%s\n"
                % (url, resp.status, len(raw), used or "?")
            )

        if resp.status >= 400:
            try:
                problem = json.loads(body.decode("utf-8"))
            except Exception:
                problem = {}
            raise ApiError(
                resp.status,
                problem.get("title", resp.reason),
                problem.get("detail", body[:200].decode("utf-8", "replace")),
                url,
            )

        return json.loads(body.decode("utf-8"))


def unwrap(payload, *keys):
    """Demo endpoints wrap results in an envelope; keyed endpoints return a bare
    array. Handle both so the same parsing code serves either mode.

      demo:  {"demo": true, "note": "...", "events": [...]}
      keyed: [...]
    """
    if isinstance(payload, list):
        return payload, {}
    if isinstance(payload, dict):
        for key in keys:
            if isinstance(payload.get(key), list):
                meta = {k: v for k, v in payload.items() if k != key}
                return payload[key], meta
        return [], payload
    return [], {}


# --------------------------------------------------------------------------
# Name normalisation
# --------------------------------------------------------------------------

def norm(s):
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def tokens(s):
    return {t for t in norm(s).split() if t and t not in NOISE_TOKENS}


def match_score(name, target):
    """How strongly `name` (a bookmaker's spelling) refers to `target`."""
    a, b = norm(name), norm(target)
    if not a or not b:
        return 0.0
    if a == b:
        return 3.0
    if a in b or b in a:
        return 2.0
    ta, tb = tokens(name), tokens(target)
    if not ta or not tb:
        return 0.0
    shared = ta & tb
    if not shared:
        return 0.0
    return 1.0 + len(shared) / float(len(ta | tb))


def resolve_team(name, home, away):
    """Map a bookmaker's outcome name onto the fixture's home or away team.

    Bookmakers do not agree on team names inside a single fixture. Observed
    2026-09-15 on one AFL match: palmerbet and sportsbet quoted "Sydney Swans",
    pointsbetau, betright and tab quoted "Sydney". Keying a table on the raw
    outcome string splits one team into two columns.
    """
    hs, as_ = match_score(name, home), match_score(name, away)
    if hs > as_ and hs >= 1.0:
        return "home"
    if as_ > hs and as_ >= 1.0:
        return "away"
    return None


def bucket_key(event):
    """A merge key that is stable across bookmakers.

    `commence_time` is NOT stable: on AFLW the same match arrives as
    2026-09-18T07:45:00Z from one book and 2026-09-18T07:45:16Z from another.
    `canonical_event_id` ends in a unix timestamp floored to a 30-minute bucket
    and is byte-identical across books, so use that when it is present.
    """
    cid = event.get("canonical_event_id") or ""
    tail = cid.rsplit(":", 1)[-1]
    if tail.isdigit():
        return int(tail)
    ts = parse_time(event.get("commence_time"))
    if ts is None:
        return None
    return int(ts.timestamp()) // 1800 * 1800


def parse_time(value):
    if not value:
        return None
    text = value.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# --------------------------------------------------------------------------
# Fixture model
# --------------------------------------------------------------------------

class Fixture:
    def __init__(self, home, away, start, competition, key):
        self.home = home
        self.away = away
        self.start = start
        self.competitions = [competition] if competition else []
        self.key = key
        self.prices = {}        # bookmaker -> {"home": price, "away": price}
        self.ages = {}          # bookmaker -> seconds since that book's quote
        self.market_best = {}   # side -> (price, bookmaker)   from /best-odds
        self.unresolved = []

    def is_team_match(self):
        """False for a market we can prove is not team-vs-team; None when the
        competition label is absent (the demo envelope omits it)."""
        if not self.competitions:
            return None
        low = " ".join(self.competitions).lower()
        return not any(m in low for m in NON_MATCH_MARKERS)

    def add_price(self, book, outcome_name, price):
        side = resolve_team(outcome_name, self.home, self.away)
        if side is None:
            self.unresolved.append((book, outcome_name))
            return
        self.prices.setdefault(book, {})[side] = float(price)

    def books(self):
        return [b for b in BOOKMAKERS if b in self.prices] + \
               [b for b in sorted(self.prices) if b not in BOOKMAKERS]

    def best(self, side):
        """(price, [bookmakers]) for the highest price quoted on `side`."""
        quotes = [(v[side], b) for b, v in self.prices.items() if side in v]
        if not quotes:
            return None, []
        top = max(q[0] for q in quotes)
        return top, sorted(b for p, b in quotes if p == top)

    def overround(self, prices):
        """Sum of implied probabilities. 1/price is the implied probability of
        an outcome at that price; the sum across both outcomes is the overround.
        It is arithmetic on the quoted numbers and describes nothing else."""
        if not prices or any(p <= 0 for p in prices):
            return None
        return sum(1.0 / p for p in prices)

    def book_overrounds(self):
        out = {}
        for book, sides in self.prices.items():
            if "home" in sides and "away" in sides:
                out[book] = self.overround([sides["home"], sides["away"]])
        return out

    def label(self):
        return "%s v %s" % (self.home, self.away)


def merge_fixtures(fixtures):
    """Collapse event rows that describe the same real match.

    On AFLW 2026-09-15 the API returned 18 rows for 9 matches: pointsbetau files
    them under competition "AFLW" with team names like "Hawthorn Hawks Women",
    ladbrokes_au and sportsbet file them under "Women's AFL" as "Hawthorn (W)".
    Same kickoff bucket, overlapping team tokens, different rows.
    """
    merged = []
    for fx in fixtures:
        host = None
        for existing in merged:
            if existing.key is None or fx.key is None:
                continue
            if existing.key != fx.key:
                continue
            shared = (tokens(existing.home) | tokens(existing.away)) & \
                     (tokens(fx.home) | tokens(fx.away))
            if len(shared) >= 2:
                host = existing
                break
        if host is None:
            merged.append(fx)
            continue
        for comp in fx.competitions:
            if comp not in host.competitions:
                host.competitions.append(comp)
        for book, sides in fx.prices.items():
            for side, price in sides.items():
                # Re-resolve against the host's spelling of the teams.
                name = fx.home if side == "home" else fx.away
                target = resolve_team(name, host.home, host.away)
                if target:
                    host.prices.setdefault(book, {})[target] = price
        host.ages.update(fx.ages)
        for side, val in fx.market_best.items():
            if side not in host.market_best:
                host.market_best[side] = val
    return merged


# --------------------------------------------------------------------------
# Loaders
# --------------------------------------------------------------------------

def load_keyed(client, sport):
    """One call: /v1/sports/{sport}/odds?markets=h2h — every bookmaker, every
    fixture, in a bare array. Costs 1 credit per market."""
    payload = client.get("/sports/%s/odds" % sport, {"markets": "h2h"})
    events, _ = unwrap(payload, "events")
    fixtures = []
    for ev in events:
        fx = Fixture(ev.get("home_team", "?"), ev.get("away_team", "?"),
                     parse_time(ev.get("commence_time")),
                     ev.get("competition"), bucket_key(ev))
        for bk in ev.get("bookmakers", []):
            book = bk.get("key")
            for market in bk.get("markets", []):
                if market.get("key") != "h2h":
                    continue
                for outcome in market.get("outcomes", []):
                    fx.add_price(book, outcome.get("name"), outcome.get("price"))
            if bk.get("age_seconds") is not None:
                fx.ages[book] = bk["age_seconds"]
        fixtures.append(fx)
    return fixtures, "/v1/sports/%s/odds?markets=h2h" % sport


def load_keyless(client, sport, books=None, verbose=False):
    """No API key, 0 credits.

    /v1/demo/best-odds gives the market-wide best price per team but not the
    per-book grid. /v1/demo/book-sport gives one book's prices at a time, so
    loop it to build the grid. Not every book answers: measured 2026-09-15 for
    AFL, five of the seven the sandbox accepts returned data (betr, ladbrokes,
    pointsbet, sportsbet, tab) and two returned an empty item list (neds,
    unibet).

    The two demo endpoints do not accept the same sports. /demo/best-odds
    serves aflw; /demo/book-sport rejects it with a 400 (verified 2026-09-15).
    So for a sport outside DEMO_SPORTS the per-book sweep is skipped: it can
    only return seven 400s, and on a 30 requests/minute/IP cap that is a
    quarter of the budget spent on a known miss. The same applies when
    /demo/best-odds returns no events at all - there is nothing to attach
    per-book prices to.

    Mind that cap: a full run makes 1 + len(books) calls, so the default
    seven-book sweep costs 8.
    """
    # --books takes the demo vocabulary, but the table prints keyed names, so a
    # reader copying "betright" off the output would otherwise get a 400.
    # Translate keyed spellings back to the demo key before sending.
    probe = [KEYED_TO_DEMO.get(b.strip(), b.strip()) for b in books] if books \
        else list(DEMO_BOOKS)

    payload = client.get("/demo/best-odds", {"sport": sport})
    events, _ = unwrap(payload, "events")

    skip_reason = None
    if sport not in DEMO_SPORTS:
        skip_reason = ("/v1/demo/book-sport does not accept sport=%s (400); "
                       "only /v1/demo/best-odds does" % sport)
    elif not events:
        skip_reason = "/v1/demo/best-odds returned no %s events to attach prices to" % sport
    if skip_reason:
        sys.stderr.write(
            "note: skipping the %d book probe(s) - %s.\n"
            "      That saves %d of the %d requests/minute the demo allows.\n"
            "      For the per-bookmaker grid use a free key: %s\n"
            % (len(probe), skip_reason, len(probe), DEMO_RATE_LIMIT_PER_MIN,
               SIGNUP_URL))
        probe = []

    fixtures = []
    for ev in events:
        fx = Fixture(ev.get("home_team", "?"), ev.get("away_team", "?"),
                     parse_time(ev.get("commence_time")),
                     ev.get("competition"), bucket_key(ev))
        for sel in ev.get("selections", []):
            side = resolve_team(sel.get("name"), fx.home, fx.away)
            if side and sel.get("best_price"):
                fx.market_best[side] = (float(sel["best_price"]),
                                        sel.get("best_bookmaker"))
        fixtures.append(fx)

    responding = []
    failed = []
    attempted = []
    for book in probe:
        attempted.append(book)
        try:
            payload = client.get("/demo/book-sport", {"book": book, "sport": sport})
        except ApiError as exc:
            # Do NOT fold a failed request in with "this book quoted nothing".
            # They look the same in the output and they are not the same thing.
            failed.append((book, exc))
            if verbose:
                sys.stderr.write("  %s: %s\n" % (book, exc))
            if exc.status == 429:
                sys.stderr.write(
                    "rate limited (%d/min) after %d of %d books; stopping the sweep\n"
                    % (DEMO_RATE_LIMIT_PER_MIN,
                       len(responding) + len(failed), len(probe)))
                break
            continue
        items, _ = unwrap(payload, "items")
        if not items:
            continue
        responding.append(book)
        # Label the column with the keyed bookmaker name so the keyless grid and
        # the keyed grid can be read side by side.
        label = DEMO_TO_KEYED.get(book, book)
        for item in items:
            fx = _find(fixtures, item)
            if fx is None:
                continue
            for price in item.get("prices", []):
                fx.add_price(label, price.get("name"), price.get("price"))

    if not probe:
        source = "/v1/demo/best-odds (per-book sweep skipped)"
    else:
        source = "/v1/demo/best-odds + /v1/demo/book-sport x%d" % len(probe)
    return fixtures, (responding, attempted, probe, failed), source


def _find(fixtures, item):
    home, away = item.get("home_team", ""), item.get("away_team", "")
    best, score = None, 0.0
    for fx in fixtures:
        s = max(match_score(home, fx.home), match_score(home, fx.away)) + \
            max(match_score(away, fx.home), match_score(away, fx.away))
        if s > score:
            best, score = fx, s
    return best if score >= 2.0 else None


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------

def fmt_local(dt, tzname="Australia/Sydney"):
    if dt is None:
        return "time unknown"
    try:
        from zoneinfo import ZoneInfo
        local = dt.astimezone(ZoneInfo(tzname))
        return local.strftime("%a %d %b %Y %H:%M ") + local.tzname()
    except Exception:
        local = dt.astimezone(timezone(timedelta(hours=10)))
        return local.strftime("%a %d %b %Y %H:%M AEST")


def effective_best(fx, side, book_best):
    """Best price to show for one side.

    The per-book grid wins when it exists. When it does not - keyless AFLW,
    where /v1/demo/book-sport refuses the sport - /v1/demo/best-odds still
    returned a market-wide best per team, and printing "-" would throw that
    away. Returns (price, bookmaker, from_grid).
    """
    if book_best is not None:
        return book_best, None, True
    mb = fx.market_best.get(side)
    if mb:
        return mb[0], mb[1], False
    return None, None, True


def render(fixtures, sport, source, client, mode, responding=None, width=72):
    out = []
    w = out.append

    quoting = sorted({b for fx in fixtures for b in fx.prices})
    w("%s odds via PuntersEdge  -  head-to-head, decimal" % sport.upper())
    w("source   %s" % source)
    w("mode     %s" % mode)
    w("fetched  %s" % datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    w("market   %d fixture(s), %d bookmaker(s) quoting: %s"
      % (len(fixtures), len(quoting), ", ".join(quoting) or "none"))
    if responding is not None:
        answered, attempted, probed, failed = responding
        bad = {b for b, _ in failed}
        silent = [b for b in attempted if b not in answered and b not in bad]
        if not probed:
            w("sandbox  per-book sweep skipped, so this is /v1/demo/best-odds only:")
            w("         market-best price per team, no per-bookmaker grid")
            w("         (the reason is on stderr)")
        else:
            w("sandbox  asked %d of the %d books the demo accepts, %d returned data"
              % (len(attempted), len(DEMO_BOOKS), len(answered)))
            w("         demo book names differ from keyed ones (betr -> betright)")
        if silent:
            w("         quoted nothing: %s" % ", ".join(silent))
        skipped = [b for b in probed if b not in attempted]
        if skipped:
            w("         never asked: %s" % ", ".join(skipped))
        if failed:
            w("         request failed: %s"
              % ", ".join("%s (%d)" % (b, e.status) for b, e in failed))
            if any(e.status == 429 for _, e in failed):
                w("         -> 429 is the 30 requests/minute/IP demo cap, not a")
                w("            statement about what those bookmakers quote")
        # NOT "the keyed API serves 14 books". 14 is the RACING panel. The sports
        # panel is thinner, and printing the racing number inside an AFL tool tells
        # the reader a free key unlocks something it does not. Counts below were
        # read off /v1/sports/{key}/odds?markets=h2h on 2026-09-15.
        w("         a free key adds the books the sandbox withholds, but the sports")
        w("         panel is thinner than the racing one: measured 2026-09-15, afl and")
        w("         nrl carried 6 bookmakers, nba 5, aflw 3. 14 books is /v1/racing/*")
    w("")

    for fx in fixtures:
        w("=" * width)
        title = fx.label()
        if fx.is_team_match() is False:
            title += "   [not a team match]"
        w(title)
        bits = [fmt_local(fx.start)]
        if fx.competitions:
            bits.append(" + ".join(fx.competitions))
        bits.append("%d book%s" % (len(fx.prices), "" if len(fx.prices) == 1 else "s"))
        if fx.ages:
            bits.append("freshest %ds old" % min(fx.ages.values()))
        w("  ".join(bits))
        w("")

        col = 12
        labelw = 36
        namew = labelw - 6
        w("  %-14s %*s %*s" % ("bookmaker", col, _clip(fx.home, col),
                               col, _clip(fx.away, col)))
        rule = "  " + "-" * 14 + " " + "-" * col + " " + "-" * col
        w(rule)
        if not fx.prices:
            if fx.market_best:
                w("  (no per-book grid here; the market-best prices are below)")
            else:
                w("  (no bookmaker returned a price for this fixture)")
        for book in fx.books():
            sides = fx.prices[book]
            w("  %-14s %*s %*s" % (book, col, _price(sides.get("home")),
                                   col, _price(sides.get("away"))))
        w(rule)

        best_h, at_h = fx.best("home")
        best_a, at_a = fx.best("away")
        eff_h, mb_h, grid_h = effective_best(fx, "home", best_h)
        eff_a, mb_a, grid_a = effective_best(fx, "away", best_a)
        w("  %-14s %*s %*s" % ("best", col, _price(eff_h), col, _price(eff_a)))
        w("  %-14s %*s %*s" % ("implied", col, _pct_of(eff_h), col, _pct_of(eff_a)))
        w("")

        for side, team, price, at in (("home", fx.home, best_h, at_h),
                                      ("away", fx.away, best_a, at_a)):
            if price is None:
                # No per-book grid, but /demo/best-odds still gave the
                # market-wide best. Showing "-" would throw data away.
                eff, mb_book, _ = effective_best(fx, side, None)
                if eff is not None:
                    w("  %-*s%7.2f  at %s  (market best; no per-book grid)"
                      % (labelw, "best " + _clip(team, namew), eff, mb_book))
                else:
                    w("  %-*s%7s" % (labelw, "best " + _clip(team, namew), "-"))
                continue
            line = "  %-*s%7.2f  at %s" % (labelw, "best " + _clip(team, namew),
                                           price, ", ".join(at))
            mb = fx.market_best.get(side)
            if mb and mb[0] > price + 1e-9:
                line += "   (market best %.2f at %s)" % (mb[0], mb[1])
            w(line)

        orr = fx.overround([p for p in (eff_h, eff_a) if p])
        if orr and eff_h and eff_a:
            w("  %-*s%7s" % (labelw, "overround at best-of-market prices",
                              "%.2f%%" % (orr * 100)))
            per = fx.book_overrounds()
            if len(per) > 1:
                lo = min(per.items(), key=lambda kv: kv[1])
                hi = max(per.items(), key=lambda kv: kv[1])
                if abs(hi[1] - lo[1]) < 1e-9:
                    w("  %-*s%7s  every book" % (
                        labelw, "same sum inside one book",
                        "%.2f%%" % (lo[1] * 100)))
                else:
                    w("  %-*s%7s  %s" % (labelw, "same sum inside one book",
                                         "%.2f%%" % (lo[1] * 100), lo[0]))
                    w("  %-*s%7s  %s" % (labelw, "",
                                         "%.2f%%" % (hi[1] * 100), hi[0]))
            elif len(per) == 1:
                only = list(per.items())[0]
                w("  %-*s%7s  %s" % (labelw, "same sum inside one book",
                                     "%.2f%%" % (only[1] * 100), only[0]))
        else:
            w("  overround unavailable - a price is missing on one side")

        if fx.unresolved:
            w("  unmatched outcome names: %s"
              % ", ".join("%s=%r" % (b, n) for b, n in fx.unresolved))
        w("")

    w("=" * width)
    ratio = (client.bytes_decoded / float(client.bytes_on_wire)) if client.bytes_on_wire else 0.0
    w("%d HTTP call(s) on one connection, %d credits" % (client.calls, client.credits_used))
    w("%s on the wire, %s after gunzip (%.1fx)"
      % (_bytes(client.bytes_on_wire), _bytes(client.bytes_decoded), ratio))
    w("")
    w("Implied probability = 1/price. Overround = the sum of those across the")
    w("two outcomes. Both are arithmetic on the quoted prices and nothing more.")
    return "\n".join(out)


def _clip(s, n):
    s = s or "-"
    return s if len(s) <= n else s[:n - 1] + "…"


def _price(p):
    return "-" if p is None else "%.2f" % p


def _pct_of(p):
    return "-" if not p else "%.2f%%" % (100.0 / p)


def _bytes(n):
    return "%.1f kB" % (n / 1024.0) if n >= 1024 else "%d B" % n


def to_json(fixtures, sport, source, mode):
    rows = []
    for fx in fixtures:
        best_h, at_h = fx.best("home")
        best_a, at_a = fx.best("away")
        orr = fx.overround([p for p in (best_h, best_a) if p])
        rows.append({
            "fixture": fx.label(),
            "home_team": fx.home,
            "away_team": fx.away,
            "commence_time": fx.start.isoformat() if fx.start else None,
            "competitions": fx.competitions,
            "bookmaker_count": len(fx.prices),
            "prices": {b: {"home": v.get("home"), "away": v.get("away")}
                       for b, v in fx.prices.items()},
            "best": {
                "home": {"price": best_h, "bookmakers": at_h,
                         "implied_probability": (1.0 / best_h) if best_h else None},
                "away": {"price": best_a, "bookmakers": at_a,
                         "implied_probability": (1.0 / best_a) if best_a else None},
            },
            "overround_at_best": orr,
            "overround_by_bookmaker": fx.book_overrounds(),
        })
    return json.dumps({
        "sport": sport, "source": source, "mode": mode,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fixtures": rows,
    }, indent=2)


def to_html(fixtures, sport, source, mode):
    esc = lambda s: (str(s).replace("&", "&amp;").replace("<", "&lt;")
                     .replace(">", "&gt;"))
    # The page is written for whichever sport was asked for. Hard-coding "AFL"
    # here once produced an --sport aflw page headed "AFL head-to-head odds"
    # above nine AFLW fixtures.
    label = esc(sport.upper())
    if sport == "afl":
        data_link = "https://puntersedge.online/afl-odds-api-australia"
        data_text = "PuntersEdge AFL odds API"
    else:
        data_link = "https://puntersedge.online/developers/sports-odds-api-australia"
        data_text = "PuntersEdge sports odds API (Australia)"
    parts = ["""<!doctype html><meta charset="utf-8">
<title>%s odds grid</title>""" % label + """
<style>
:root{color-scheme:light dark;--fg:#16181d;--bg:#fbfbf9;--mut:#6b7280;--line:#dfe1e4;--hi:#0b5c3f;--hibg:#e7f4ee}
@media(prefers-color-scheme:dark){:root{--fg:#e6e7ea;--bg:#15171b;--mut:#9aa1ab;--line:#2d3138;--hi:#6ee7b7;--hibg:#16302a}}
body{margin:0;padding:32px 20px;background:var(--bg);color:var(--fg);
font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto}
h1{font-size:19px;margin:0 0 4px;font-weight:600;letter-spacing:-.01em}
.meta{color:var(--mut);font-size:12.5px;margin:0 0 28px;
font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
section{border-top:1px solid var(--line);padding:20px 0 4px}
h2{font-size:15.5px;margin:0 0 2px;font-weight:600}
.sub{color:var(--mut);font-size:12.5px;margin:0 0 14px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:5px 10px;text-align:right;border-bottom:1px solid var(--line)}
th:first-child,td:first-child{text-align:left;
font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
thead th{color:var(--mut);font-weight:500;font-size:12.5px}
tr.best td{background:var(--hibg);color:var(--hi);font-weight:600;
border-top:1px solid var(--line)}
tr.sub td{color:var(--mut);font-weight:400;font-size:12.5px;background:var(--hibg)}
.orr{margin:12px 0 0;font-size:13px}
.orr b{font-variant-numeric:tabular-nums}
.note{color:var(--mut);font-size:12.5px;margin-top:6px}
footer{border-top:1px solid var(--line);margin-top:28px;padding-top:16px;
color:var(--mut);font-size:12.5px}
a{color:inherit}
</style><main>"""]
    parts.append("<h1>%s head-to-head odds &mdash; best price per team</h1>" % label)
    parts.append('<p class="meta">Snapshot taken %s &middot; prices move, '
                 're-run to refresh<br>%s<br>%s</p>' % (
                     datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
                     esc(source), esc(mode)))

    for fx in fixtures:
        best_h, at_h = fx.best("home")
        best_a, at_a = fx.best("away")
        eff_h, mb_h, grid_h = effective_best(fx, "home", best_h)
        eff_a, mb_a, grid_a = effective_best(fx, "away", best_a)
        if not grid_h:
            at_h = [mb_h] if mb_h else []
        if not grid_a:
            at_a = [mb_a] if mb_a else []
        parts.append("<section><h2>%s</h2>" % esc(fx.label()))
        parts.append('<p class="sub">%s &middot; %s &middot; %d bookmaker(s)</p>' % (
            esc(fmt_local(fx.start)), esc(" / ".join(fx.competitions) or "-"),
            len(fx.prices)))
        parts.append("<table><thead><tr><th>bookmaker</th><th>%s</th><th>%s</th>"
                     "</tr></thead><tbody>" % (esc(fx.home), esc(fx.away)))
        for book in fx.books():
            s = fx.prices[book]
            parts.append("<tr><td>%s</td><td>%s</td><td>%s</td></tr>" % (
                esc(book), _price(s.get("home")), _price(s.get("away"))))
        parts.append('<tr class="best"><td>best</td><td>%s</td><td>%s</td></tr>'
                     % (_price(eff_h), _price(eff_a)))
        parts.append('<tr class="sub"><td>at</td><td>%s</td><td>%s</td></tr>'
                     % (esc(",".join(at_h) or "-"), esc(",".join(at_a) or "-")))
        parts.append('<tr class="sub"><td>implied probability</td><td>%s</td>'
                     '<td>%s</td></tr>' % (_pct_of(eff_h), _pct_of(eff_a)))
        parts.append("</tbody></table>")
        if not fx.prices and (eff_h or eff_a):
            parts.append('<p class="note">No per-bookmaker grid for this '
                         'fixture; the row above is the market-wide best price '
                         'from /v1/demo/best-odds.</p>')
        orr = fx.overround([p for p in (eff_h, eff_a) if p])
        if orr:
            parts.append('<p class="orr">Overround at best-of-market prices '
                         "<b>%.2f%%</b></p>" % (orr * 100))
            per = fx.book_overrounds()
            if per:
                lo = min(per.items(), key=lambda kv: kv[1])
                hi = max(per.items(), key=lambda kv: kv[1])
                parts.append('<p class="note">Same sum inside a single book: '
                             "%.2f%% (%s) to %.2f%% (%s)</p>"
                             % (lo[1] * 100, lo[0], hi[1] * 100, hi[0]))
        parts.append("</section>")

    parts.append(
        '<footer>Implied probability is 1/price; the overround is the sum of '
        'those across both outcomes. Both are arithmetic on the quoted prices '
        'and describe nothing else.<br><br>'
        '18+ only. Gambling can be addictive &mdash; please gamble responsibly. '
        'Gambling Help: 1800 858 858 &middot; '
        '<a href="https://www.gambleaware.nsw.gov.au">gambleaware.nsw.gov.au</a><br>'
        'Data: <a href="%s'
        '?utm_source=afl-odds-api-example&amp;utm_medium=demo">%s</a>. '
        'This page is a developer example for reading an odds data feed. It is not '
        'betting advice, it places no bets and it holds no bookmaker credentials.'
        "</footer></main>" % (data_link, data_text))
    return "\n".join(parts)


# --------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(
        description="AFL head-to-head odds: best price per team, by bookmaker.")
    ap.add_argument("--sport", default="afl",
                    help="sport key: afl (default) or aflw")
    ap.add_argument("--matches-only", action="store_true",
                    help="drop markets the competition label proves are not "
                         "team-vs-team (e.g. AFL Brownlow H2H's). The demo "
                         "envelope omits that label, so this cannot filter "
                         "in keyless mode.")
    ap.add_argument("--keyless", action="store_true",
                    help="force the no-key sandbox path even if PE_API_KEY is set")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of a table")
    ap.add_argument("--html", metavar="FILE", help="also write an HTML table to FILE")
    ap.add_argument("--books", metavar="A,B",
                    help="comma-separated bookmakers to probe in keyless mode. "
                         "The demo endpoint accepts: " + ", ".join(DEMO_BOOKS) +
                         ". Keyed spellings (betright, ladbrokes_au, "
                         "pointsbetau) are translated for you.")
    ap.add_argument("-v", "--verbose", action="store_true", help="log each HTTP call")
    args = ap.parse_args(argv)

    key = None if args.keyless else os.environ.get("PE_API_KEY")
    client = Client(api_key=key, verbose=args.verbose)
    started = time.time()

    try:
        if key:
            fixtures, source = load_keyed(client, args.sport)
            responding = None
            mode = "keyed (PE_API_KEY set)"
        else:
            books = args.books.split(",") if args.books else None
            fixtures, responding, source = load_keyless(
                client, args.sport, books, args.verbose)
            mode = "keyless sandbox (0 credits, no registration)"
    except ApiError as exc:
        sys.stderr.write("API error: %s\n" % exc)
        if exc.status == 429:
            sys.stderr.write(
                "The demo endpoints allow %d requests/minute/IP. Wait a minute, "
                "or ask for fewer books (--books tab,sportsbet), or use a free "
                "key.\n" % DEMO_RATE_LIMIT_PER_MIN)
        if exc.status in (401, 429):
            sys.stderr.write(
                "Get a free key (1,500 credits/month, no card): %s\n" % SIGNUP_URL)
        return 2

    fixtures = merge_fixtures(fixtures)
    fixtures = [fx for fx in fixtures if fx.prices or fx.market_best]
    if args.matches_only:
        dropped = [fx for fx in fixtures if fx.is_team_match() is False]
        fixtures = [fx for fx in fixtures if fx.is_team_match() is not False]
        for fx in dropped:
            sys.stderr.write("dropped non-match market: %s (%s)\n"
                             % (fx.label(), " + ".join(fx.competitions)))
        if not key:
            sys.stderr.write(
                "note: --matches-only has nothing to filter on in keyless mode; "
                "the demo envelope omits the competition field\n")
    fixtures.sort(key=lambda f: (f.start or datetime.max.replace(tzinfo=timezone.utc)))

    if args.html:
        with open(args.html, "w") as fh:
            fh.write(to_html(fixtures, args.sport, source, mode))
        sys.stderr.write("wrote %s\n" % args.html)

    if args.json:
        print(to_json(fixtures, args.sport, source, mode))
    else:
        print(render(fixtures, args.sport, source, client, mode, responding))
        print("elapsed %.2fs" % (time.time() - started))

    client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
