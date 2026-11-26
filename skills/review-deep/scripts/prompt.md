You are reviewing a pull request. The repository is checked out at the PR head in the current directory.

PR title: {{title}}

PR description:
<description>
{{body}}
</description>

Base: {{base}}
Head: {{head}} (checked out in the current directory)

Get the change with `{{diff_cmd}}`. Changed files:

{{diff_stat}}

Your job is to find every real problem this PR introduces or exposes, from bugs that break production down to small issues a careful reviewer would still raise. Missing a real problem is as costly as reporting a false one.

## How this review works

The harness has mapped the change into items:

- `M` items: each changed region of the diff, with the function or block it sits in.
- `F` items: each definition the PR adds or changes (function, component, hook, type), with the places in the repository that use it (from `git grep`, capped; there may be more).

You will get the items in chunks. For each chunk, write a note per item. When every chunk is done, you will be asked to turn your notes into findings. Nothing you write in a note is reported as it stands, so note everything you see: problems, doubts, things that look inconsistent or untested, however small. A note that says only "fine" should mean you checked and found nothing.

For an `M` item: read the region at head with enough surrounding code to understand it, and its diff. Compare it with sibling code that does the same job elsewhere. Apply the checklist below.

For an `F` item: read the definition, then each listed use, and compare: argument count, order and types against the parameters; object fields and prop names written against those read; optional against required; sync against async (missing `await`, unhandled promise); return values the caller ignores or assumes non-null; renamed or removed exports still referenced. Follow a use one level further when the value is passed on.

Use `{{diff_cmd}} -- <path>` for the diff of a file, the Grep tool to find more uses, and Read for whole files.

## Checklist

Correctness:
- Wrong logic: inverted conditions, off-by-one, wrong variable, missing case in a switch or union, a code path that skips a step its sibling paths perform.
- Async: missing `await`, unhandled rejections, races between concurrent requests, read-then-write without a lock or unique constraint, stale state.
- Null and undefined: optional values used without a check, non-null assertions that can be false, unsafe casts that hide a wrong type or skip validation, returns typed as non-null that can be null.
- Error handling that swallows failures, `try/catch` that cannot catch the error it targets, success reported after a failure.
- Values that are computed but wrong for some inputs (negative, zero, empty, very large, other platforms such as Windows paths and shells).

Contracts and data:
- Changed signatures, response shapes, config keys or types whose callers, consumers or docs were not updated.
- Optional props or parameters that must be supplied together; invalid combinations that silently take the wrong branch.
- Database: missing unique constraints the code relies on, missing `onDelete` rules, missing indexes for the queries the PR adds, migrations that do not match the model, primary keys that are never generated.
- Input from requests, query strings, env or files used without validation, especially when a sibling path validates it.

Security: missing authorisation on server code, injection, secrets in code, unsafe HTML, user input reaching headers, paths or queries.

Frontend and UI:
- Effects/subscriptions with missing or wrong dependencies, missing cleanup, state mutated in place, state updates called inside other state updaters, conditional hooks, unstable list keys, local state initialised from props that later change.
- Accessibility: click handlers on non-interactive elements, controls without an accessible name, missing labels, keyboard traps.

Performance: repeated or N+1 queries, duplicate reads of data the caller already has, work inside loops or renders that could be done once.

Maintainability:
- Dead or unreachable code, fallbacks that can never apply, no-op calls, leftover debugging.
- Inconsistency with the conventions of the surrounding code or sibling packages.
- Misleading names, return types or diagnostic values (for example a field that can go negative when it means a reduction).

Tests:
- New or changed behaviour with no test, including each new branch and each sibling path (if the PR tests `add` and `delete`, check `update`).
- Tests that would still pass if the change regressed, assert the wrong thing, or depend on environment details that differ in CI.

Documentation:
- Docs, comments, READMEs, changelogs, examples or generated guidance that the change made wrong, that contradict the code or each other, or that show commands that would not run as written.

## Chunk {{chunk_label}}

{{items}}

Return a `notes` list with one entry for every item in this chunk, in order: `id` (the item id) and `note` (what you checked and everything you noticed).

=== next notes ===
## Chunk {{chunk_label}}

Same instructions as before: read each item and its context, apply the checklist, and note everything you notice, however small.

{{items}}

Return a `notes` list with one entry for every item in this chunk, in order: `id` and `note`.

=== findings ===
You have been through every item. Now turn your notes into findings.

1. Go through all your notes from every chunk. For each note that names a problem or a doubt, confirm it against the code: find the line that proves it, or the line that shows it is fine. Use the tools again where you need to.
2. Look across the notes for problems that span items: a definition and a caller that disagree, the same mistake in several regions, a behaviour the description claims that no item implements, new behaviour no test covers.
3. Write every confirmed problem as a finding. A note can give several findings; the same problem in several places gives one finding per place.

## What to report

Report a problem if:

- The PR introduced it, or the PR's change makes an existing problem reachable or more visible, or the PR touched the code and left the problem in place where a reviewer would expect it fixed.
- You confirmed it against the code.

Report low-severity problems too: a missing test, a stale comment, dead code or an inconsistency is worth one finding each.

When the same problem appears in several places, report one finding per location, each pointing at its own lines.

Do not report: pure formatting, personal naming preferences, errors the type checker or linter would already reject, or concerns you could not confirm.

## Output

Return every confirmed problem as one finding:

- `file`: path relative to the repository root, forward slashes, no leading `./`.
- `start_line`, `end_line`: line numbers in the file at the head commit, covering the code that has the problem. Use the same number for a single line.
- `message`: what is wrong, why it matters, and the input or state that triggers it. Be specific; the message is all a reader sees.

One finding per issue per location. If you confirmed nothing, return an empty list. Do not modify any files.
