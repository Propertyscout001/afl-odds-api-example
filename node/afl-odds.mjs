#!/usr/bin/env node
/**
 * Pull AFL head-to-head odds from the PuntersEdge API, normalise every
 * bookmaker's prices into one fixture x bookmaker x price table, and print the
 * best available price per team with the bookmaker offering it, the implied
 * probability and the market overround.
 *
 * Runs with no API key at all (sandbox endpoints, 0 credits). With PE_API_KEY
 * set it uses the keyed endpoints instead: the whole grid in one call, and
 * every bookmaker quoting the fixture rather than the sandbox's subset
 * (measured 2026-09-15 on AFL, 6 bookmakers keyed against 5 in the sandbox).
 *
 * Node 18+, standard library only. This is a line-for-line port of
 * ../python/afl_odds.py and prints the same table.
 *
 *     node afl-odds.mjs                     # keyless sandbox
 *     PE_API_KEY=... node afl-odds.mjs      # full market
 *     node afl-odds.mjs --sport aflw
 *     node afl-odds.mjs --json
 *     node afl-odds.mjs --html out.html
 *
 * Docs: https://puntersedge.online/blog/australian-odds-api-nodejs-guide?utm_source=afl-odds-api-example&utm_medium=code
 */

import https from "node:https";
import zlib from "node:zlib";
import fs from "node:fs";
import process from "node:process";

const HOST = "api.puntersedge.online";
const PREFIX = "/v1";
const USER_AGENT =
  "afl-odds-api-example/1.0 (+https://github.com/Propertyscout001/afl-odds-api-example)";
const SIGNUP_URL =
  "https://puntersedge.online/api?utm_source=afl-odds-api-example&utm_medium=code";

// The 14 Australian bookmakers the API serves, as of 2026-09-15.
// Live list: https://puntersedge.online/coverage-report
const BOOKMAKERS = [
  "tab", "tabtouch", "betdeluxe", "betr_au", "pointsbetau", "betright",
  "playup", "palmerbet", "unibet", "neds", "ladbrokes_au", "sportsbet",
  "betgold", "boostbet",
];

// The keyless demo endpoint has its OWN bookmaker vocabulary. It is narrower
// than the keyed API's and it is spelled differently, which is easy to miss
// because both take a `book` parameter. Send a keyed name like "betr_au" or
// "pointsbetau" and you get a 400, whose body lists the accepted set:
//
//   book must be one of: betr, ladbrokes, neds, pointsbet, sportsbet, tab, unibet
//
const DEMO_BOOKS = ["betr", "ladbrokes", "neds", "pointsbet", "sportsbet", "tab", "unibet"];

// Which keyed bookmaker each demo key actually serves. The five marked VERIFIED
// were established 2026-09-15 by comparing the demo price vectors against
// /v1/sports/afl/odds rather than by guessing from the spelling, which matters:
// demo "betr" matched betright on 4 of 4 prices, so it is betright, NOT betr_au.
// Each of the five matched exactly one keyed book outright. neds and unibet
// returned no data in the sandbox for afl or nrl, so there were no prices to
// compare and their mapping is only assumed from the name. Re-derive if the
// sandbox changes.
const DEMO_TO_KEYED = {
  betr: "betright",         // VERIFIED 4/4 prices
  ladbrokes: "ladbrokes_au", // VERIFIED 4/4 prices
  pointsbet: "pointsbetau",  // VERIFIED 4/4 prices
  sportsbet: "sportsbet",    // VERIFIED 6/6 prices
  tab: "tab",                // VERIFIED 4/4 prices
  neds: "neds",              // ASSUMED - no sandbox data to compare
  unibet: "unibet",          // ASSUMED - no sandbox data to compare
};

// The reverse direction, so --books accepts either spelling.
const KEYED_TO_DEMO = Object.fromEntries(
  Object.entries(DEMO_TO_KEYED).map(([demo, keyed]) => [keyed, demo])
);

// The demo `sport` vocabulary differs too, and has no aflw:
//   afl, cricket, greyhound-racing, horse-racing, mma, nba, nrl, rugby-union,
//   soccer, tennis
const DEMO_SPORTS = ["afl", "cricket", "greyhound-racing", "horse-racing", "mma",
  "nba", "nrl", "rugby-union", "soccer", "tennis"];

// /v1/demo/* is capped at 30 requests per minute per IP. Probing all seven demo
// books costs 8 calls including the best-odds call, which fits. Two runs (16)
// also fit; three do not.
const DEMO_RATE_LIMIT_PER_MIN = 30;

// Tokens that carry no identity when matching one bookmaker's spelling of a
// team against another's. "Hawthorn (W)" and "Hawthorn Hawks Women" are one team.
const NOISE_TOKENS = new Set(["w", "women", "womens", "ladies", "fc", "afc", "the"]);

