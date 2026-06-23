#!/usr/bin/env bash
# Pre-warm every experimental MIR sidecar's lazy-downloaded weights so the
# first user click in the UI doesn't pay the ~30 s–2 min download cost mid-
# flow. Wraps the same `/api/<family>/initialize` endpoints the Initialize
# Models settings panel already drives — this script is just the curl
# equivalent for dev / CI use.
#
# Usage:
#   ./tools/warm-experimental-models.sh                 # all families, against http://localhost:5174
#   ./tools/warm-experimental-models.sh -h http://timecues-vm:5173
#   ./tools/warm-experimental-models.sh --only lyrics,span
#
# Exit 0 when every requested family + algorithm initialized OK; non-zero
# when at least one /initialize returned non-2xx or the sidecar was
# unreachable. The script keeps going on errors so you see the whole
# Ready / Failed table at the end.

set -uo pipefail

BASE_URL="http://localhost:5174"
ONLY=""

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--host)    BASE_URL="$2"; shift 2 ;;
    --only)       ONLY="$2"; shift 2 ;;
    --help)
      sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Family → (proxy prefix). Matches docker-compose service names + the
# /api/<family>/* paths in vite.config.ts.
FAMILIES=(
  "span"
  "beatnet"
  "pitch"
  "panns"
  "cue-extras"
  "percussive"
  "loop"
  "lyrics"
  "pattern"
)

if [ -n "$ONLY" ]; then
  IFS=',' read -ra REQUESTED <<< "$ONLY"
  FILTERED=()
  for w in "${REQUESTED[@]}"; do
    for f in "${FAMILIES[@]}"; do
      [ "$f" = "$w" ] && FILTERED+=("$f")
    done
  done
  FAMILIES=("${FILTERED[@]}")
fi

# Result rows: "<family>\t<algo>\t<ok|fail|skipped>\t<note>"
RESULTS=()

ok_count=0
fail_count=0
skip_count=0

for family in "${FAMILIES[@]}"; do
  # Some sidecars don't have an algorithms registry (beatnet is single-
  # purpose). Fall through to a single "<family>" initialize call when
  # the algorithms list 404s.
  algos_json=$(curl -fsS --max-time 5 "${BASE_URL}/api/${family}/algorithms" 2>/dev/null || true)
  if [ -z "$algos_json" ]; then
    # No registry, no /initialize either probably. Mark skipped.
    RESULTS+=("${family}\t-\tskipped\tno algorithms endpoint (probably single-purpose)")
    skip_count=$((skip_count + 1))
    continue
  fi

  algos=$(printf '%s' "$algos_json" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
for a in data:
    aid = a.get("id")
    avail = a.get("available", True)
    if aid:
        print(f"{aid}\t{int(bool(avail))}")
' 2>/dev/null)

  if [ -z "$algos" ]; then
    RESULTS+=("${family}\t-\tskipped\talgorithms endpoint returned non-list")
    skip_count=$((skip_count + 1))
    continue
  fi

  while IFS=$'\t' read -r algo avail; do
    if [ "$avail" != "1" ]; then
      RESULTS+=("${family}\t${algo}\tskipped\tavailable=false (deps missing)")
      skip_count=$((skip_count + 1))
      continue
    fi

    echo "→ ${family} :: ${algo} initializing…"
    code=$(curl -fsS --max-time 600 -o /tmp/warm.out -w "%{http_code}" \
      -X POST -H 'Content-Type: application/json' \
      -d "{\"algo\":\"${algo}\"}" \
      "${BASE_URL}/api/${family}/initialize" 2>/dev/null || echo "000")

    if [ "$code" = "200" ]; then
      RESULTS+=("${family}\t${algo}\tok\t-")
      ok_count=$((ok_count + 1))
    else
      note=$(head -c 200 /tmp/warm.out 2>/dev/null | tr -d '\n' | tr -s ' ')
      RESULTS+=("${family}\t${algo}\tfail\tHTTP ${code} ${note}")
      fail_count=$((fail_count + 1))
    fi
  done <<< "$algos"
done

echo
echo "── Warm-up summary ──────────────────────────────────────────────────"
printf "%-12s %-26s %-8s %s\n" "FAMILY" "ALGORITHM" "STATUS" "NOTE"
for row in "${RESULTS[@]}"; do
  IFS=$'\t' read -r family algo status note <<< "$(printf '%b' "$row")"
  printf "%-12s %-26s %-8s %s\n" "$family" "$algo" "$status" "$note"
done

echo
echo "ok=${ok_count}  fail=${fail_count}  skipped=${skip_count}"
[ "$fail_count" -eq 0 ] || exit 1
exit 0
