---
name: bug-hunt
description: >-
  Read-only codebase audit skill that hunts for real, reproducible defects
  across 16 concrete bug classes (implicit state machines, mid-flight
  cancellation, out-of-order arrival, auth back doors, dual sources of truth,
  quadratic/OOM paths, trust boundaries, partial-failure writes, asymmetric
  pairs, boundary values, copy-paste drift, dropped plumbing, numeric/encoding
  truncation, TOCTOU races, fail-open defaults, and vacuous tests) and produces
  a verified, structured report without changing code. Use when the user asks
  for a bug hunt, deep audit, or class-specific bug sweep.
license: MIT
metadata:
  author: lecstor
  version: "1.0.0"
---

# Bug Hunt (16 Bug Classes)

A read-only audit workflow for finding **real, reproducible defects** — not
style issues or hypothetical concerns — built on Charlie Cheever's 16 bug
classes (<https://x.com/ccheever/status/2125875800838902272>) and refined from
production audits across multi-package codebases.

**Report only:** Do not modify application code, run migrations, or file
backlog tasks. Hand back a crisp, verified report so the developer can triage,
fix, or delegate findings however they prefer.

Full definitions and search hints for all 16 classes live in
[`references/bug-classes.md`](./references/bug-classes.md). Read it before
hunting.

---

## Step 1: Map the Codebase First

Before searching for bugs, build (or verify) a concise codebase map:

1. Check whether a map already exists (e.g. `docs/system-map.md`,
   `docs/architecture.md`, `CLAUDE.md`, `AGENTS.md`). Verify it against the
   actual directory tree — docs drift.
2. Write down a brief map covering:
   - **Languages & packages/apps** (including services, workers, or sidecars)
   - **Entry points** (HTTP/RPC/GraphQL routes, webhooks, queues, crons, CLI, UI routes)
   - **Async & concurrency model** (event loops, threads/workers, goroutines/tasks,
     UI effects/polls, background jobs, stateful actors, locks)
   - **Persistence & caches** (databases, object/blob storage, key-value stores,
     in-memory caches)
   - **External inputs & trust boundaries** (files, uploads, URLs, network
     responses, user-supplied markup/DSL, webhooks, IPC, persisted state)
   - **Multi-pass pipelines** (lex → parse → transform → emit, validate → mutate,
     ingest → enrich → persist)
   - **Platform-specific code & test suite**

---

## Step 2: Partition the Hunt

On large codebases, split the work across parallel read-only subagents, give
each the codebase map from Step 1, and merge/de-duplicate their findings.

### Single-class sweep (e.g. "look for implicit state machines")
Shard **by architectural domain** (typically 3–5 parallel subagents) matched to
the codebase's layout so each builds deep context in its slice, for example:
- Frontend / client UI, hooks, state management & client async flows
- Backend APIs, auth, billing/webhooks, queues, crons & stateful services
- Core domain logic, data processing & multi-pass pipelines
- Low-level encoders, emitters, renderers & storage adapters
- Parsers, lexers, serializers & template/DSL evaluators

### Multi-class / full 16-class sweep
Shard **by coherent class cluster** (or domain × cluster on very large repos):

| Cluster | Bug Classes | Shared Lens |
| --- | --- | --- |
| **A. Lifecycle & Concurrency** | `0` Implicit state machines · `1` Cancellation/teardown · `2` Out-of-order arrival · `13` Check-then-act (TOCTOU) | Transitions over time, interleaving, abort/cleanup |
| **B. Writes & Consistency** | `4` Two sources of truth · `7` Partial failure in multi-step writes · `8` Asymmetric pairs · `10` Copy-paste drift · `11` Dropped plumbing | Drift between coupled copies, phases, or siblings |
| **C. Security & Gates** | `3` Back doors around checks · `6` Trust boundaries · `14` Fail-open defaults | Untrusted input, bypassed guards, unsafe fallbacks |
| **D. Scale & Arithmetic** | `5` Quadratic work / stack / allocation · `9` Boundary values · `12` Numeric narrowing / encoding / escaping | Hostile sizes, edge counts, format boundaries |
| **E. Test Integrity** | `15` Tests that silently skip their checks | Vacuous green tests & silent skips |

### Capping & Tail Transparency
- On large surfaces, capping each subagent to its **top 5–10 highest-severity
  confirmed findings** keeps signal high and prevents padding.
- Whenever a cap is used, **explicitly disclose it** in the report and list any
  high-complexity integration files, related repos/packages, or trimmed tail
  areas worth revisiting in a second pass.

---

## Step 3: Confirm & Independently Verify

Never pad a report with unverified hunches. Enforce three gates:

1. **Read full functions before reporting.** Check callers, middleware, DB
   constraints, and helper utilities that might already guard the site.
2. **Concrete failure scenario required.** A `confirmed` finding MUST state an
   exact sequence of inputs or events that produces wrong behaviour, a crash,
   data loss, wrong billing/accounting, or a security hole:
   `trigger / input -> exact file:line & state/transition -> wrong outcome`.
   If you cannot prove the full sequence, mark it `suspected` and say what
   would confirm it — or drop it if purely speculative.
3. **Coordinator verification & branch awareness.** Before finalizing:
   - Independently read the cited source lines for every **Critical** and
     **High** finding returned by subagents.
   - Note which git branch/commit was audited (and flag if the local checkout
     is behind the main integration branch so line citations stay trustworthy).

---

## Step 4: Report Format

Start with the **codebase map** from Step 1 (and audited branch/scope).

List findings grouped by bug class (or by domain for a single-class sweep),
ordered **Critical → High → Medium → Low**, with stable short IDs (e.g.
`C0-1`, `C7-2` or `B1`, `F1`) for easy discussion. For each finding:

- **Class:** number and name
- **Location:** `path/to/file.ext:line` (and any other involved locations)
- **Status:** `confirmed` or `suspected`
- **Severity:** `critical` (security, data loss, money), `high` (crash, hang,
  wrong results users see), `medium` (wrong results in edge cases), `low`
- **Failure scenario:** the concrete sequence of inputs or events and the wrong
  outcome
- **Fix:** what to change, in one or two sentences — matched to the right
  mechanism for that layer (e.g. explicit state enums/discriminated unions +
  cancellation tokens for UI/async flows; atomic compare-and-swap queries +
  idempotency keys + commit-point ordering for DB/APIs; validated cache keys
  and invalidation for derived state and multi-pass pipelines; balanced
  push/pop guards for stateful emitters; quote- and delimiter-aware parsers
  instead of ad-hoc string splitting)

End with:
1. A **one-line count per checked class**, including classes with `0` findings,
   so it is clear every class was audited.
2. Any **scope limits or Pass-2 candidates** (per-domain caps, unvisited
   integration files, or related repos/packages).

Write the report directly in chat for short sweeps, or as a markdown report in
`docs/` (or an artifact) when the sweep is large or the user asks for a saved
document.
