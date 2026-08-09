#!/bin/bash
# tuipr smoke test — drives the real TUI in tmux and asserts on the screen.
#
# WHY THIS EXISTS: the unit tests cover the pure contracts, but every bug this
# project has found so far only appeared when the program actually ran — a
# pattern that stopped matching after a translation, an entry point that
# returned silently, a module missing from a bundle, a key that quit the app.
# None of them were visible from reading the code, and none would have failed a
# unit test.
#
# Deliberately small. It presses the keys a first-time user presses and checks
# what appears. It is a smoke test, not a suite: it should stay fast enough to
# run on every change without anyone weighing whether it is worth it.
#
# USAGE:  scripts/smoke.sh <path-to-a-git-repo-with-open-PRs>
#
# The repository argument matters: the queue is real data from a real remote,
# because the interesting failures come from real values (a draft, a conflict,
# an already-approved PR), not from fixtures.

set -u

REPO="${1:-}"
if [ -z "$REPO" ] || [ ! -d "$REPO/.git" ]; then
  echo "usage: scripts/smoke.sh <path-to-a-git-repo-with-open-PRs>" >&2
  exit 2
fi

ENTRY="$(cd "$(dirname "$0")/.." && pwd)/bin/tuipr.mjs"
PANE="tuipr-smoke-$$"
pass=0
fail=0

cleanup() { tmux kill-session -t "$PANE" 2>/dev/null; }
trap cleanup EXIT

cap() { tmux capture-pane -t "$PANE" -p; }
key() { tmux send-keys -t "$PANE" "$1"; sleep "${2:-1}"; }

check() { # name, pattern
  if cap | grep -q "$2"; then echo "  PASS  $1"; pass=$((pass + 1))
  else echo "  FAIL  $1  (expected /$2/)"; fail=$((fail + 1)); fi
}
check_absent() { # name, pattern
  if cap | grep -q "$2"; then echo "  FAIL  $1  (unexpected /$2/)"; fail=$((fail + 1))
  else echo "  PASS  $1"; pass=$((pass + 1)); fi
}

echo "== tuipr smoke =="
tmux new-session -d -s "$PANE" -x 150 -y 30
tmux send-keys -t "$PANE" "cd '$REPO' && node '$ENTRY'" Enter

# The queue is fetched over the network, so this waits rather than assuming.
for _ in $(seq 1 30); do
  cap | grep -q "PRs in the queue" && break
  sleep 1
done

echo "-- it starts --"
check "queue loads"              "PRs in the queue"
check "header names the tool"    "tuipr"
check "footer lists the keys"    "j/k: row"
check "a status mark renders"    "in queue"
check "cursor sits on a row"     "^❯"

echo "-- navigation --"
before=$(cap | grep '^❯' | head -1)
key j
after=$(cap | grep '^❯' | head -1)
if [ "$before" != "$after" ]; then echo "  PASS  j moves down"; pass=$((pass + 1))
else echo "  FAIL  j moves down"; fail=$((fail + 1)); fi
key k
if [ "$(cap | grep '^❯' | head -1)" = "$before" ]; then echo "  PASS  k moves back"; pass=$((pass + 1))
else echo "  FAIL  k moves back"; fail=$((fail + 1)); fi

echo "-- detail panel --"
key Enter 2
check "panel opens"              "Info: #"
check "it states the state"      "state:"
check "it names the branch"      "branch:"
check "it says what is unmeasured" "not measured"
key Escape 1
check_absent "Esc closes it"     "Info: #"

echo "-- Esc does not quit from the list --"
# This one is a regression guard with a story: Esc used to quit here, throwing
# away a queue that takes seconds to load, on the key that means "cancel"
# everywhere else in the app.
key Escape 1
check "Esc says what quits"      "press q to quit"
check "the app is still running" "^❯"

echo "-- an unwired feature says so --"
key c 4
check "it names itself as unwired" "not wired up in this build"
check "and refuses to imply a result" "does not imply"
key Escape 1

echo "-- it quits on q --"
key q 2
check_absent "the list is gone"  "PRs in the queue"

echo
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ]
