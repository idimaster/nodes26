#!/usr/bin/env bash
# T5.2 rehearsal: N timed runs (default 5) of the whole release check, each from a reloaded graph:
#   reset → npm test → npm run test:ui → npm run demo:replay
# Stops at the first failure and keeps every step's log. Writes reports/rehearsal.json.
# By default it runs against its own Neo4j container (fresh volumes, other ports), so open Claude Code
# sessions and the console on the main database are neither wiped nor able to interfere; the container is
# removed afterwards. --shared uses the main database instead (it is wiped and reloaded many times).
# Needs the Playwright browser (npx playwright install chromium).
set -uo pipefail
cd "$(dirname "$0")/.."
shared=false
[[ "${1:-}" == "--shared" ]] && { shared=true; shift; }
runs="${1:-5}"
if ! $shared; then
  export COMPOSE_PROJECT_NAME=planner-rehearsal NEO4J_CONTAINER=planner-rehearsal-neo4j NEO4J_HTTP_PORT=27474 NEO4J_BOLT_PORT=27687
  export NEO4J_URI=neo4j://localhost:27687
  trap 'docker compose down -v >/dev/null 2>&1' EXIT
  echo "rehearsal: starting an isolated Neo4j on bolt port ${NEO4J_BOLT_PORT}"
  docker compose up -d --wait >/dev/null 2>&1 || { echo "rehearsal: the isolated Neo4j did not become healthy" >&2; exit 1; }
  npm run -s load >/dev/null || { echo "rehearsal: could not load the isolated Neo4j" >&2; exit 1; }
fi
out=reports/rehearsal
rm -rf "$out" && mkdir -p "$out"
results=()

step() { # run, name, command...
  local run="$1" name="$2"; shift 2
  local log="$out/run-${run}-${name}.log" t0 t1 status
  t0=$(date +%s)
  "$@" >"$log" 2>&1; status=$?
  t1=$(date +%s)
  results+=("{\"run\":${run},\"step\":\"${name}\",\"seconds\":$((t1 - t0)),\"ok\":$([[ $status == 0 ]] && echo true || echo false)}")
  printf 'run %s  %-8s %4ss  %s\n' "$run" "$name" "$((t1 - t0))" "$([[ $status == 0 ]] && echo ok || echo "FAILED (see $log)")"
  return $status
}

write_report() {
  local IFS=,
  printf '{"runs":%s,"steps":[%s]}\n' "$runs" "${results[*]}" > reports/rehearsal.json
}

for run in $(seq 1 "$runs"); do
  t0=$(date +%s)
  step "$run" reset ./scripts/reset-demo.sh &&
    step "$run" test npm test &&
    step "$run" test-ui npm run -s test:ui &&
    step "$run" replay npm run -s demo:replay ||
    { write_report; echo "rehearsal: run ${run} failed" >&2; exit 1; }
  echo "run ${run}: green in $(( $(date +%s) - t0 ))s"
done
write_report
echo "rehearsal: ${runs}/${runs} runs green; report: reports/rehearsal.json"