// /v1/sports/afl/odds returns more than team-vs-team matches. On 2026-09-15 it
// also carried "AFL Brownlow H2H's" - Brodie Grundy v Christian Petracca, a
// player-vs-player market with one bookmaker on it. Same shape, same sport key,
// not a fixture. Filter on the `competition` field, which the keyed endpoints
// return and the demo envelope does not.
const NON_MATCH_MARKERS = [
  "brownlow", "h2h's", "player", "special", "medal", "margin", "futures", "outright",
];

class ApiError extends Error {
  constructor(status, title, detail, url) {
    const text = !detail || detail === title ? title : `${title}: ${detail}`;
    super(`${status} ${text} (${url})`);
    this.status = status;
    this.title = title;
    this.detail = detail;
    this.url = url;
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * One HTTPS connection, held open across every request.
 *
 * A cold request pays a TCP connect plus a TLS handshake before the request is
 * even sent; on a reused connection both are zero. Measured 2026-09-15 from a
 * residential connection in Australia: 46ms TCP and a further 104ms TLS. Your
 * own latency will differ - the point is that the handshake is paid once rather
 * than once per call, and the keyless path makes 8 calls in a row.
 *
 * node:https is used rather than global fetch so the agent, the gzip handling
 * and the byte counters are all explicit and match the Python port.
 */
class Client {
  constructor(apiKey = null, timeout = 15000, verbose = false) {
    this.apiKey = apiKey;
    this.timeout = timeout;
    this.verbose = verbose;
    this.agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    this.calls = 0;
    this.bytesOnWire = 0;
    this.bytesDecoded = 0;
    this.creditsUsed = 0;
  }

  close() {
    this.agent.destroy();
  }

  async get(path, params = null) {
    let url = PREFIX + path;
    if (params) {
      const qs = Object.entries(params)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join("&");
      if (qs) url += "?" + qs;
    }

    const headers = {
      Accept: "application/json",
      // Responses compress about 7x. Measured 2026-09-15 on
      // /v1/sports/afl/odds?markets=h2h: 7,491 bytes of JSON arrived as
      // 1,048 bytes on the wire.
      "Accept-Encoding": "gzip",
      "User-Agent": USER_AGENT,
      Connection: "keep-alive",
    };
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;

    // Retry ONLY when the connection died before any response byte arrived, and
    // say so out loud. A silent retry on a price endpoint can hand you a price
    // that was recorded before a move, which is worse than an error.
    let res = null;
    for (const attempt of [1, 2]) {
      try {
        res = await this._request(url, headers);
        break;
      } catch (err) {
        if (attempt === 2) throw new ApiError(0, "connection failed", String(err), url);
        process.stderr.write(
          `note: connection dropped on ${url} (${err.code || err.name}), reconnecting once\n`
        );
      }
    }

    this.calls += 1;
    this.bytesOnWire += res.raw.length;

    const body =
      (res.headers["content-encoding"] || "") === "gzip"
        ? zlib.gunzipSync(res.raw)
        : res.raw;
    this.bytesDecoded += body.length;

    const cost = res.headers["x-credits-cost"];
    if (cost && /^\d+$/.test(cost)) this.creditsUsed += parseInt(cost, 10);

    if (this.verbose) {
      process.stderr.write(
        `  GET ${url.padEnd(52)} ${res.status}  ${String(res.raw.length).padStart(5)} B wire  cost=${cost || "?"}\n`
      );
    }

    if (res.status >= 400) {
      let problem = {};
      try {
        problem = JSON.parse(body.toString("utf8"));
      } catch {
        /* not problem+json */
      }
      throw new ApiError(
        res.status,
        problem.title || res.statusMessage,
        problem.detail || body.toString("utf8").slice(0, 200),
        url
      );
    }

    return JSON.parse(body.toString("utf8"));
  }

  _request(url, headers) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        { host: HOST, path: url, method: "GET", headers, agent: this.agent },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              statusMessage: res.statusMessage,
              headers: res.headers,
              raw: Buffer.concat(chunks),
            })
          );
          res.on("error", reject);
        }
      );
      req.setTimeout(this.timeout, () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.end();
    });
  }
}

/**
 * Demo endpoints wrap results in an envelope; keyed endpoints return a bare
 * array. Handle both so the same parsing code serves either mode.
 *
 *   demo:  {"demo": true, "note": "...", "events": [...]}
 *   keyed: [...]
 */
function unwrap(payload, ...keys) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    for (const key of keys) if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Name normalisation
// ---------------------------------------------------------------------------

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s) {
  return new Set(norm(s).split(" ").filter((t) => t && !NOISE_TOKENS.has(t)));
}

/** How strongly `name` (a bookmaker's spelling) refers to `target`. */
function matchScore(name, target) {
  const a = norm(name);
  const b = norm(target);
  if (!a || !b) return 0;
  if (a === b) return 3;
  if (a.includes(b) || b.includes(a)) return 2;
  const ta = tokens(name);
  const tb = tokens(target);
  if (!ta.size || !tb.size) return 0;
  const shared = [...ta].filter((t) => tb.has(t));
  if (!shared.length) return 0;
  const union = new Set([...ta, ...tb]);
  return 1 + shared.length / union.size;
}

