#!/usr/bin/env bash
# Usage: run-oc.sh <model> <variant> <workdir> <dispatch-name> [session-id]
# Runs opencode on $LEDGER/<dispatch-name>.md in <workdir>; a session id resumes that session.
# Set LEDGER (ledger dir) and TITLE (short run name) before use, e.g. in the copied script.
# Watchdog: opencode sometimes hangs at init with no output; if the log is still empty
# after 5 min, kill our own child and retry (up to 3 attempts).
set -u
W=${LEDGER:?set LEDGER}
title=${TITLE:-build}
model=$1; variant=$2; dir=$3; name=$4
args=(run -m "$model" --variant "$variant" --dir "$dir" --title "$title-$name")
if [ $# -ge 5 ]; then args+=(-s "$5"); fi
log="$W/$name-opencode.log"
for attempt in 1 2 3; do
  echo "start $(date -Is) pid $$ attempt $attempt" > "$log"
  opencode "${args[@]}" "$(cat "$W/$name.md")" >> "$log" 2>&1 &
  child=$!
  hung=0
  for i in $(seq 1 30); do
    sleep 10
    kill -0 $child 2>/dev/null || break
    if [ $i -eq 30 ] && [ "$(wc -l < "$log")" -le 1 ]; then hung=1; kill $child; fi
  done
  if [ $hung -eq 0 ]; then wait $child; code=$?; echo "exit $code $(date -Is)" >> "$log"; exit $code; fi
  wait $child 2>/dev/null
  echo "init hang on attempt $attempt, retrying" >> "$W/progress.md"
done
echo "exit 99 $(date -Is) init hang x3" >> "$log"
exit 99
