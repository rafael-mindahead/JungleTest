#!/usr/bin/env bash
set -euo pipefail

# Records process CPU, RSS memory, and open file descriptors on macOS/Linux.
# PID must be the Bun server process. CPU % can exceed 100 on multicore hosts.
PID="${1:?Usage: bash scripts/bench/sample-process.sh <pid> [duration_seconds] [output.csv]}"
DURATION="${2:-300}"
OUTPUT="${3:-artifacts/bench/process.csv}"
mkdir -p "$(dirname "$OUTPUT")"
echo 'timestamp_unix,pid,cpu_percent,rss_kib,fd_count' > "$OUTPUT"
END=$((SECONDS + DURATION))
while (( SECONDS < END )); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "Process $PID no longer exists" >&2
    exit 1
  fi
  CPU="$(ps -p "$PID" -o %cpu= | tr -d '[:space:]')"
  RSS="$(ps -p "$PID" -o rss= | tr -d '[:space:]')"
  if command -v lsof >/dev/null 2>&1; then
    FD="$(lsof -p "$PID" 2>/dev/null | awk 'NR > 1 { n++ } END { print n+0 }')"
  elif [[ -d "/proc/$PID/fd" ]]; then
    FD="$(find "/proc/$PID/fd" -mindepth 1 -maxdepth 1 | wc -l | tr -d '[:space:]')"
  else
    FD="-1"
  fi
  echo "$(date +%s),$PID,$CPU,$RSS,$FD" >> "$OUTPUT"
  sleep 5
done
echo "Samples saved to $OUTPUT"
