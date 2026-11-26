#!/usr/bin/env node
// Runs the benchmarked review session on the checked-out repository and prints JSON:
// harness-built change and flow maps, notes per chunk of 25 map items (no findings), then a
// findings turn that confirms the notes, all in one `claude -p` session.
// The benchmark figures for this method are in ../SKILL.md (Step 3).
const { execFileSync, spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { constants } = require("node:os");
const { join } = require("node:path");
const { parseArgs, required } = require("./lib/args");
const { changeMapItems, flowMapItems } = require("./lib/maps");
const { FINDINGS_SCHEMA, NOTES_SCHEMA, splitPrompt, render, chunkItems, claudeArgs, parseTurn, cleanFindings } = require("./lib/session");

const USAGE = `usage: review-session.js --base <ref> [--working] [--title <text>] [--body-file <path>]
       [--model opus] [--effort medium] [--chunk 25] [--out <file>]

Run from the repository root with the PR head checked out.
  --base       the PR's base branch or commit (the diff is <base>...HEAD)
  --working    review the working tree against the merge-base with <base>, including
               uncommitted changes (untracked files are left out: git add -N them first)
  --title      PR title (or a one-line summary of a local change)
  --body-file  file holding the PR description, ticket or change notes
  --out        write the JSON here instead of stdout

Environment: REVIEW_SESSION_TURN_TIMEOUT_MS sets the per-turn timeout (default 30 minutes).`;

// Flags that take a value; given with none, parseArgs sets them to true.
const VALUE_FLAGS = ["title", "body-file", "model", "effort", "chunk", "out"];
// REVIEW_SESSION_TURN_TIMEOUT_MS overrides the per-turn timeout (used by tests).
const TIMEOUT_ENV = process.env.REVIEW_SESSION_TURN_TIMEOUT_MS;
const TURN_TIMEOUT_MS = TIMEOUT_ENV === undefined ? 30 * 60 * 1000 : Number(TIMEOUT_ENV);
// After SIGTERM on a timed-out turn, how long to wait before SIGKILL.
const KILL_GRACE_MS = 5000;
// After claude exits, how long to wait for its pipes to close before taking its output.
const EXIT_GRACE_MS = 2000;
// Fixed prefixes and no external diff or colour, whatever the user's git config says, so the
// maps can parse the diff.
const DIFF_OPTS = ["--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-color"];

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

// The running claude's process group, so a timeout or Ctrl-C can end its subprocesses too.
let activeGroup = null;

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

// Groups sent SIGTERM whose SIGKILL is still due. If the script exits first (a timed-out turn
// ends the run at once), they get it on the way out.
const pendingKill = new Set();
process.on("exit", () => {
  for (const pid of pendingKill) killGroup(pid, "SIGKILL");
});

// claude runs in its own process group (detached), so it no longer gets the terminal's Ctrl-C
// or hangup; pass them on. A SIGKILL sent to this script cannot be caught or passed on, and
// leaves claude running until it finishes its turn.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (activeGroup) killGroup(activeGroup, "SIGTERM");
    process.exit(128 + constants.signals[signal]);
  });
}

