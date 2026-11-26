---
name: review-deep
description: >-
  Deep, thorough review of a pull request or local branch changes (including
  uncommitted work) through a scripted multi-turn Claude CLI session — change
  and flow maps, a note per changed region, then confirmed findings. Found 72%
  of known issues on a 20-PR benchmark vs 48% for a single-pass review, at the
  cost of a few minutes and roughly $0.50–$3 per review with Opus. Use when the
  user asks for a deep or thorough review (of a PR or local changes) or names
  this skill; for quick reviews, a standard single-pass review is faster.
  Returns findings and posts nothing unless explicitly asked.
license: MIT
metadata:
  author: lecstor
  version: "1.0.0"
---

# Deep review of a pull request or local changes

You are reviewing changes as a formal step that a person will act on. The goal is to find every real problem the change introduces or exposes, from bugs that break production down to small issues a careful reviewer would still raise, and to present them so the reader sees the serious ones first. Do not repeat what the author already said or pad with praise.

Default to **propose-only**: return the review to the user. Do not post PR comments, approve, or request changes unless the user explicitly asks — then do it via `gh`.

## Step 1 - Gather context before reading the diff

A finding is only useful once you know what the author already intended, acknowledged, or was told. Pull all of it first.

**For a GitHub PR** (add `--repo <owner>/<name>` whenever it isn't the current repo — e.g. reviewing another team's PR):

```bash
gh pr view <n> --repo <owner>/<name> --json title,body,author,baseRefName,headRefName,headRefOid,state,additions,deletions,changedFiles,labels,comments,reviews
```

- `body` — the description: stated intent, accepted trade-offs, deploy/verification steps, "out of scope" notes, linked tickets.
- `comments` + `reviews` — the conversation: questions already answered, concerns already raised/resolved, things the author committed to.
- Inline review-thread comments (not in the above): `gh api "repos/<owner>/<name>/pulls/<n>/comments"`.
- Follow linked issues or tickets in the description only if a claim's correctness depends on them.

**For a local diff** (no PR): read any commit messages, ticket, or change notes the user supplies as the equivalent of the description.

## Step 2 - Build the "already accounted for" set

From the description, comments, and prior reviews, list what is **off-limits as a new finding**: the author's stated intent, accepted trade-offs, deferred/out-of-scope items, TODOs they've flagged, questions already answered, and concerns already resolved in-thread.

- **Do not re-raise** anything in this set. Re-flagging acknowledged items as if they were missed is the biggest source of review noise.
- If you **concur** with an acknowledged item, that's at most **one line** marking it as already-acknowledged — not a finding, not repeated across sections.
- You may raise a finding that **extends** an acknowledged item with a specific point the author did *not* cover — but frame it as an extension: "the author already gates on X; specifically, that gate must also prove Y."

## Step 3 - Run the review session

The review itself runs as a script, `scripts/review-session.js` in this skill's directory (resolve it from this skill's base directory + `/scripts`; do not rely on `CLAUDE_PLUGIN_ROOT`, which may be unset in the shell). It needs Node 18+ and the `claude` CLI, and has no dependencies to install.

What it does, and why it is a script: it builds a checklist from the diff with code (one item per changed region in any language, plus each changed JS/TS definition with the places that use it from `git grep`), then runs one `claude -p` session that writes a note for every item, 25 items per turn, with no findings allowed, and a final turn that confirms each noted problem against the code and writes the findings. On a 20-PR benchmark this found 72% of known issues against 48% for a single-pass review with the same model (Opus), with similar precision (83% vs 80%). The gain comes from the separate turns, which instructions inside one pass did not reproduce, so do not replace the script with your own reading of the diff.

Set `T="${TMPDIR:-/tmp}"` for the temporary files below. Creating files under `$T` and a detached worktree is part of the review; it does not edit the user's files.

**Check out the PR head** so the script reviews the right code. For a PR in the current repo, use a worktree so the user's working tree is untouched. The fetch brings in the head commit without creating a local branch. The `remove` clears a worktree an earlier review left behind (`|| true` keeps a first review going when there is none), so the commands are safe to re-run after an earlier review or a force-push:

```bash
git fetch origin <baseRefName> "pull/<n>/head"
git worktree remove --force "$T/review-deep-<n>" 2>/dev/null || true
git worktree add --force --detach "$T/review-deep-<n>" <headRefOid>
```

For another repo, clone it into `$T` first and check out `<headRefOid>`. For a local diff, run in the repo as it is.

**Save the PR body** for the script: `gh pr view <n> --repo <owner>/<name> --json body --jq .body > "$T/review-deep-<n>-body.md"`. For a local diff, write the commit messages or the user's notes there instead (`git log --format=%B <base>..HEAD > ...`).

**Run it** from the checkout root, writing the result to a file (it takes 2–6 minutes for a typical PR, longer for large ones; run it in the background if your shell tool would time out, and wait for the file):

