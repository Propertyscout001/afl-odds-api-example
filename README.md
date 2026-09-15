# AFL odds API example — best price per team, in Python and Node.js

Two small programs that do the same job in two languages: pull AFL head-to-head
odds for upcoming fixtures from the [PuntersEdge](https://puntersedge.online/afl-odds-api-australia?utm_source=afl-odds-api-example&utm_medium=readme)
Australian odds API, normalise every bookmaker's prices into one
`fixture × bookmaker × price` table, and print the best available price on each
team, which bookmaker is showing it, the implied probability and the market
overround. The data is Australian: AFL and AFLW fixtures priced by Australian
licensed bookmakers, decimal odds, times rendered in Australian Eastern time.

Pick whichever file matches your stack. They are ports of each other and print
the same table apart from four lines that cannot match between two separate runs
— the wall-clock timestamp, the quote age, the elapsed time and the gzip byte
count — so you can also read them side by side to see the same logic in both
languages. `compare.sh` scrubs exactly those four lines and diffs the rest.

- `python/afl_odds.py` — Python 3.9+, standard library only, no `pip install`
- `node/afl-odds.mjs` — Node 18+, standard library only, no `npm install`

## Run it without an API key

No registration, no credit card, 0 credits. Either line works on a clean
machine:

```sh
git clone https://github.com/Propertyscout001/afl-odds-api-example.git
cd afl-odds-api-example

python3 python/afl_odds.py --keyless      # Python
node node/afl-odds.mjs --keyless          # Node
```

## Real output

Captured 2026-09-15 on macOS 15, python3 3.9.6, with no API key set. Trimmed to
the first fixture; the full run is in [`docs/output.txt`](docs/output.txt).

```
$ python3 python/afl_odds.py --keyless

AFL odds via PuntersEdge  -  head-to-head, decimal
source   /v1/demo/best-odds + /v1/demo/book-sport x7
mode     keyless sandbox (0 credits, no registration)
fetched  2026-09-15T00:27:02Z
market   3 fixture(s), 5 bookmaker(s) quoting: betright, ladbrokes_au, pointsbetau, sportsbet, tab
sandbox  asked 7 of the 7 books the demo accepts, 5 returned data
         demo book names differ from keyed ones (betr -> betright)
         quoted nothing: neds, unibet
         a free key adds the books the sandbox withholds, but the sports
         panel is thinner than the racing one: measured 2026-09-15, afl and
         nrl carried 6 bookmakers, nba 5, aflw 3. 14 books is /v1/racing/*

========================================================================
Sydney v Fremantle
Fri 18 Sep 2026 19:40 AEST  5 books

  bookmaker            Sydney    Fremantle
  -------------- ------------ ------------
  tab                    2.45         1.55
  pointsbetau            2.45         1.54
  betright               2.45         1.55
  ladbrokes_au           2.50         1.55
  sportsbet              2.50         1.54
  -------------- ------------ ------------
  best                   2.50         1.55
  implied              40.00%       64.52%

  best Sydney                            2.50  at ladbrokes_au, sportsbet   (market best 2.60 at palmerbet)
  best Fremantle                         1.55  at betright, ladbrokes_au, tab
  overround at best-of-market prices  104.52%
  same sum inside one book            104.52%  ladbrokes_au
                                      105.75%  pointsbetau
```

An HTML version of the same table is written with `--html`, headed with whatever
sport you asked for. Two renders from the keyed path are committed:
[`docs/afl-odds.html`](docs/afl-odds.html) (2 AFL fixtures plus the Brownlow
market, 6 bookmakers) and [`docs/aflw-odds.html`](docs/aflw-odds.html) (9 AFLW
matches, 3 bookmakers). Open either directly in a browser; no server needed.
Both are snapshots captured 2026-09-15 and say so in their own header — re-run
with `--html` for current prices.

## What the two implementations agree on

`compare.sh` runs both and diffs the output, scrubbing the four lines that
cannot match between two separate runs (wall clock, quote age, elapsed time, and
the gzip byte count).

```
$ ./compare.sh --keyless

pausing 65s between runs (demo endpoints allow 30 req/min/IP)
python3 python/afl_odds.py --keyless == node node/afl-odds.mjs --keyless
identical (after scrubbing timestamp, quote age, elapsed, wire bytes)
```

Verified on 2026-09-15 for `--keyless`, `--keyless --sport aflw`, the keyed AFL
path, keyed `--sport aflw` and keyed `--matches-only`. All five came back
identical.

Two runs of the keyless path cost 16 requests against a cap of 30 per minute per
IP, so the script pauses between them; `PE_COMPARE_PAUSE=0` skips that if you
know the window is clear. If a run is rate limited anyway it reports
`inconclusive` rather than claiming the two implementations disagree — they saw
different data, so the diff would mean nothing. That check greps for the
signatures the programs actually emit (`API error: 429 `, `rate limited (30/min)`,
`request failed: … (429)`) and not for a bare `429`, because the normal output is
full of three-digit numbers that can read `429` by coincidence — `freshest 429s
old`, `elapsed 0.429s`, `429 B on the wire` — and a substring match called those
runs rate limited when nothing was. If a price genuinely moves
between the two runs the diff will show that too, and the script says so rather
than pretending it found a bug.

## With a free key

A free key is 1,500 credits a month with no credit card:
[puntersedge.online/api](https://puntersedge.online/api?utm_source=afl-odds-api-example&utm_medium=readme).
Set it in the environment — neither program reads a key from anywhere else, and
there is no config file to leak.

```sh
export PE_API_KEY="your-key"
python3 python/afl_odds.py                 # every bookmaker quoting, 1 credit
python3 python/afl_odds.py --sport aflw    # AFLW, 1 credit
python3 python/afl_odds.py --json          # machine-readable, same numbers
node node/afl-odds.mjs --matches-only      # drop non-match markets
```

What the key changes, measured 2026-09-15:

| | keyless sandbox | free key |
|---|---|---|
| bookmakers on an AFL fixture | 5 | 6 |
| HTTP calls for a full grid | 8 | 1 |
| credits | 0 | 1 |
| AFLW | market-best price only (`/demo/book-sport` rejects `aflw`) | full per-book grid |
| `competition` label (to spot non-match markets) | absent | present |
| quote age per bookmaker | absent | present |

The keyless path has to ask each bookmaker separately, so it costs eight calls
against a cap of 30 requests per minute per IP. The keyed path returns the whole
grid in one response.

Credit costs for the endpoints used here: `/v1/sports/{sport_key}/odds` is 1
credit per market, `/v1/best-odds/{sport_key}` is 3, and everything under
`/v1/demo/` is 0. Every response carries `X-Credits-Used` and
`X-Credits-Remaining`; both programs read `X-Credits-Cost` and print the running
total.

## How it works

Two endpoints, depending on whether a key is present.

- **Keyed:** `GET /v1/sports/afl/odds?markets=h2h` returns a bare array of
  events, each with a `bookmakers[]` list, each of those with `markets[]` and
  `outcomes[]` of `{name, price}`. One call, whole grid.
- **Keyless:** `GET /v1/demo/best-odds?sport=afl` gives the market-wide best
  price per team but no per-book breakdown, so the per-book grid is built by
  looping `GET /v1/demo/book-sport?book=…&sport=afl` over the sandbox book list.

Both are wrapped in one `Client` class holding a single HTTPS connection open
(`http.client.HTTPSConnection` in Python, `https.Agent({keepAlive:true})` in
Node), sending `Accept-Encoding: gzip` and decompressing by hand so the byte
counters in the footer are real.

Things that cost time to work out, all observed on 2026-09-15:

**Bookmakers disagree on team names inside a single fixture.** On
Sydney v Fremantle, palmerbet and sportsbet quoted `"Sydney Swans"` while
pointsbetau, betright and tab quoted `"Sydney"`. Keying a table on the raw
outcome string splits one team into two columns. `resolve_team()` scores each
outcome name against the event's own `home_team` and `away_team` — exact match,
then substring, then token overlap — and requires a strict winner.

**The same AFLW match arrives as two separate event rows.** The AFLW response
had 18 rows for 9 matches: pointsbetau files them under competition `"AFLW"`
with names like `"Hawthorn Hawks Women"`, while ladbrokes_au and sportsbet file
them under `"Women's AFL"` as `"Hawthorn (W)"`. Merging them is what turns a
"2 bookmakers" table into a 3-bookmaker one.

**`commence_time` is not a safe merge key, but `canonical_event_id` is.** The
two AFLW rows for one match carried `2026-09-18T07:45:00Z` and
`2026-09-18T07:45:16Z` — sixteen seconds apart. `canonical_event_id` ends in a
unix timestamp floored to a 30-minute bucket and was byte-identical across
books, so `bucket_key()` reads that and falls back to rounding `commence_time`
only when the field is absent.

**Not every row under `sport_key=afl` is a match.** The same response carried
`"AFL Brownlow H2H's"` — Brodie Grundy v Christian Petracca, a player-versus-player
market with one bookmaker on it. Same shape, same sport key, not a fixture. The
`competition` field is the only way to tell, it is flagged in the output as
`[not a team match]`, and `--matches-only` drops it. The demo envelope omits
`competition`, so the filter cannot work keylessly.

**The demo endpoints use a different vocabulary than the keyed API.** Send
`book=betr_au` or `book=pointsbetau` to `/v1/demo/book-sport` and you get a 400
whose body lists what it does accept: `betr, ladbrokes, neds, pointsbet,
sportsbet, tab, unibet`. The mapping is not guessable from the spelling —
demo `betr` matched **betright** on 4 of 4 prices when compared against the keyed
response, not `betr_au`. `DEMO_TO_KEYED` records it, derived by comparing price
vectors. Five of the seven were pinned that way on 2026-09-15, each matching
exactly one keyed bookmaker outright: `betr`→`betright` 4/4, `ladbrokes`→`ladbrokes_au`
4/4, `pointsbet`→`pointsbetau` 4/4, `sportsbet`→`sportsbet` 6/6, `tab`→`tab` 4/4.
`neds` and `unibet` returned no prices in the sandbox for `afl` or `nrl`, so there
was nothing to compare and their mapping is marked ASSUMED in the source rather
than presented as verified.

**The two demo endpoints do not accept the same sports.** `/v1/demo/best-odds`
serves `aflw`; `/v1/demo/book-sport` rejects it with a 400 listing `afl, cricket,
greyhound-racing, horse-racing, mma, nba, nrl, rugby-union, soccer, tennis`. So
`--keyless --sport aflw` skips the seven book probes outright — they could only
return seven 400s — and prints the market-best prices from `/demo/best-odds`
alone, spending 1 request instead of 8. The per-bookmaker grid for AFLW needs a
key.

**Demo endpoints are capped at 30 requests per minute per IP,** returning a 429.
An early version of this code caught that exception and moved on, which made a
rate-limited bookmaker look identical to one that simply had no prices. It now
records failures separately, reports the status code, stops the sweep on a 429
and lists which books were never asked.

**Responses compress about 7x.** One capture of `/v1/sports/afl/odds?markets=h2h`
on 2026-09-15: 7,491 bytes of JSON arrived as 1,048 bytes on the wire. The same
figures are quoted in both source files, from that same capture.

**Connection reuse saves a handshake per call.** A cold request pays a TCP
connect and then a TLS handshake before the request is even sent; on a reused
connection both are zero. Measured 2026-09-15 from a residential connection in
Australia: 46ms TCP and a further 104ms TLS. That is one machine on one network
on one day — your own latency will differ, and the reproducible part of the
claim is the structure (one handshake instead of eight), not the milliseconds.

**Retries are deliberate and loud.** A dropped connection is retried once, with
a note on stderr. An HTTP error is never retried. A silent retry against a price
endpoint can hand back a price recorded before a move, which is worse than an
error you can see.

Errors are RFC 9457 problem+json and are surfaced rather than swallowed:

```
$ PE_API_KEY=wrong-key python3 python/afl_odds.py
API error: 401 Invalid API key. That value looks too short to be a PuntersEdge
key. Retrying will not clear this. Check the key in your console at
https://puntersedge.online/api/console — if it was rotated, the previous key
stops working once its grace window expires. Need a new one?
https://puntersedge.online/api?utm_source=api_401&utm_medium=invalid_key
(/v1/sports/afl/odds?markets=h2h)
Get a free key (1,500 credits/month, no card):
https://puntersedge.online/api?utm_source=afl-odds-api-example&utm_medium=code
(exit status 2)
```

(The API's `detail` is one long line; wrapped here to fit. It is verbatim in
`docs/output.txt`.)

### Implied probability and overround

Both are arithmetic on the quoted prices, nothing more.

For a decimal price `p`, the implied probability is `1 / p`. A price of 2.50
implies 40.00%; 1.55 implies 64.52%. Summing that across the two outcomes of a
head-to-head market gives the overround: 40.00% + 64.52% = 104.52%.

A fair two-outcome market would sum to 100%. Real quoted prices sum to more than
that, and the excess is the bookmaker's margin expressed as a percentage. Taking
the best price on each team from across several bookmakers produces a lower sum
than any single bookmaker's own pair, because you are taking the highest number
in each column — that is a property of how the maximum works, not a prediction
about outcomes. The programs print both figures so you can see the gap.

None of this says anything about which team will win, whether a price is
mispriced, or what anyone should do about it. It is a description of the numbers
on the screen.

## AFL, AFLW, and how deep the sports data goes

Be clear-eyed about this: racing is where the bookmaker depth is on this API.
Sports are thinner, and AFL is no exception.

Measured 2026-09-15 on `/v1/sports/afl/odds?markets=h2h`:

- 2 upcoming AFL fixtures, **6 bookmakers quoting head-to-head on each** — tab,
  pointsbetau, betright, palmerbet, ladbrokes_au, sportsbet
- 1 Brownlow player head-to-head market, **1 bookmaker**
- AFLW: 9 matches, **3 bookmakers each** (pointsbetau, ladbrokes_au, sportsbet),
  and only after merging the duplicate event rows

So six books on a finals-week AFL fixture and three on an AFLW one, against the
14 the API serves overall. On a quiet competition a single bookmaker is normal.
If you want a market with many books on it, racing is the place to look.

The bookmaker list is 14 as measured on 2026-09-15 and it changes. The live
figure is at [puntersedge.online/coverage-report](https://puntersedge.online/coverage-report?utm_source=afl-odds-api-example&utm_medium=readme)
(JSON at `/coverage-report.json`). Betfair and Pinnacle are not covered.

## Options

```
--sport afl|aflw     sport key (default afl)
--keyless            force the sandbox path even if PE_API_KEY is set
--matches-only       drop markets the competition label proves are not team-vs-team
--json               emit JSON instead of the table
--html FILE          also write an HTML table
--books a,b,c        probe specific bookmakers in keyless mode. The demo endpoint
                     accepts betr, ladbrokes, neds, pointsbet, sportsbet, tab,
                     unibet; the keyed spellings the table prints (betright,
                     ladbrokes_au, pointsbetau) are translated for you
-v, --verbose        log every HTTP call, status and wire size
```

## Related

PuntersEdge guides:

- [AFL betting model data guide](https://puntersedge.online/blog/afl-betting-model-data-guide?utm_source=afl-odds-api-example&utm_medium=readme)
- [AFL odds API (Australia)](https://puntersedge.online/afl-odds-api-australia?utm_source=afl-odds-api-example&utm_medium=readme)
- [Sports odds API for Australia](https://puntersedge.online/developers/sports-odds-api-australia?utm_source=afl-odds-api-example&utm_medium=readme)
- [Australian odds API: Node.js guide](https://puntersedge.online/blog/australian-odds-api-nodejs-guide?utm_source=afl-odds-api-example&utm_medium=readme)
- [Australian odds API: Python guide](https://puntersedge.online/blog/australian-odds-api-python-guide?utm_source=afl-odds-api-example&utm_medium=readme)
- [How to compare bookmaker odds in Australia](https://puntersedge.online/blog/how-to-compare-bookmaker-odds-australia?utm_source=afl-odds-api-example&utm_medium=readme)
- [Building an odds comparison tool in Python](https://puntersedge.online/blog/odds-comparison-tool-python?utm_source=afl-odds-api-example&utm_medium=readme)
- [API reference](https://puntersedge.online/developers/api-reference?utm_source=afl-odds-api-example&utm_medium=readme)
  and [getting started](https://puntersedge.online/developers/getting-started?utm_source=afl-odds-api-example&utm_medium=readme)

Other repositories, if you want something this one deliberately is not:

- [puntersedge-python](https://github.com/Propertyscout001/puntersedge-python) —
  the PyPI SDK, if you would rather not hand-roll HTTP
- [puntersedge-node](https://github.com/Propertyscout001/puntersedge-node) — the
  npm SDK
- [puntersedge-mcp](https://github.com/Propertyscout001/puntersedge-mcp) — MCP
  server, for using the API from an LLM tool
- [puntersedge-examples](https://github.com/Propertyscout001/puntersedge-examples) —
  six standalone Python scripts across racing and sports. `06_sports_best_odds.py`
  covers the market-wide best price per team in about sixty lines, via
  `/v1/best-odds` (3 credits); it has no per-bookmaker grid, no overround, no
  team-name normalisation, no AFLW row merge and no Node port, which is what this
  repo adds
- [au-racing-odds-dashboard](https://github.com/Propertyscout001/au-racing-odds-dashboard) —
  next-to-go racing, one stdlib Python file

## Limitations

- **Head-to-head only.** `markets=h2h`. No line, total, multi or player props.
  The normalisation would need to key on handicap and total values as well as
  team names, and it does not.
- **Two-outcome markets only.** The overround maths assumes exactly two
  outcomes. A draw market, or anything with three or more selections, would need
  the sum taken across all of them; the table has two columns and stops there.
- **No historical data and no line movement.** This reads the current board. For
  open/close/high/low per runner-book see `/v1/racing/price-history`; for sports,
  `/v1/sports/{sport_key}/odds/history` and `/odds/movements` (5 credits each).
- **Name matching is a heuristic, not a database.** `resolve_team()` uses
  substring and token overlap. It handled every name the API returned on
  2026-09-15, including `"Sydney Swans"`/`"Sydney"` and `"Hawthorn (W)"`/
  `"Hawthorn Hawks Women"`. A genuinely ambiguous pair would be left unresolved
  and printed under `unmatched outcome names` rather than guessed at. There is no
  canonical team-id lookup here.
- **The AFLW row merge is a heuristic too.** It requires an identical 30-minute
  kickoff bucket plus at least two shared team-name tokens. Two different matches
  starting in the same bucket with overlapping names would defeat it. It was
  correct on all 9 AFLW matches on 2026-09-15; it has not been tested across a
  full season.
- **`--matches-only` is only as good as the `competition` string.** It matches a
  list of markers (`brownlow`, `player`, `margin`, `outright`, and so on). A new
  non-match market with an unfamiliar label would come through as a fixture.
- **The keyless sandbox is a sample, not the market.** It returned 5 bookmakers
  where the keyed endpoint returned 6, and its prices can lag. Do not benchmark
  coverage from it.
- **No tests.** There is no test suite; `compare.sh` checks the two
  implementations against each other, which catches a port drifting but not both
  being wrong together.
- **Not a scheduler.** It fetches once and exits. No polling loop, no storage, no
  alerting.
- **Times are rendered for Australia/Sydney** via `zoneinfo`/`Intl`, which is
  wrong for a Perth or Adelaide reader. The underlying `commence_time` is UTC and
  is preserved untouched in `--json`.
- **The committed `docs/` files are dated snapshots, not live data.**
  `docs/output.txt`, `docs/sample.json`, `docs/afl-odds.html` and
  `docs/aflw-odds.html` were captured on 2026-09-15 and will never refresh
  themselves; the HTML says so in its own header line. Re-run with `--html` for
  current prices.

## Licence

MIT. See [LICENSE](LICENSE).

---

18+ only. Gambling can be addictive — please gamble responsibly.
Gambling Help: 1800 858 858 · https://www.gambleaware.nsw.gov.au
This repository is a developer example for reading an odds data feed. It is not betting
advice, it places no bets and it holds no bookmaker credentials.
