#!/bin/sh
# Run the Python and the Node implementation back to back and diff their output.
#
# They are ports of each other and print the same table, so the diff should be
# empty once the lines that cannot match between two separate runs are scrubbed:
#
#   fetched <ts>        wall clock, different second
#   freshest <n>s old   how old the bookmaker quote was at fetch time
#   elapsed <t>         how long the run took
#   <wire bytes>        the two gzip streams differ by a few bytes
#
# Three outcomes:
#   identical      the ports agree
#   inconclusive   one run was rate limited, so it saw less data than the other
#   differences    printed for you to read - a price that moved between the two
#                  runs looks the same here as a real bug in one of the ports
#
# Usage:  ./compare.sh [args passed to both]
#         ./compare.sh --keyless
#         ./compare.sh --sport aflw
set -eu

cd "$(dirname "$0")"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# The keyless path costs 8 requests against a 30/minute/IP cap on /v1/demo/*,
# and two runs cost 16. Pause between them so the second is not starved by the
# first. Set PE_COMPARE_PAUSE=0 to skip if you know the window is clear.
PAUSE=${PE_COMPARE_PAUSE-0}
case " $* " in
    *" --keyless "*) [ -n "${PE_API_KEY-}" ] || PAUSE=${PE_COMPARE_PAUSE-65} ;;
esac
[ -z "${PE_API_KEY-}" ] && PAUSE=${PE_COMPARE_PAUSE-65}

python3 python/afl_odds.py "$@" >"$WORK/py.out" 2>"$WORK/py.err" || true
if [ "$PAUSE" -gt 0 ]; then
    echo "pausing ${PAUSE}s between runs (demo endpoints allow 30 req/min/IP)" >&2
    sleep "$PAUSE"
fi
node node/afl-odds.mjs "$@" >"$WORK/js.out" 2>"$WORK/js.err" || true

# A rate-limited run saw fewer bookmakers than the other. That is not the two
# implementations disagreeing, and reporting it as one would be a lie.
if grep -q '429' "$WORK/py.out" "$WORK/py.err" "$WORK/js.out" "$WORK/js.err" 2>/dev/null; then
    echo "inconclusive: at least one run hit the demo rate limit (30 req/min/IP)."
    echo "The two runs did not see the same data, so the diff would be meaningless."
    echo "Wait a minute and try again, or export PE_API_KEY and compare the keyed path."
    exit 2
fi

if [ ! -s "$WORK/py.out" ] || [ ! -s "$WORK/js.out" ]; then
    echo "inconclusive: one of the runs produced no output." >&2
    cat "$WORK/py.err" "$WORK/js.err" >&2
    exit 2
fi

scrub() {
    sed -E \
        -e 's/^fetched .*/fetched <ts>/' \
        -e 's/freshest [0-9]+s old/freshest <n>s old/' \
        -e 's/^elapsed .*/elapsed <t>/' \
        -e 's/^[0-9.]+ [kM]?B on the wire.*/<wire bytes>/' \
        "$1"
}

scrub "$WORK/py.out" >"$WORK/py.s"
scrub "$WORK/js.out" >"$WORK/js.s"

if diff -u "$WORK/py.s" "$WORK/js.s"; then
    echo "python3 python/afl_odds.py $* == node node/afl-odds.mjs $*"
    echo "identical (after scrubbing timestamp, quote age, elapsed, wire bytes)"
else
    echo
    echo "differences above. Two things look identical here:"
    echo "  - a price that moved between the two runs (real change in the data)"
    echo "  - one port doing the wrong thing (a bug)"
    echo "Re-run: if the same cells differ again, look at the code."
    exit 1
fi