```bash
node <skill dir>/scripts/review-session.js --base origin/<baseRefName> \
  --title "<PR title>" --body-file "$T/review-deep-<n>-body.md" --out "$T/review-deep-<n>.json"
```

- Local diff against a branch, including uncommitted changes: `--base <branch> --working`. It diffs against the merge-base. Untracked files are not in the diff; the script lists them on stderr, and `git add -N <file>` includes them.
- Defaults: `--model opus --effort medium`. High effort scored lower than medium on the benchmark; keep the defaults unless the user asks.
- Output: `findings` (`file`, `start_line`, `end_line`, `message`), `notes` (one per map item: what was checked), `items`, `session_id`, and `usage` (`cost_usd`, `duration_ms`). Progress goes to stderr. The session's transcript is kept at `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<encoded checkout path>/<session_id>.jsonl`, so what the reviewer read and ran can be checked afterwards; the id is also printed to stderr when the session starts, which is the only place to find it if the run fails. For a PR the worktree is removed in Step 5, so the transcript file is what remains; for a local diff the session also shows in `claude --resume` from the repo.
- The script's session ignores user and project Claude settings, so a PR's own `.claude/` settings cannot add hooks or permissions. Its file tools and the paths its shell commands take are confined to the checkout, and its shell is limited to `git diff/log/show/blame/ls-files`, `ls`, and `wc`, with any command containing `--output` denied (git's `--output=<file>` writes files anywhere). `git grep` is not allowed, because `git grep -O<cmd>` runs a command; the session searches with the Grep tool.
- It uses whatever login the `claude` CLI uses. If `ANTHROPIC_API_KEY` is set in the environment, the review is billed to the API (about $1–3 per PR with Opus) rather than a subscription; `usage.cost_usd` is the API-price figure either way.

**If the script fails** (no `claude` CLI, usage limit, a turn errors), say so with the error, then review the diff yourself in a single pass using the checklist in `scripts/prompt.md`, and tell the user the review is the single-pass fallback.

Keep the worktree until the review is written: Step 4 checks findings against the code in it.

## Step 4 - Triage the findings

The script reports every problem it confirmed, including small ones. For each finding:

1. **Drop it if it is in the "already accounted for" set** (Step 2), or extend it as described there.
2. **Verify load-bearing external facts** (below) before asserting a finding that depends on one.
3. **Assign severity** — `[ERROR]` must fix: bug, security, broken behaviour, data loss · `[WARN]` should fix: risky pattern, missing edge case, missing test of a risky path · `[NIT]` optional: dead code, stale comment, naming, minor inconsistency.
4. **Write a concrete suggestion** — a fix, not "consider changing this".

Keep findings you cannot disprove. Do not drop a finding for being minor; mark it `[NIT]` instead. Drop one only if it is accounted for, or you check the code and it is wrong — and say how many you dropped for each reason.

### Verify load-bearing facts — do not assert from memory

If a finding (or the code's correctness) hinges on an external fact — an API/parameter name, a library's behaviour, a platform constraint, a version's capabilities — **verify it** before asserting it, and state your confidence.

- **Fetch the primary source; don't trust a search-result summary.** A web-search snippet is a paraphrase that routinely drops the qualifier that changes the answer. Open the actual doc/page/source and read the surrounding context before you assert a fact as load-bearing — especially for an `[ERROR]`.
- **Prefer the authoritative check over prose.** Where there's a machine-readable source of truth (an upgrade-target matrix, a schema, the actual config/state), cite or run that rather than inferring from documentation prose.
- **For cloud and infrastructure PRs**, ground claims in the provider's authoritative source (e.g., provider schemas, API specs, or version compatibility matrices), not docs prose or memory.
- A clean type-check, IaC plan/preview, or CI run does **not** validate names or behaviours that only fail at runtime or apply — say so rather than implying the gate covers them.
- If the author has already verified something empirically (e.g. "ran it, it worked"), treat that as strong evidence and weight it above an inference.

## Step 5 - Write the review

Lead with a one-line **verdict**. Then the findings, `[ERROR]` first, then `[WARN]`, then `[NIT]`, each with:
- **Severity**
- **File:line** — e.g. `src/utils/parse.ts:42-48`.
- **Description** — what's wrong, why it matters, and the input or state that triggers it.
- **Suggestion** — a concrete fix.

Group findings that are the same problem in several places under one entry listing each location. If a finding required external verification, cite the source. End with one line: findings dropped as already accounted for or disproved, and the session's time and cost from `usage`. If there are no findings, say so in a sentence.

**Clean up**, whether the script succeeded or you used the fallback: `git worktree remove --force "$T/review-deep-<n>"`, and delete `$T/review-deep-<n>-body.md` and `$T/review-deep-<n>.json` unless the user wants the raw output.

## Do NOT flag
- Anything in the "already accounted for" set (Step 2).
- Issues a linter/formatter would catch (formatting, import order, semicolons).
- Subjective style preferences ungrounded in the project's existing conventions.
- Praise. State what's wrong; skip the filler.
