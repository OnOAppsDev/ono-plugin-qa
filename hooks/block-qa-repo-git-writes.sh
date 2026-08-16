#!/usr/bin/env bash
# PreToolUse hook: blocks a Bash-invoked `git commit`/`git push` when the active
# repository is one this plugin touches — the QA repo it writes test plans and
# coverage reports into (test-plan.md / coverage-report.md / test-cases.xlsx),
# or this plugin's own source repo. Those artifacts are always reviewed and
# committed by hand by the QA engineer.
#
# The guard is scoped to those repositories on purpose. An earlier version
# matched the command string alone and therefore blocked `git commit` in EVERY
# repository on the machine merely because this plugin was installed, including
# unrelated ones like ono-mobile-dev-plugin. Read-only git commands
# (status/diff/log) and `git add` still pass through everywhere.
set -uo pipefail

payload="$(cat)"

tool_name="$(jq -r '.tool_name // empty' <<<"$payload")"
[ "$tool_name" = "Bash" ] || exit 0

command="$(jq -r '.tool_input.command // empty' <<<"$payload")"
[ -z "$command" ] && exit 0

# Nothing to guard unless the command actually writes to git history.
grep -qE '(^|[;&|]|[[:space:]])git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+(commit|push)([[:space:]]|$)' \
  <<<"$command" || exit 0

session_cwd="$(jq -r '.cwd // empty' <<<"$payload")"
[ -n "$session_cwd" ] || session_cwd="$PWD"

canonical() { (cd "$1" 2>/dev/null && pwd -P); }

block() {
  echo "Blocked: this plugin never commits or pushes in the QA repo ($1). QA artifacts are reviewed and committed by hand — check them with 'git diff', then commit/push yourself. Git writes in other repositories are unaffected." >&2
  exit 2
}

# Where the command would actually run: an explicit `git -C <path>` wins over the
# session's working directory, so the guard cannot be stepped around with -C.
run_dir="$(sed -nE 's/.*git[[:space:]]+-C[[:space:]]+([^[:space:]]+).*/\1/p' <<<"$command" | head -1)"
[ -n "$run_dir" ] || run_dir="$session_cwd"

# Outside a git repository there is no repo to protect.
repo_root="$(git -C "$run_dir" rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -n "$repo_root" ] || exit 0
repo_root="$(canonical "$repo_root")"
[ -n "$repo_root" ] || exit 0

# 1. This plugin's own source repo — identified by its manifest rather than by
#    folder name, so a differently-named clone is still protected.
manifest="$repo_root/.claude-plugin/plugin.json"
if [ -f "$manifest" ] && [ "$(jq -r '.name // empty' "$manifest" 2>/dev/null)" = "ono-plugin-qa" ]; then
  block "this plugin's own repository"
fi

# 2. The QA repo, resolved exactly the way the commands resolve it (see
#    "Resolving the workspace" in commands/create-qa-test-plan.md):
#    .claude/qa-workspace.json is authoritative when present, and the documented
#    folder-name convention is the fallback.
workspace_dir=""
for candidate in "$(dirname "$repo_root")" "$session_cwd"; do
  [ -n "$candidate" ] || continue
  if [ -f "$candidate/.claude/qa-workspace.json" ]; then
    workspace_dir="$candidate"
    break
  fi
done

if [ -n "$workspace_dir" ]; then
  qa_path="$(jq -r '.qaRepoPath // empty' "$workspace_dir/.claude/qa-workspace.json" 2>/dev/null)"
  if [ -n "$qa_path" ]; then
    case "$qa_path" in
      /*) : ;;
      *) qa_path="$workspace_dir/$qa_path" ;;
    esac
    qa_root="$(canonical "$qa_path")"
    if [ -n "$qa_root" ] && [ "$qa_root" = "$repo_root" ]; then
      block "named by $workspace_dir/.claude/qa-workspace.json"
    fi
    # The cached mapping is authoritative: a repo it does not name is not the
    # QA repo, so do not second-guess it with the folder-name heuristic.
    exit 0
  fi
fi

# 3. No usable cache — fall back to the convention the plugin documents and
#    auto-detects with: the QA repo is the one with `qa` in its folder name.
case "$(basename "$repo_root" | tr '[:upper:]' '[:lower:]')" in
  *qa*) block "matched by folder name" ;;
esac

exit 0
