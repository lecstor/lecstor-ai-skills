// Builds the review checklist from a unified diff, with no model involved.
// These are the change and flow maps the benchmark figures in SKILL.md were measured with.
const { execFileSync } = require("node:child_process");

// One list of source extensions for the definition scan, the grep pathspecs and test detection.
const CODE_EXTS = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"];
const EXT_GROUP = `(?:${CODE_EXTS.join("|")})`;
const CODE_FILE = new RegExp(`\\.${EXT_GROUP}$`);
const GREP_PATHSPECS = [...CODE_EXTS.map((e) => `*.${e}`), ":!*.d.ts", ":!*.d.mts", ":!*.d.cts", ":!*.min.js"];

/** Undo git's C-style quoting of a path ("b/caf\303\251.ts") and its trailing tab. */
function diffPath(raw) {
  let p = raw.replace(/\t.*$/, "");
  if (p.startsWith('"') && p.endsWith('"')) {
    const bytes = [];
    const body = [...p.slice(1, -1)]; // by code point, so a literal astral character stays whole
    const simple = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11, '"': 34, "\\": 92 };
    for (let i = 0; i < body.length; i++) {
      if (body[i] !== "\\") {
        bytes.push(...Buffer.from(body[i]));
        continue;
      }
      const oct = body.slice(i + 1, i + 4).join("");
      if (/^[0-7]{3}$/.test(oct)) {
        bytes.push(parseInt(oct, 8));
        i += 3;
      } else {
        const next = body[i + 1] ?? "";
        bytes.push(...(next in simple ? [simple[next]] : Buffer.from(next)));
        i += 1;
      }
    }
    p = Buffer.from(bytes).toString("utf8");
  }
  return p.replace(/^b\//, "");
}

/**
 * Walk a unified diff. Hunk bodies are counted with the hunk header's line counts, so a
 * content line that happens to start with "+++ " is never taken for a file header.
 * Calls onHunk(file, newStart, newCount, context) and onLine(file, kind, text, newLine).
 */
function walkDiff(diff, { onHunk = () => {}, onLine = () => {} }) {
  let file = "";
  let oldLeft = 0;
  let newLeft = 0;
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      const kind = raw[0];
      if (kind === "\\") continue; // "\ No newline at end of file"
      if (kind === "+") {
        onLine(file, "+", raw.slice(1), line++);
        newLeft--;
      } else if (kind === "-") {
        onLine(file, "-", raw.slice(1), line);
        oldLeft--;
      } else {
        onLine(file, " ", raw.slice(1), line++);
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    if (raw.startsWith("+++ ")) {
      file = diffPath(raw.slice(4));
      continue;
    }
    const m = raw.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
    if (!m) continue;
    oldLeft = m[1] === undefined ? 1 : Number(m[1]);
    line = Number(m[2]);
    newLeft = m[3] === undefined ? 1 : Number(m[3]);
    onHunk(file, line, newLeft, m[4].trim());
  }
}

/**
 * One item per diff hunk: file, head line range, and the enclosing function or block that
 * git puts in the hunk header. Unnumbered; the caller numbers them M1, M2, ...
 */
function changeMapItems(diff) {
  const items = [];
  walkDiff(diff, {
    onHunk(file, start, count, ctx) {
      if (!file || file === "/dev/null") return;
      const where = count === 0 ? `${file} (lines removed near line ${start})` : `${file}:${start}-${start + count - 1}`;
      items.push(`${where}${ctx ? `  (in: ${ctx.slice(0, 80)})` : ""}`);
    },
  });
  return items;
}