/**
 * Map a bookmaker's outcome name onto the fixture's home or away team.
 *
 * Bookmakers do not agree on team names inside a single fixture. Observed
 * 2026-09-15 on one AFL match: palmerbet and sportsbet quoted "Sydney Swans",
 * pointsbetau, betright and tab quoted "Sydney". Keying a table on the raw
 * outcome string splits one team into two columns.
 */
function resolveTeam(name, home, away) {
  const hs = matchScore(name, home);
  const as = matchScore(name, away);
  if (hs > as && hs >= 1) return "home";
  if (as > hs && as >= 1) return "away";
  return null;
}

/**
 * A merge key that is stable across bookmakers.
 *
 * `commence_time` is NOT stable: on AFLW the same match arrives as
 * 2026-09-18T07:45:00Z from one book and 2026-09-18T07:45:16Z from another.
 * `canonical_event_id` ends in a unix timestamp floored to a 30-minute bucket
 * and is byte-identical across books, so use that when it is present.
 */
function bucketKey(event) {
  const cid = event.canonical_event_id || "";
  const tail = cid.split(":").pop();
  if (/^\d+$/.test(tail)) return parseInt(tail, 10);
  const ts = parseTime(event.commence_time);
  if (ts === null) return null;
  return Math.floor(ts.getTime() / 1000 / 1800) * 1800;
}