function runClaude(args, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_BIN || "claude", args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
    activeGroup = child.pid;
    let stdout = "";
    let stderr = "";
    let exitCode = null;
    let exited = false;
    let killTimer;
    let exitTimer;
    let killSent = false;
    const term = () => {
      killSent = true;
      killGroup(child.pid, "SIGTERM");
    };
    // Settle once: the timeout, the child's exit and its pipes closing can race.
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(exitTimer);
      activeGroup = null;
      // A subprocess that ignores SIGTERM gets SIGKILL later, without holding the script open,
      // and its pipes are let go so they cannot keep the script running either.
      if (killSent) {
        pendingKill.add(child.pid);
        setTimeout(() => {
          killGroup(child.pid, "SIGKILL");
          pendingKill.delete(child.pid);
        }, KILL_GRACE_MS).unref();
      }
      child.stdout.destroy();
      child.stderr.destroy();
      fn(value);
    };
    const finish = () => {
      if (!stdout.trim()) settle(reject, new Error(`claude exited ${exitCode} with no output: ${stderr.slice(0, 500)}`));
      else settle(resolve, stdout);
    };
    const timedOut = () => new Error(`claude turn timed out after ${TURN_TIMEOUT_MS / 1000}s`);
    const timer = setTimeout(() => {
      term();
      if (exited) return settle(reject, timedOut());
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
      // Settle when it exits: a subprocess still holding the pipes would delay "close".
      child.once("exit", () => settle(reject, timedOut()));
    }, TURN_TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => settle(reject, e));
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      // Normally "close" follows at once. If a subprocess left behind keeps the pipes open,
      // take what claude wrote and end the subprocess instead of waiting for the timeout.
      exitTimer = setTimeout(() => {
        term();
        finish();
      }, EXIT_GRACE_MS);
    });
    child.on("close", finish);
    // claude can exit before reading the prompt (bad flag, auth, usage limit); the close
    // handler then reports its stderr, so a broken pipe here must not crash the script.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  required(a, ["base"], USAGE);
  if (!Number.isInteger(TURN_TIMEOUT_MS) || TURN_TIMEOUT_MS < 1) {
    console.error(`REVIEW_SESSION_TURN_TIMEOUT_MS must be a positive integer of milliseconds, not "${TIMEOUT_ENV}"`);
    process.exit(1);
  }
  const empty = VALUE_FLAGS.filter((k) => a[k] === true);
  if (empty.length) {
    console.error(`--${empty.join(", --")} needs a value\n${USAGE}`);
    process.exit(1);
  }
  const base = a.base;
  // --merge-base: compare with where the branch left <base>, so later base commits do not
  // show up as reverse changes.
  const range = a.working ? ["--merge-base", base] : [`${base}...HEAD`];
  const diffCmd = `git diff ${range.join(" ")}`;
  const diff = git("diff", ...DIFF_OPTS, ...range);
  if (!diff.trim()) {
    console.error(`no changes in ${diffCmd}`);
    process.exit(1);
  }
  if (a.working) {
    const untracked = git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
    if (untracked.length) console.error(`review-session: ${untracked.length} untracked file(s) are not in the diff and will not be reviewed (git add -N <file> to include them): ${untracked.slice(0, 10).join(", ")}${untracked.length > 10 ? ", ..." : ""}`);
  }
  const chunkSize = Number(a.chunk ?? 25);
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    console.error(`--chunk must be a positive integer\n${USAGE}`);
    process.exit(1);
  }
  const model = a.model ?? "opus";
  const effort = a.effort ?? "medium";
  const parts = splitPrompt(readFileSync(join(__dirname, "prompt.md"), "utf8"));
  const vars = {
    title: a.title || "(none given)",
    body: a["body-file"] ? readFileSync(a["body-file"], "utf8").trim() || "(empty)" : "(none given)",
    base,
    head: a.working ? `${git("rev-parse", "--short", "HEAD").trim()} plus uncommitted changes` : git("rev-parse", "--short", "HEAD").trim(),
    diff_cmd: diffCmd,
    diff_stat: git("diff", ...DIFF_OPTS, "--stat=200", ...range).trim(),
  };

  const changeItems = changeMapItems(diff);
  const flowItems = flowMapItems(diff, process.cwd());
  const chunks = chunkItems(changeItems, flowItems, chunkSize);
  console.error(`review-session: ${changeItems.length} change items, ${flowItems.length} flow items, ${chunks.length} chunk(s), ${model} at ${effort} effort`);

  const sessionId = randomUUID();
  const started = Date.now();
  const notes = [];
  let last;
  // The session's transcript is kept, so what the reviewer read and ran can be checked afterwards.
  console.error(`review-session: claude session ${sessionId}`);
  for (let c = 0; c < chunks.length; c++) {
    const prompt = render(c === 0 ? parts.first : parts.next, { ...vars, items: chunks[c].join("\n"), chunk_label: `${c + 1} of ${chunks.length}` });
    const out = await runClaude(claudeArgs({ model, effort, schema: NOTES_SCHEMA, sessionId, resume: c > 0 }), prompt);
    const { value, result, missing } = parseTurn(out, "notes", { lenient: true });
    notes.push(...value);
    last = result;
    console.error(`review-session: chunk ${c + 1} of ${chunks.length}: ${missing ? "no notes list returned, continuing" : `${value.length} notes`}, ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
  const out = await runClaude(claudeArgs({ model, effort, schema: FINDINGS_SCHEMA, sessionId, resume: true }), render(parts.findings, vars));
  const { value, result } = parseTurn(out, "findings");
  last = result;
  const findings = cleanFindings(value);
  const report = {
    base,
    head: vars.head,
    model,
    effort,
    session_id: sessionId,
    items: { change: changeItems.length, flow: flowItems.length, chunks: chunks.length },
    findings,
    notes,
    // On a resumed session claude reports running totals, so the last turn's figure is the review's.
    usage: { cost_usd: last?.total_cost_usd ?? null, duration_ms: Date.now() - started },
  };
  const json = JSON.stringify(report, null, 2);
  if (a.out) writeFileSync(a.out, json);
  else process.stdout.write(json + "\n");
  console.error(`review-session: ${findings.length} findings from ${notes.length} notes, ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

main().catch((e) => {
  console.error(`review-session failed: ${e.message}`);
  process.exit(1);
});
