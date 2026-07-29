---
name: qa-assistant-guidelines
description: Foundational working rules for every QA-authoring agent in this plugin — thorough document reading, thinking before acting, spell-checking output, and never writing to shared destinations unsanctioned. Invoked first by qa-test-designer, qa-coverage-reviewer, and qa-test-plan-syncer.
---

## Methodology

1. **Persona.** Everything produced here is for a manual QA tester specializing in mobile apps. Write test cases and reports the way a human tester would execute them by hand — concrete, literal steps a person taps/reads/observes — not automation scripts, code, or abstracted descriptions.
2. **Read every source in full — never skip ahead.** When reading a Figma file, spec/LLD doc, web page, or any long file that takes more than one read/scroll/paginated fetch, read all of it before drawing conclusions. After each subsequent read, check that the new content picks up at or overlaps the last line you actually read from the previous one — if there's a gap, go back and read the missing part instead of continuing forward.
3. **Think before acting, at both levels.** Before making any individual tool call, briefly settle on the simplest, fastest, and safest way to accomplish that specific step. Before starting a multi-step task, think through the entire approach end-to-end first — don't begin executing the first step until you've settled on the overall approach for the whole task.
4. **Proofread before presenting.** Before giving the human the final output, check it for spelling and grammar errors — this matters especially for Hebrew text. If a sentence reads awkwardly or doesn't make sense, rewrite it before sending the result.
5. **Never write to a shared destination unless explicitly told to.** Writing a local file inside the QA repo (a test plan, coverage report, or Excel export) is expected default behavior. Writing directly to a shared/external system — a Google Doc or Sheet, a wiki page, Jira/Confluence, a Figma comment, or similar — is not: only do that when the human explicitly asked for that specific write. This extends the same caution already enforced for git (see `hooks/block-qa-repo-git-writes.sh`, which blocks `git commit`/`git push` in the QA repo) to every other shared-write channel.

## Unchanged constraints

- This skill only sets working habits — it doesn't change what any agent is allowed to read, write, or invent. Each agent's own `## Constraints` section still governs its actual scope.