const FLOW_MAX_USES = 8;
const FLOW_SKIP = new Set(["constructor", "render", "default", "props", "state", "index", "main", "init", "setup", "test", "it", "describe", "expect", "then", "catch", "map", "filter", "reduce", "forEach", "push", "get", "set", "has", "toString", "value", "data", "error", "result", "options", "config", "handler", "callback", "fn", "cb", "if", "for", "while", "switch", "return", "function"]);
const DEF_PATTERNS = [
  /\bfunction\s*\*?\s+([A-Za-z_$][\w$]*)\s*[<(]/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/,
  /\b(?:interface|type|class|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:(?:public|private|protected|static|async|override|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::[^{]+)?\{\s*$/,
];

/** True when this line of source defines `name` by one of the patterns above. */
const definesName = (text, name) => DEF_PATTERNS.some((re) => text.match(re)?.[1] === name);

/** Names of definitions in the diff's added lines and hunk headers, with where they are. */
function changedDefinitions(diff) {
  const defs = new Map(); // name -> "file:line" or "file:line (body changed)"
  const add = (text, at) => {
    for (const re of DEF_PATTERNS) {
      const m = text.match(re);
      if (m && m[1].length >= 3 && !FLOW_SKIP.has(m[1]) && !defs.has(m[1])) defs.set(m[1], at);
    }
  };
  walkDiff(diff, {
    // The hunk header names the enclosing definition, so body-only changes count too.
    onHunk(file, start, count, ctx) {
      if (CODE_FILE.test(file)) add(ctx, `${file}:${start} (body changed)`);
    },
    onLine(file, kind, text, line) {
      if (kind === "+" && CODE_FILE.test(file)) add(text, `${file}:${line}`);
    },
  });
  return defs;
}

/** `git grep` hits for `name` as "file:line:text". No match gives []; any other failure throws. */
function gitGrepUses(cwd, name) {
  try {
    return execFileSync("git", ["-c", "core.quotePath=false", "grep", "-n", "-w", "-I", "-F", "-e", name, "--", ...GREP_PATHSPECS], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })
      .split("\n")
      .filter(Boolean);
  } catch (e) {
    if (e.status === 1) return []; // git grep exits 1 when nothing matches
    // The reason, not execFileSync's "Command failed: <the whole command>".
    const reason = e.code || String(e.stderr ?? "").trim().split("\n")[0] || `exit ${e.status}`;
    throw new Error(`git grep for ${name} failed: ${reason}`);
  }
}

const TEST_PATH = new RegExp(`(^|/)(tests?|__tests__|e2e|spec)/|\\.(test|spec)\\.${EXT_GROUP}:`);
const isTest = (u) => TEST_PATH.test(u);

/**
 * Each definition the diff adds or changes, with the places in the checkout that use it,
 * real callers before tests, capped at 8 uses. Unnumbered; the caller numbers them F1, F2, ...
 * `grep` is injectable for tests; it returns "file:line" or "file:line:text" strings.
 */
function flowMapItems(diff, cwd, maxNames = 60, grep = gitGrepUses) {
  const defs = changedDefinitions(diff);
  const items = [];
  for (const [name, at] of [...defs].slice(0, maxNames)) {
    const bodyChanged = at.endsWith(" (body changed)");
    const self = at.replace(/ \(body changed\)$/, "");
    const selfFile = self.replace(/:\d+$/, "");
    let hits;
    try {
      hits = grep(cwd, name);
    } catch (e) {
      // One failed search (say, too much output for a short common name) costs that item's
      // uses, not the review.
      items.push(`\`${name}\` defined or changed at ${at}; uses not listed (${e.message.split("\n")[0]})`);
      continue;
    }
    // Leave out the definition itself. For a body-only change the recorded line is the
    // hunk's, not the definition's: the definition is the nearest line at or above it in that
    // file that defines the name. Other same-named definitions stay in the list.
    const parsed = hits.map((hit) => {
      const [file, line, ...rest] = hit.split(":");
      return { file, line: Number(line), loc: `${file}:${line}`, text: rest.join(":") };
    });
    let defLoc = self;
    if (bodyChanged) {
      const hunkLine = Number(self.slice(selfFile.length + 1));
      const above = parsed.filter((h) => h.file === selfFile && h.line <= hunkLine && definesName(h.text, name));
      if (above.length) defLoc = above.reduce((x, y) => (y.line > x.line ? y : x)).loc;
    }
    const all = parsed.filter((h) => h.loc !== defLoc).map((h) => h.loc);
    const uses = [...all.filter((u) => !isTest(u)), ...all.filter(isTest)];
    const shown = uses.slice(0, FLOW_MAX_USES).join(", ");
    const more = uses.length > FLOW_MAX_USES ? ` (+${uses.length - FLOW_MAX_USES} more)` : "";
    items.push(`\`${name}\` defined or changed at ${at}; used at: ${uses.length ? shown + more : "nowhere else"}`);
  }
  if (defs.size > maxNames) items.push(`(${defs.size - maxNames} more changed definitions not listed)`);
  return items;
}

module.exports = { changeMapItems, changedDefinitions, flowMapItems, gitGrepUses };
