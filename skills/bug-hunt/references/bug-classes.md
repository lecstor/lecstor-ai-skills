# The 16 Bug Classes — Reference & Search Hints

Source: Charlie Cheever's thread
(<https://x.com/ccheever/status/2125875800838902272>) and the post it quotes,
enriched with concrete failure patterns observed across frontend applications,
backend services, data stores, multi-pass pipelines, binary/document encoders,
and custom parsers.

---

## 0. Implicit state machines

Code whose behaviour depends on an unnamed combination of booleans, nullable
fields, or flags (`isLoading`, `hasStarted`, `pending`, `closed`, `dismissed`)
that together act as a state machine with no explicit states or transitions.
Bugs come from impossible or unhandled combinations and from transitions that
forget to reset a flag.

- **Look for:** Clusters of related boolean fields (`isLoading`, `saving`,
  `error`, `result`, `dismissed`); `if (a && !b)` logic spread across methods;
  flags set in one place and cleared in several others; mutable refs or latches
  (`startedRef`, `initialized`) that never reset on entity/route change; status
  strings updated without checking the current status (resurrecting terminal
  states like `canceled`, `consumed`, or `denied`); single boolean retry flags
  conflating two unrelated overrides in recursive loops.
- **Concrete checks:** Trace every error, early `return`, cancel, retry, and
  entity-switch path — verify every coupled flag, error message, and latch
  resets.

## 1. Cancellation and teardown mid-flight

Async work starts, then the owner is cancelled, closed, disposed, or unmounted
before the work finishes. The completion then touches freed resources, keeps
polling forever, or revives something that was shut down.

- **Look for:** Polling loops (`for (;;)` / `setInterval`), timers/sleeps,
  animation frame callbacks, promises/futures/tasks, event listeners,
  WebSockets, and subscriptions created by an object/component that can unmount
  or close; lifecycle/effect cleanup closures capturing stale initial state
  (e.g. object URLs, file descriptors, or temp handles never released);
  native/WASM/GPU resources freed while queued callbacks still reference them.
- **Concrete checks:** Navigate away, close a modal/connection, or cancel a
  job mid-flight — does every request, poll, sleep timer, and resource handle
  abort and clean up?

## 2. Out-of-order arrival

A late response, retry, or webhook event arrives after state has moved on and
overwrites newer state with older data.

- **Look for:** Request/response handlers writing shared state without a
  cancellation token (`AbortController`, `context.Context`), request ID,
  sequence number, or generation counter; rapid user actions (switch item/route,
  change filter or mode, upload a replacement file, type-ahead search) where
  slow work A resolves after fast work B; async webhooks delivered out of order
  (e.g. a delayed update or failure event arriving after a deletion or
  cancellation event); retries completing after a newer attempt.
- **Concrete checks:** Start slow request A, immediately start fast request B,
  resolve B then A — does A overwrite B's UI state, cached result, or DB row?

## 3. Back doors around checks

A secondary code path reaches the same operation as the main path but skips its
validation, permission check, billing/quota gate, or authorization.

- **Look for:** Every entry point reaching a guarded operation — compare
  HTTP/RPC/GraphQL routes, CLI/tool interfaces, batch/bulk endpoints, admin
  tools, internal helpers, webhooks, deep links, guest/promo carve-outs, and
  legacy routes against the primary path. Check that narrowed permissions and
  billing/quota commit points are enforced at the operation, not only at one
  entry point.
- **Concrete checks:** Compare sibling surfaces (e.g. HTTP API vs CLI/RPC
  handler vs web UI vs batch job) step-by-step for missing auth, rate-limit,
  validation, or quota/billing ordering.

## 4. Two sources of truth

The same fact is stored in two places (a value and its cache, parent state and
local copied child state, a pre-pass annotation and a later execution pass, an
in-memory cache and durable storage, a derived/denormalized table and source
table) and they drift apart.

- **Look for:** Caches, memoisation, one-way sync hooks (updating local state
  when an input/prop becomes truthy with no reset when it clears or becomes
  `null`/`undefined`), UI component keys that accidentally stay constant across
  distinct items, speculative pre-pass caches consumed without validating
  assumptions, and dual-stored server/actor state (in-memory cache + persistent
  storage).
- **Concrete checks:** For every write, delete, reset, and GC path on the
  primary source, verify the secondary copy is updated or invalidated.

## 5. Quadratic work, stack depth, and allocation size

Unbounded recursion, $O(n^2)$ or worse loops, or allocations sized directly by
untrusted input that nested, cyclic, or hostile input can trigger.

- **Look for:** Recursion over user-controlled or graph-shaped data without a
  depth limit or cycle detection (inheritance/`extends` chains, includes/imports,
  reference links, parent/child graphs, ID refs); nested loops over the same
  collection; linear membership lookups (`includes`/`indexOf`) inside loops;
  regex backtracking on untrusted text; string concatenation in tight loops;
  buffers allocated from an unvalidated input length; decompression
  (gzip/deflate/zip) without output byte caps; pagination/retry loops with false
  forward-progress signals.
- **Concrete checks:** Construct a cycle, deeply nested tree, or 100k-token
  input — does it hit a bounded cap cleanly or blow the stack / timeout / OOM?

## 6. Trust boundaries

Data from a file, URL, network response, database, persisted state, environment,
or another process is used without validation.

- **Look for:** URLs placed in links/media attributes or fetched server-side
  (SSRF, `javascript:`, `data:`, private IPs); values interpolated into HTML,
  SQL, shell commands, template/markup output, binary/document streams, or CLI
  args (including args starting with `-`); paths joined from input (`../`);
  untrusted JSON/binary deserialisation; corrupt or truncated inputs that crash
  instead of returning a clean error.
- **Concrete checks:** Trace every external byte from ingress to sink — where is
  it validated, bounded, and escaped?

## 7. Partial failure in multi-step writes

A sequence of writes or mutations fails partway, leaving state half-changed,
inconsistent, or stuck. Errors are caught and swallowed without rollback — or
rolling back an idempotency gate after a side effect already committed causes
duplicates on retry.

- **Look for:** Functions mutating multiple stores sequentially (database then
  external payment/email API, database then object storage or vice versa, local
  state mutation then remote API call); error handlers that delete an
  idempotency key *after* an additive write committed; missing transactions;
  mutating state *before* a fallible commit step; non-idempotent external calls
  (charges/transfers, emails, external webhooks) where a timeout/5xx retry
  double-applies the action.
- **Concrete checks:** Inject a failure or timeout after *each* step $k$ in a
  multi-step write, then replay the request/webhook/cron — is state consistent
  and free of double-application?

## 8. Asymmetric pairs

Two operations that must agree (encode/decode, serialise/deserialise,
export/import, Pass 1 analyze / Pass 2 execute, validate/execute, migrate
up/down, DB write format / query comparison format, client/server schema) drift
apart.

- **Look for:** Every coupled pair — check field sets, optional fields, escaping,
  sorting, normalization/formatting rules, timestamp formats (e.g. SQL
  `YYYY-MM-DD HH:MM:SS` space separator vs ISO-8601 `'T'` separator),
  coordinate/unit conversions, and implicit sentinel or boundary conventions in
  encoded arrays/records.
- **Concrete checks:** Round-trip the output of A into B (including edge cases:
  empty, Unicode, quotes, punctuation, timezone/midnight boundaries).

## 9. Boundary values

Zero, empty, one, maximum-size, negative, and off-by-one inputs where a loop,
index, slice, or allocator breaks.

- **Look for:** Length or count fields used before checking remaining bytes;
  `<` vs `<=` in loop bounds; empty arrays/strings passed to code assuming at
  least one element (`arr[0]`, `arr[arr.length - 1]` aliasing when length is 1);
  valid zero values gated by truthiness (`if (count)`, `if (offset)`); sparse
  arrays or maps compacted when indices/keys are semantically meaningful;
  division by a count that can be zero; integer overflow in size math.
- **Concrete checks:** Test `0`, `1`, empty `""`/`[]`, negative, sparse, and
  max-limit inputs against every loop, slice, and conditional.

## 10. Copy-paste drift

Near-duplicate code across platforms, files, endpoints, or parsers where a bug
fix or guard was applied to one copy and missed in sibling copies.

- **Look for:** Parallel implementations per surface or variant (e.g. sibling
  API endpoints, multiple format/dialect parsers, OS/platform adapters, sync vs
  async code paths, batch vs single-item handlers). Use `git log` to find recent
  bug-fix commits on one copy and check whether every sibling received the same
  fix.
- **Concrete checks:** Diff sibling handlers, parsers, or adapters side-by-side
  for missing input normalization, escaping, rate limits, auth guards, error
  handling, or cleanup hooks.

## 11. Dropped plumbing

When a new code path, target, or option is wired up, a flag, option, scope,
type/kind field, context value, coupled state property, or init hook is not
passed through.

- **Look for:** Functions forwarding options, headers, or context objects (check
  every field is forwarded); cache keys omitting a distinguishing parameter or
  hashing only a shared prefix (e.g. slicing only the first N bytes of an
  encoded payload); save/restore state stacks omitting coupled state fields;
  shallow clones or object spreads failing to copy or strip coupled metadata
  when transforming nodes or records; parent/root attributes or cancellation
  signals dropped when recursing into child operations.
- **Concrete checks:** Trace each option/state field end-to-end from entry point
  to final sink, checking every wrapper, cache key, clone, and stack push/pop.

## 12. Numeric narrowing, encoding, and escaping

Silent truncation, coercion, or injection at type, character-set, or format
boundaries.

- **Look for:** Casts to smaller integer types (collisions with sentinel values
  like `0xFFFF` or `-1`); float/int rounding errors in money, quotas, or
  coordinates; `null`/`undefined` coerced to `0` or `""` (loose falsy checks,
  `parseInt` producing `NaN`); UTF-16 `.length` vs UTF-8 byte length vs
  grapheme/code-point count; text interpolated into HTML, JSON, CSV,
  document/markup streams, regex, URL, or shell without format-specific
  escaping; missing token separators fusing adjacent serialized tokens or
  SQL/CLI fragments.
- **Concrete checks:** Feed quotes, backslashes, apostrophes, braces `{}`,
  format delimiters (`|`, `>`, `[`, `]`, `{{`, `}}`), emojis/surrogate pairs,
  zero, `null`, and fractional numbers through encoders and parsers.

## 13. Check-then-act (TOCTOU)

Code checks a condition, then acts later after another request, worker, cron,
or user action may have changed what was checked.

- **Look for:** `SELECT` followed by unguarded `UPDATE` or `DELETE` without
  compare-and-swap (`WHERE status = 'pending'`, `WHERE expires_at < cutoff AND
  NOT EXISTS (...)`); `if exists` then read/write/delete on object storage or
  filesystem (e.g. ref-counted delete racing with a concurrent upload); checking
  balance or quota before an async step then deducting without atomicity;
  scheduled or cleanup jobs acting on a stale snapshot while live traffic
  mutates keys.
- **Concrete checks:** Pause execution right after the check, run a competing
  mutation (delete, cancel, approve, upload, extend TTL), then resume — does the
  act corrupt or overwrite the newer state?

## 14. Fail-open defaults

Missing config, an unexpected exit code, an unknown enum value, an exception, or
a timeout is treated as "allowed", "passed", or "success".

- **Look for:** `default:` branches and `else` fallbacks in auth, permission,
  validation, or status switches; exit codes checked only for one failure value;
  feature flags or access controls defaulting to open when env vars or remote
  config are missing; `catch` blocks returning `true`/success or silently
  continuing with empty results; parsers silently accepting unterminated
  strings/blocks at EOF instead of failing or preserving boundaries; missing
  required resources or empty operations silently emitted/accepted instead of
  guarded.
- **Concrete checks:** Force missing config, unknown enum values, empty
  responses, and thrown exceptions — does the code fail closed?

## 15. Tests that silently skip their checks

A test or verification harness can return early, skip assertions, or treat
skipped steps as passes, reporting green without verifying anything.

- **Look for:** Early `return` in tests based on input, fixture presence, or env
  vars; conditional assertions (`if (result.ok) expect(...)` without asserting
  `result.ok` first); `for` loops holding the only assertion calls where the
  collection can be empty; `.skip` / `.only` / `.todo` left behind; mocked
  functions asserting `toHaveBeenCalled()` without checking arguments/order;
  property/fuzz tests whose generators produce vacuous inputs; `try/catch` in
  tests without an explicit fail/unreachable assertion (e.g.
  `expect.unreachable()`, `assert.fail()`) when an error is expected.
- **Concrete checks:** Mentally (or actually) break the code under test — would
  the test fail loudly, or pass vacuously?