function parseTime(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Fixture model
// ---------------------------------------------------------------------------

class Fixture {
  constructor(home, away, start, competition, key) {
    this.home = home;
    this.away = away;
    this.start = start;
    this.competitions = competition ? [competition] : [];
    this.key = key;
    this.prices = new Map();      // bookmaker -> {home, away}
    this.ages = new Map();        // bookmaker -> seconds since that book's quote
    this.marketBest = new Map();  // side -> [price, bookmaker]  from /best-odds
    this.unresolved = [];
  }

  /**
   * False for a market we can prove is not team-vs-team; null when the
   * competition label is absent (the demo envelope omits it).
   */
  isTeamMatch() {
    if (!this.competitions.length) return null;
    const low = this.competitions.join(" ").toLowerCase();
    return !NON_MATCH_MARKERS.some((m) => low.includes(m));
  }

  addPrice(book, outcomeName, price) {
    const side = resolveTeam(outcomeName, this.home, this.away);
    if (!side) {
      this.unresolved.push([book, outcomeName]);
      return;
    }
    if (!this.prices.has(book)) this.prices.set(book, {});
    this.prices.get(book)[side] = Number(price);
  }

  books() {
    const known = BOOKMAKERS.filter((b) => this.prices.has(b));
    const extra = [...this.prices.keys()].filter((b) => !BOOKMAKERS.includes(b)).sort();
    return known.concat(extra);
  }

  /** [price, [bookmakers]] for the highest price quoted on `side`. */
  best(side) {
    const quotes = [];
    for (const [book, sides] of this.prices) {
      if (sides[side] !== undefined) quotes.push([sides[side], book]);
    }
    if (!quotes.length) return [null, []];
    const top = Math.max(...quotes.map((q) => q[0]));
    return [top, quotes.filter(([p]) => p === top).map(([, b]) => b).sort()];
  }

  /**
   * Sum of implied probabilities. 1/price is the implied probability of an
   * outcome at that price; the sum across both outcomes is the overround. It is
   * arithmetic on the quoted numbers and describes nothing else.
   */
  overround(prices) {
    if (!prices.length || prices.some((p) => p <= 0)) return null;
    return prices.reduce((acc, p) => acc + 1 / p, 0);
  }

  bookOverrounds() {
    const out = new Map();
    for (const [book, sides] of this.prices) {
      if (sides.home !== undefined && sides.away !== undefined) {
        out.set(book, this.overround([sides.home, sides.away]));
      }
    }
    return out;
  }

  label() {
    return `${this.home} v ${this.away}`;
  }
}

/**
 * Collapse event rows that describe the same real match.
 *
 * On AFLW 2026-09-15 the API returned 18 rows for 9 matches: pointsbetau files
 * them under competition "AFLW" with team names like "Hawthorn Hawks Women",
 * ladbrokes_au and sportsbet file them under "Women's AFL" as "Hawthorn (W)".
 * Same kickoff bucket, overlapping team tokens, different rows.
 */
function mergeFixtures(fixtures) {
  const merged = [];
  for (const fx of fixtures) {
    let host = null;
    for (const existing of merged) {
      if (existing.key === null || fx.key === null) continue;
      if (existing.key !== fx.key) continue;
      const a = new Set([...tokens(existing.home), ...tokens(existing.away)]);
      const b = new Set([...tokens(fx.home), ...tokens(fx.away)]);
      const shared = [...a].filter((t) => b.has(t));
      if (shared.length >= 2) {
        host = existing;
        break;
      }
    }
    if (!host) {
      merged.push(fx);
      continue;
    }
    for (const comp of fx.competitions) {
      if (!host.competitions.includes(comp)) host.competitions.push(comp);
    }
    for (const [book, sides] of fx.prices) {
      for (const [side, price] of Object.entries(sides)) {
        // Re-resolve against the host's spelling of the teams.
        const name = side === "home" ? fx.home : fx.away;
        const target = resolveTeam(name, host.home, host.away);
        if (target) {
          if (!host.prices.has(book)) host.prices.set(book, {});
          host.prices.get(book)[target] = price;
        }
      }
    }
    for (const [k, v] of fx.ages) host.ages.set(k, v);
    for (const [k, v] of fx.marketBest) if (!host.marketBest.has(k)) host.marketBest.set(k, v);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/**
 * One call: /v1/sports/{sport}/odds?markets=h2h - every bookmaker, every
 * fixture, in a bare array. Costs 1 credit per market.
 */
async function loadKeyed(client, sport) {
  const payload = await client.get(`/sports/${sport}/odds`, { markets: "h2h" });
  const events = unwrap(payload, "events");
  const fixtures = [];
  for (const ev of events) {
    const fx = new Fixture(
      ev.home_team || "?", ev.away_team || "?",
      parseTime(ev.commence_time), ev.competition, bucketKey(ev)
    );
    for (const bk of ev.bookmakers || []) {
      const book = bk.key;
      for (const market of bk.markets || []) {
        if (market.key !== "h2h") continue;
        for (const outcome of market.outcomes || []) {
          fx.addPrice(book, outcome.name, outcome.price);
        }
      }
      if (bk.age_seconds !== undefined && bk.age_seconds !== null) {
        fx.ages.set(book, bk.age_seconds);
      }
    }
    fixtures.push(fx);
  }
  return [fixtures, `/v1/sports/${sport}/odds?markets=h2h`];
}

/**
 * No API key, 0 credits.
 *
 * /v1/demo/best-odds gives the market-wide best price per team but not the
 * per-book grid. /v1/demo/book-sport gives one book's prices at a time, so loop
 * it to build the grid. Not every book answers: measured 2026-09-15 for AFL,
 * five of the seven the sandbox accepts returned data (betr, ladbrokes,
 * pointsbet, sportsbet, tab) and two returned an empty item list (neds,
 * unibet).
 *
 * The two demo endpoints do not accept the same sports. /demo/best-odds serves
 * aflw; /demo/book-sport rejects it with a 400 (verified 2026-09-15). So for a
 * sport outside DEMO_SPORTS the per-book sweep is skipped: it can only return
 * seven 400s, and on a 30 requests/minute/IP cap that is a quarter of the
 * budget spent on a known miss. The same applies when /demo/best-odds returns
 * no events at all - there is nothing to attach per-book prices to.
 *
 * Mind that cap: a full run makes 1 + books.length calls, so the default
 * seven-book sweep costs 8.
 */
async function loadKeyless(client, sport, books = null, verbose = false) {
  // --books takes the demo vocabulary, but the table prints keyed names, so a
  // reader copying "betright" off the output would otherwise get a 400.
  // Translate keyed spellings back to the demo key before sending.
  let probe = books
    ? books.map((b) => KEYED_TO_DEMO[b.trim()] || b.trim())
    : [...DEMO_BOOKS];

  const payload = await client.get("/demo/best-odds", { sport });
  const events = unwrap(payload, "events");

  let skipReason = null;
  if (!DEMO_SPORTS.includes(sport)) {
    skipReason =
      `/v1/demo/book-sport does not accept sport=${sport} (400); ` +
      "only /v1/demo/best-odds does";
  } else if (!events.length) {
    skipReason = `/v1/demo/best-odds returned no ${sport} events to attach prices to`;
  }
  if (skipReason) {
    process.stderr.write(
      `note: skipping the ${probe.length} book probe(s) - ${skipReason}.\n` +
        `      That saves ${probe.length} of the ${DEMO_RATE_LIMIT_PER_MIN} requests/minute the demo allows.\n` +
        `      For the per-bookmaker grid use a free key: ${SIGNUP_URL}\n`
    );
    probe = [];
  }

  const fixtures = [];
  for (const ev of events) {
    const fx = new Fixture(
      ev.home_team || "?", ev.away_team || "?",
      parseTime(ev.commence_time), ev.competition, bucketKey(ev)
    );
    for (const sel of ev.selections || []) {
      const side = resolveTeam(sel.name, fx.home, fx.away);
      if (side && sel.best_price) {
        fx.marketBest.set(side, [Number(sel.best_price), sel.best_bookmaker]);
      }
    }
    fixtures.push(fx);
  }

  const responding = [];
  const failed = [];
  const attempted = [];
  for (const book of probe) {
    attempted.push(book);
    let payload2;
    try {
      payload2 = await client.get("/demo/book-sport", { book, sport });
    } catch (err) {
      // Do NOT fold a failed request in with "this book quoted nothing".
      // They look the same in the output and they are not the same thing.
      failed.push([book, err]);
      if (verbose) process.stderr.write(`  ${book}: ${err.message}\n`);
      if (err.status === 429) {
        process.stderr.write(
          `rate limited (${DEMO_RATE_LIMIT_PER_MIN}/min) after ${responding.length + failed.length} of ${probe.length} books; stopping the sweep\n`
        );
        break;
      }
      continue;
    }
    const items = unwrap(payload2, "items");
    if (!items.length) continue;
    responding.push(book);
    // Label the column with the keyed bookmaker name so the keyless grid and
    // the keyed grid can be read side by side.
    const label = DEMO_TO_KEYED[book] || book;
    for (const item of items) {
      const fx = findFixture(fixtures, item);
      if (!fx) continue;
      for (const price of item.prices || []) fx.addPrice(label, price.name, price.price);
    }
  }

  const source = probe.length
    ? `/v1/demo/best-odds + /v1/demo/book-sport x${probe.length}`
    : "/v1/demo/best-odds (per-book sweep skipped)";
  return [fixtures, [responding, attempted, probe, failed], source];
}

function findFixture(fixtures, item) {
  const home = item.home_team || "";
  const away = item.away_team || "";
  let best = null;
  let score = 0;
  for (const fx of fixtures) {
    const s =
      Math.max(matchScore(home, fx.home), matchScore(home, fx.away)) +
      Math.max(matchScore(away, fx.home), matchScore(away, fx.away));
    if (s > score) {
      best = fx;
      score = s;
    }
  }
  return score >= 2 ? best : null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmtLocal(dt, tzName = "Australia/Sydney") {
  if (!dt) return "time unknown";
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: tzName, weekday: "short", day: "2-digit", month: "short",
    year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    timeZoneName: "short",
  }).formatToParts(dt);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  // en-AU abbreviates September as "Sept"; Python's %b gives "Sep". Trim to
  // three characters so both ports print the same string.
  const month = p.month.slice(0, 3);
  return `${p.weekday} ${p.day} ${month} ${p.year} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

const padL = (s, n) => String(s).padStart(n);
const padR = (s, n) => String(s).padEnd(n);
const price2 = (p) => (p === null || p === undefined ? "-" : Number(p).toFixed(2));
const pctOf = (p) => (!p ? "-" : (100 / p).toFixed(2) + "%");
const clip = (s, n) => {
  s = s || "-";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
};
const bytesFmt = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n} B`);

/**
 * Best price to show for one side.
 *
 * The per-book grid wins when it exists. When it does not - keyless AFLW, where
 * /v1/demo/book-sport refuses the sport - /v1/demo/best-odds still returned a
 * market-wide best per team, and printing "-" would throw that away.
 * Returns [price, bookmaker, fromGrid].
 */
function effectiveBest(fx, side, bookBest) {
  if (bookBest !== null && bookBest !== undefined) return [bookBest, null, true];
  const mb = fx.marketBest.get(side);
  if (mb) return [mb[0], mb[1], false];
  return [null, null, true];
}

function render(fixtures, sport, source, client, mode, responding = null, width = 72) {
  const out = [];
  const w = (line = "") => out.push(line);

  const quoting = [...new Set(fixtures.flatMap((fx) => [...fx.prices.keys()]))].sort();
  w(`${sport.toUpperCase()} odds via PuntersEdge  -  head-to-head, decimal`);
  w(`source   ${source}`);
  w(`mode     ${mode}`);
  w(`fetched  ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}`);
  w(`market   ${fixtures.length} fixture(s), ${quoting.length} bookmaker(s) quoting: ${quoting.join(", ") || "none"}`);
  if (responding !== null) {
    const [answered, attempted, probed, failed] = responding;
    const bad = new Set(failed.map(([b]) => b));
    const silent = attempted.filter((b) => !answered.includes(b) && !bad.has(b));
    if (!probed.length) {
      w("sandbox  per-book sweep skipped, so this is /v1/demo/best-odds only:");
      w("         market-best price per team, no per-bookmaker grid");
      w("         (the reason is on stderr)");
    } else {
      w(`sandbox  asked ${attempted.length} of the ${DEMO_BOOKS.length} books the demo accepts, ${answered.length} returned data`);
      w("         demo book names differ from keyed ones (betr -> betright)");
    }
    if (silent.length) w(`         quoted nothing: ${silent.join(", ")}`);
    const skipped = probed.filter((b) => !attempted.includes(b));
    if (skipped.length) w(`         never asked: ${skipped.join(", ")}`);
    if (failed.length) {
      w(`         request failed: ${failed.map(([b, e]) => `${b} (${e.status})`).join(", ")}`);
      if (failed.some(([, e]) => e.status === 429)) {
        w("         -> 429 is the 30 requests/minute/IP demo cap, not a");
        w("            statement about what those bookmakers quote");
      }
    }
    // NOT "the keyed API serves 14 books". 14 is the RACING panel. The sports panel is
    // thinner, and printing the racing number inside an AFL tool tells the reader a free
    // key unlocks something it does not. Counts below were read off
    // /v1/sports/{key}/odds?markets=h2h on 2026-09-15.
    w("         a free key adds the books the sandbox withholds, but the sports");
    w("         panel is thinner than the racing one: measured 2026-09-15, afl and");
    w("         nrl carried 6 bookmakers, nba 5, aflw 3. 14 books is /v1/racing/*");
  }
  w();

  for (const fx of fixtures) {
    w("=".repeat(width));
    let title = fx.label();
    if (fx.isTeamMatch() === false) title += "   [not a team match]";
    w(title);
    const bits = [fmtLocal(fx.start)];
    if (fx.competitions.length) bits.push(fx.competitions.join(" + "));
    bits.push(`${fx.prices.size} book${fx.prices.size === 1 ? "" : "s"}`);
    if (fx.ages.size) bits.push(`freshest ${Math.min(...fx.ages.values())}s old`);
    w(bits.join("  "));
    w();

    const col = 12;
    const labelw = 36;
    const namew = labelw - 6;

    w(`  ${padR("bookmaker", 14)} ${padL(clip(fx.home, col), col)} ${padL(clip(fx.away, col), col)}`);
    const rule = "  " + "-".repeat(14) + " " + "-".repeat(col) + " " + "-".repeat(col);
    w(rule);
    if (!fx.prices.size) {
      w(fx.marketBest.size
        ? "  (no per-book grid here; the market-best prices are below)"
        : "  (no bookmaker returned a price for this fixture)");
    }
    for (const book of fx.books()) {
      const sides = fx.prices.get(book);
      w(`  ${padR(book, 14)} ${padL(price2(sides.home), col)} ${padL(price2(sides.away), col)}`);
    }
    w(rule);

    const [bestH, atH] = fx.best("home");
    const [bestA, atA] = fx.best("away");
    const [effH] = effectiveBest(fx, "home", bestH);
    const [effA] = effectiveBest(fx, "away", bestA);
    w(`  ${padR("best", 14)} ${padL(price2(effH), col)} ${padL(price2(effA), col)}`);
    w(`  ${padR("implied", 14)} ${padL(pctOf(effH), col)} ${padL(pctOf(effA), col)}`);
    w();

    for (const [side, team, price, at] of [
      ["home", fx.home, bestH, atH],
      ["away", fx.away, bestA, atA],
    ]) {
      if (price === null) {
        // No per-book grid, but /demo/best-odds still gave the market-wide
        // best. Showing "-" would throw data away.
        const [eff, mbBook] = effectiveBest(fx, side, null);
        if (eff !== null) {
          w(`  ${padR("best " + clip(team, namew), labelw)}${padL(eff.toFixed(2), 7)}  at ${mbBook}  (market best; no per-book grid)`);
        } else {
          w(`  ${padR("best " + clip(team, namew), labelw)}${padL("-", 7)}`);
        }
        continue;
      }
      let line = `  ${padR("best " + clip(team, namew), labelw)}${padL(price.toFixed(2), 7)}  at ${at.join(", ")}`;
      const mb = fx.marketBest.get(side);
      if (mb && mb[0] > price + 1e-9) {
        line += `   (market best ${mb[0].toFixed(2)} at ${mb[1]})`;
      }
      w(line);
    }

    const orr = fx.overround([effH, effA].filter((p) => p));
    if (orr && effH && effA) {
      w(`  ${padR("overround at best-of-market prices", labelw)}${padL((orr * 100).toFixed(2) + "%", 7)}`);
      const per = [...fx.bookOverrounds().entries()];
      if (per.length > 1) {
        const lo = per.reduce((a, b) => (b[1] < a[1] ? b : a));
        const hi = per.reduce((a, b) => (b[1] > a[1] ? b : a));
        if (Math.abs(hi[1] - lo[1]) < 1e-9) {
          w(`  ${padR("same sum inside one book", labelw)}${padL((lo[1] * 100).toFixed(2) + "%", 7)}  every book`);
        } else {
          w(`  ${padR("same sum inside one book", labelw)}${padL((lo[1] * 100).toFixed(2) + "%", 7)}  ${lo[0]}`);
          w(`  ${padR("", labelw)}${padL((hi[1] * 100).toFixed(2) + "%", 7)}  ${hi[0]}`);
        }
      } else if (per.length === 1) {
        const only = per[0];
        w(`  ${padR("same sum inside one book", labelw)}${padL((only[1] * 100).toFixed(2) + "%", 7)}  ${only[0]}`);
      }
    } else {
      w("  overround unavailable - a price is missing on one side");
    }

    if (fx.unresolved.length) {
      w(`  unmatched outcome names: ${fx.unresolved.map(([b, n]) => `${b}='${n}'`).join(", ")}`);
    }
    w();
  }

  w("=".repeat(width));
  const ratio = client.bytesOnWire ? client.bytesDecoded / client.bytesOnWire : 0;
  w(`${client.calls} HTTP call(s) on one connection, ${client.creditsUsed} credits`);
  w(`${bytesFmt(client.bytesOnWire)} on the wire, ${bytesFmt(client.bytesDecoded)} after gunzip (${ratio.toFixed(1)}x)`);
  w();
  w("Implied probability = 1/price. Overround = the sum of those across the");
  w("two outcomes. Both are arithmetic on the quoted prices and nothing more.");
  return out.join("\n");
}

function toJson(fixtures, sport, source, mode) {
  const rows = fixtures.map((fx) => {
    const [bestH, atH] = fx.best("home");
    const [bestA, atA] = fx.best("away");
    return {
      fixture: fx.label(),
      home_team: fx.home,
      away_team: fx.away,
      commence_time: fx.start ? fx.start.toISOString() : null,
      competitions: fx.competitions,
      bookmaker_count: fx.prices.size,
      prices: Object.fromEntries(
        [...fx.prices].map(([b, v]) => [b, { home: v.home ?? null, away: v.away ?? null }])
      ),
      best: {
        home: { price: bestH, bookmakers: atH, implied_probability: bestH ? 1 / bestH : null },
        away: { price: bestA, bookmakers: atA, implied_probability: bestA ? 1 / bestA : null },
      },
      overround_at_best: fx.overround([bestH, bestA].filter((p) => p)),
      overround_by_bookmaker: Object.fromEntries(fx.bookOverrounds()),
    };
  });
  return JSON.stringify(
    {
      sport, source, mode,
      generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      fixtures: rows,
    },
    null, 2
  );
}

function toHtml(fixtures, sport, source, mode) {
  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // The page is written for whichever sport was asked for. Hard-coding "AFL"
  // here once produced an --sport aflw page headed "AFL head-to-head odds"
  // above nine AFLW fixtures.
  const label = esc(sport.toUpperCase());
  const dataLink =
    sport === "afl"
      ? "https://puntersedge.online/afl-odds-api-australia"
      : "https://puntersedge.online/developers/sports-odds-api-australia";
  const dataText =
    sport === "afl"
      ? "PuntersEdge AFL odds API"
      : "PuntersEdge sports odds API (Australia)";
  const parts = [`<!doctype html><meta charset="utf-8">
<title>${label} odds grid</title>
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
</style><main>`];
  parts.push(`<h1>${label} head-to-head odds &mdash; best price per team</h1>`);
  parts.push(
    `<p class="meta">Snapshot taken ${new Date()
      .toISOString()
      .slice(0, 16)
      .replace("T", " ")} UTC &middot; prices move, re-run to refresh<br>${esc(
      source
    )}<br>${esc(mode)}</p>`
  );

  for (const fx of fixtures) {
    const [bestH, atH0] = fx.best("home");
    const [bestA, atA0] = fx.best("away");
    const [effH, mbH, gridH] = effectiveBest(fx, "home", bestH);
    const [effA, mbA, gridA] = effectiveBest(fx, "away", bestA);
    const atH = gridH ? atH0 : mbH ? [mbH] : [];
    const atA = gridA ? atA0 : mbA ? [mbA] : [];
    parts.push(`<section><h2>${esc(fx.label())}</h2>`);
    parts.push(
      `<p class="sub">${esc(fmtLocal(fx.start))} &middot; ${esc(fx.competitions.join(" / ") || "-")} &middot; ${fx.prices.size} bookmaker(s)</p>`
    );
    parts.push(
      `<table><thead><tr><th>bookmaker</th><th>${esc(fx.home)}</th><th>${esc(fx.away)}</th></tr></thead><tbody>`
    );
    for (const book of fx.books()) {
      const s = fx.prices.get(book);
      parts.push(`<tr><td>${esc(book)}</td><td>${price2(s.home)}</td><td>${price2(s.away)}</td></tr>`);
    }
    parts.push(`<tr class="best"><td>best</td><td>${price2(effH)}</td><td>${price2(effA)}</td></tr>`);
    parts.push(`<tr class="sub"><td>at</td><td>${esc(atH.join(",") || "-")}</td><td>${esc(atA.join(",") || "-")}</td></tr>`);
    parts.push(`<tr class="sub"><td>implied probability</td><td>${pctOf(effH)}</td><td>${pctOf(effA)}</td></tr>`);
    parts.push("</tbody></table>");
    if (!fx.prices.size && (effH || effA)) {
      parts.push(
        '<p class="note">No per-bookmaker grid for this fixture; the row above ' +
          "is the market-wide best price from /v1/demo/best-odds.</p>"
      );
    }
    const orr = fx.overround([effH, effA].filter((p) => p));
    if (orr) {
      parts.push(`<p class="orr">Overround at best-of-market prices <b>${(orr * 100).toFixed(2)}%</b></p>`);
      const per = [...fx.bookOverrounds().entries()];
      if (per.length) {
        const lo = per.reduce((a, b) => (b[1] < a[1] ? b : a));
        const hi = per.reduce((a, b) => (b[1] > a[1] ? b : a));
        parts.push(
          `<p class="note">Same sum inside a single book: ${(lo[1] * 100).toFixed(2)}% (${esc(lo[0])}) to ${(hi[1] * 100).toFixed(2)}% (${esc(hi[0])})</p>`
        );
      }
    }
    parts.push("</section>");
  }

  parts.push(
    '<footer>Implied probability is 1/price; the overround is the sum of ' +
      "those across both outcomes. Both are arithmetic on the quoted prices " +
      "and describe nothing else.<br><br>" +
      "18+ only. Gambling can be addictive &mdash; please gamble responsibly. " +
      "Gambling Help: 1800 858 858 &middot; " +
      '<a href="https://www.gambleaware.nsw.gov.au">gambleaware.nsw.gov.au</a><br>' +
      `Data: <a href="${dataLink}` +
      `?utm_source=afl-odds-api-example&amp;utm_medium=demo">${dataText}</a>. ` +
      "This page is a developer example for reading an odds data feed. It is not " +
      "betting advice, it places no bets and it holds no bookmaker credentials." +
      "</footer></main>"
  );
  return parts.join("\n");
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    sport: "afl", keyless: false, json: false, html: null,
    books: null, verbose: false, matchesOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sport") args.sport = argv[++i];
    else if (a === "--keyless") args.keyless = true;
    else if (a === "--json") args.json = true;
    else if (a === "--html") args.html = argv[++i];
    else if (a === "--books") args.books = argv[++i];
    else if (a === "--matches-only") args.matchesOnly = true;
    else if (a === "-v" || a === "--verbose") args.verbose = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        "usage: node afl-odds.mjs [--sport afl|aflw] [--keyless] [--matches-only]\n" +
          "                         [--json] [--html FILE] [--books a,b] [-v]\n" +
          "\n" +
          "  --sport         afl (default) or aflw\n" +
          "  --keyless       force the no-key sandbox path even if PE_API_KEY is set\n" +
          "  --matches-only  drop markets that are not team-vs-team\n" +
          "  --json          emit JSON instead of a table\n" +
          "  --html FILE     also write an HTML table to FILE\n" +
          "  --books a,b     comma-separated bookmakers to probe in keyless mode.\n" +
          `                  The demo endpoint accepts: ${DEMO_BOOKS.join(", ")}.\n` +
          "                  Keyed spellings (betright, ladbrokes_au, pointsbetau)\n" +
          "                  are translated for you.\n" +
          "  -v, --verbose   log each HTTP call"
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const key = args.keyless ? null : process.env.PE_API_KEY || null;
  const client = new Client(key, 15000, args.verbose);
  const started = Date.now();

  let fixtures, responding = null, source, mode;
  try {
    if (key) {
      [fixtures, source] = await loadKeyed(client, args.sport);
      mode = "keyed (PE_API_KEY set)";
    } else {
      const books = args.books ? args.books.split(",") : null;
      [fixtures, responding, source] = await loadKeyless(client, args.sport, books, args.verbose);
      mode = "keyless sandbox (0 credits, no registration)";
    }
  } catch (err) {
    process.stderr.write(`API error: ${err.message}\n`);
    if (err.status === 429) {
      process.stderr.write(
        `The demo endpoints allow ${DEMO_RATE_LIMIT_PER_MIN} requests/minute/IP. ` +
          "Wait a minute, or ask for fewer books (--books tab,sportsbet), " +
          "or use a free key.\n"
      );
    }
    if (err.status === 401 || err.status === 429) {
      process.stderr.write(
        `Get a free key (1,500 credits/month, no card): ${SIGNUP_URL}\n`
      );
    }
    client.close();
    process.exitCode = 2;
    return;
  }

  fixtures = mergeFixtures(fixtures);
  fixtures = fixtures.filter((fx) => fx.prices.size || fx.marketBest.size);
  if (args.matchesOnly) {
    for (const fx of fixtures.filter((f) => f.isTeamMatch() === false)) {
      process.stderr.write(
        `dropped non-match market: ${fx.label()} (${fx.competitions.join(" + ")})\n`
      );
    }
    fixtures = fixtures.filter((fx) => fx.isTeamMatch() !== false);
    if (!key) {
      process.stderr.write(
        "note: --matches-only has nothing to filter on in keyless mode; " +
          "the demo envelope omits the competition field\n"
      );
    }
  }
  fixtures.sort((a, b) => (a.start?.getTime() ?? Infinity) - (b.start?.getTime() ?? Infinity));

  if (args.html) {
    fs.writeFileSync(args.html, toHtml(fixtures, args.sport, source, mode));
    process.stderr.write(`wrote ${args.html}\n`);
  }

  if (args.json) {
    console.log(toJson(fixtures, args.sport, source, mode));
  } else {
    console.log(render(fixtures, args.sport, source, client, mode, responding));
    console.log(`elapsed ${((Date.now() - started) / 1000).toFixed(2)}s`);
  }

  client.close();
}

main();
