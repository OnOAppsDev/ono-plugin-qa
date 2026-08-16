#!/usr/bin/env bash
# Tests for hooks/block-qa-repo-git-writes.sh.
#
# Exit 0 from the hook = allow, exit 2 = block. Every fixture is a throwaway git
# repo under a temp workspace, so the suite touches nothing real and never needs
# to create a commit (`git rev-parse --show-toplevel` works on an empty repo).
#
# Run: bash hooks/block-qa-repo-git-writes.test.sh
set -uo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/block-qa-repo-git-writes.sh"
[ -x "$HOOK" ] || { echo "FATAL: $HOOK is not executable"; exit 1; }

pass=0
fail=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

new_repo() { # <path>
  mkdir -p "$1"
  git -C "$1" init --quiet
  (cd "$1" && pwd -P)
}

# A workspace laid out the way the plugin expects: a code repo and a QA repo as
# siblings, plus an unrelated repo and a plugin-source clone elsewhere.
WS="$WORK/workspace"
QA_REPO="$(new_repo "$WS/acme-qa")"
CODE_REPO="$(new_repo "$WS/acme-app")"
OTHER_REPO="$(new_repo "$WORK/ono-mobile-dev-plugin")"
PLUGIN_REPO="$(new_repo "$WORK/some-clone-name")"
mkdir -p "$PLUGIN_REPO/.claude-plugin"
printf '{\n  "name": "ono-plugin-qa",\n  "version": "0.4.1"\n}\n' >"$PLUGIN_REPO/.claude-plugin/plugin.json"
NOT_A_REPO="$WORK/loose-folder"
mkdir -p "$NOT_A_REPO"
# A feature folder inside the QA repo — the plugin writes test-plan.md into one
# of these, so a commit run from there must still be caught.
mkdir -p "$QA_REPO/feature-slug"

check() { # <description> <expected: allow|block> <cwd> <command> [tool]
  local desc="$1" expected="$2" cwd="$3" cmd="$4" tool="${5:-Bash}"
  local payload actual_code actual

  payload="$(jq -n --arg t "$tool" --arg c "$cmd" --arg d "$cwd" \
    '{tool_name: $t, cwd: $d, tool_input: {command: $c}}')"

  echo "$payload" | "$HOOK" >/dev/null 2>&1
  actual_code=$?
  case "$actual_code" in
    0) actual="allow" ;;
    2) actual="block" ;;
    *) actual="exit:$actual_code" ;;
  esac

  if [ "$actual" = "$expected" ]; then
    printf 'PASS  %s\n' "$desc"
    pass=$((pass + 1))
  else
    printf 'FAIL  %s\n        expected %s, got %s\n' "$desc" "$expected" "$actual"
    fail=$((fail + 1))
  fi
}

echo "--- blocked inside the QA repo (protection preserved) ---"
check "git commit in the QA repo"                  block "$QA_REPO"     "git commit -m 'add test plan'"
check "git push in the QA repo"                    block "$QA_REPO"     "git push origin main"
check "git commit -am in the QA repo"              block "$QA_REPO"     "git commit -am wip"
check "chained git commit in the QA repo"          block "$QA_REPO"     "git add -A && git commit -m x"
check "git -C into the QA repo from elsewhere"     block "$OTHER_REPO"  "git -C $QA_REPO commit -m sneaky"
check "git commit in a subdirectory of the QA repo" block "$QA_REPO/feature-slug" "git commit -m x"

echo "--- blocked inside this plugin's own repo ---"
check "git commit in the plugin repo (by manifest)" block "$PLUGIN_REPO" "git commit -m 'fix hook'"
check "git push in the plugin repo (by manifest)"   block "$PLUGIN_REPO" "git push -u origin fix/branch"

echo "--- allowed outside those repos (the bug this fixes) ---"
check "git commit in an unrelated repo"            allow "$OTHER_REPO"  "git commit -m 'unrelated work'"
check "git push in an unrelated repo"              allow "$OTHER_REPO"  "git push -u origin feat/x"
check "git commit in the sibling code repo"        allow "$CODE_REPO"   "git commit -m 'app change'"
check "git commit outside any git repo"            allow "$NOT_A_REPO"  "git commit -m nope"

echo "--- non-write git and non-git commands always pass ---"
check "git status in the QA repo"                  allow "$QA_REPO"     "git status"
check "git diff in the QA repo"                    allow "$QA_REPO"     "git diff --stat"
check "git log in the QA repo"                     allow "$QA_REPO"     "git log --oneline -5"
check "git add in the QA repo"                     allow "$QA_REPO"     "git add -A"
check "non-git command in the QA repo"             allow "$QA_REPO"     "ls -la"
check "unrelated word containing commit"           allow "$QA_REPO"     "echo 'commit the changes'"
check "non-Bash tool call"                         allow "$QA_REPO"     "git commit -m x" "Read"
check "empty command"                              allow "$QA_REPO"     ""

echo "--- .claude/qa-workspace.json is authoritative when present ---"
mkdir -p "$WS/.claude"
printf '{"codeRepoPath": "acme-app", "qaRepoPath": "acme-qa"}\n' >"$WS/.claude/qa-workspace.json"
check "cached qaRepoPath still blocks the QA repo"  block "$QA_REPO"    "git commit -m x"
check "cached mapping leaves the code repo alone"   allow "$CODE_REPO"  "git commit -m x"

# A repo whose name matches the fallback heuristic but which the cache does not
# name is NOT the QA repo — the cache wins, exactly as the commands resolve it.
DECOY_QA="$(new_repo "$WS/decoy-qa")"
check "cache overrides the folder-name fallback"    allow "$DECOY_QA"   "git commit -m x"
rm -rf "$WS/.claude"
check "without the cache, folder name blocks again" block "$DECOY_QA"   "git commit -m x"

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL TESTS PASSED ($pass)"
  exit 0
fi
echo "$fail FAILED, $pass passed"
exit 1
