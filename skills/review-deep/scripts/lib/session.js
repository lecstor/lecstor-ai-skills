// Pieces of the multi-turn review session: prompt sections, chunking, claude arguments and
// output parsing. Kept free of I/O so they can be tested without running claude.

const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          start_line: { type: "integer" },
          end_line: { type: "integer" },
          message: { type: "string" },
        },
        required: ["file", "start_line", "end_line", "message"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
};

const NOTES_SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, note: { type: "string" } },
        required: ["id", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["notes"],
  additionalProperties: false,
};

// Shell commands the reviewer may run. --restricted keeps their path arguments, and the file
// tools, inside the checkout, but git diff/log/show also take --output=<file>, which writes
// anywhere; DENIED_BASH blocks it. Deny rules match "*" anywhere in the command.
// The tests check only that these arguments are passed. That claude enforces them (out-of-checkout
// paths, the --output pattern, git grep -O) was checked by hand with Claude Code 2.1.325.
// `git grep` is left out: its -O<cmd> (--open-files-in-pager) runs a command, and -O can be
// bundled with other short flags, so no deny pattern covers it. The Grep tool searches instead.
const ALLOWED_BASH = ["git diff", "git log", "git show", "git blame", "git ls-files", "ls", "wc"];
const DENIED_BASH = ["*--output*"];

/** The prompt's three parts: first notes turn, later notes turns, findings turn. */
function splitPrompt(template) {
  const [first, rest] = template.split(/^=== next notes ===\s*$/m);
  const [next, findings] = (rest ?? "").split(/^=== findings ===\s*$/m);
  if (!first?.trim() || !next?.trim() || !findings?.trim()) {
    throw new Error("the prompt needs '=== next notes ===' and '=== findings ===' sections");
  }
  return { first, next, findings };
}

/** Replace {{name}} with vars[name]; unknown names are left as they are. */
function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
}

/** Numbered map items in chunks of `size`. An empty map still gives one chunk. */
function chunkItems(changeItems, flowItems, size) {
  const items = [...changeItems.map((t, i) => `M${i + 1}. ${t}`), ...flowItems.map((t, i) => `F${i + 1}. ${t}`)];
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  if (chunks.length === 0) chunks.push(["(no changed regions found)"]);
  return chunks;
}

/** Arguments for one `claude -p` turn. The first turn creates the session, later turns resume it. */
function claudeArgs({ model, effort, schema, sessionId, resume }) {
  const args = [
    "-p",
    "--model", model,
    "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
    "--tools", "Read Grep Glob Bash",
    "--allowedTools", ...ALLOWED_BASH.map((c) => `Bash(${c}:*)`),
    "--disallowedTools", ...DENIED_BASH.map((c) => `Bash(${c})`),
    // Ignore user, project and local settings: the checkout may be someone else's PR, and its
    // .claude/settings.json could add hooks or allow rules. --restricted also confines the file
    // tools to the checkout; dontAsk denies anything outside the allowlist instead of asking.
    "--restricted",
    "--permission-mode", "dontAsk",
    "--strict-mcp-config",
    ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
  ];
  if (effort) args.push("--effort", effort);
  return args;
}

/**
 * Parse `claude -p --output-format json` stdout. Throws with the reason when the turn failed.
 * With `lenient`, a turn that succeeded but returned no list gives an empty list (used for notes
 * turns, which only feed the session's context).
 */
function parseTurn(stdout, key, { lenient = false } = {}) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(`claude returned no JSON: ${stdout.slice(0, 500)}`);
  }
  if (result.is_error) throw new Error(`claude reported an error (${result.subtype ?? "error"}): ${String(result.result ?? "").slice(0, 500)}`);
  let value = result.structured_output?.[key];
  if (value === undefined) {
    // Fallback: the JSON as plain text in the result, possibly among prose that has braces too.
    value = jsonObjects(String(result.result ?? ""))
      .reverse()
      .map((text) => {
        try {
          return JSON.parse(text)?.[key];
        } catch {
          return undefined;
        }
      })
      .find(Array.isArray);
  }
  if (!Array.isArray(value)) {
    if (lenient) return { value: [], result, missing: true };
    throw new Error(`claude returned no "${key}" list`);
  }
  return { value, result };
}

/**
 * Each balanced {...} in the text, nested ones included, in order of where they start. Braces
 * inside JSON strings are skipped. Nested spans are kept so JSON wrapped in prose braces
 * ("{see {...}}") is still found.
 */
function jsonObjects(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (ch === "\\") j++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        out.push(text.slice(i, j + 1));
        break;
      }
    }
  }
  return out;
}

/** Normalise findings; drop ones without a file, a positive start line or a message. */
function cleanFindings(list) {
  const out = [];
  for (const f of list) {
    const file = typeof f?.file === "string" ? f.file.replace(/^\.\//, "").replace(/\\/g, "/") : "";
    const start = Number(f?.start_line);
    const end = Number(f?.end_line);
    const message = typeof f?.message === "string" ? f.message.trim() : "";
    if (!file || !message || !Number.isInteger(start) || start < 1) continue;
    out.push({ file, start_line: start, end_line: Number.isInteger(end) && end >= start ? end : start, message });
  }
  return out;
}

module.exports = { FINDINGS_SCHEMA, NOTES_SCHEMA, ALLOWED_BASH, DENIED_BASH, splitPrompt, render, chunkItems, claudeArgs, parseTurn, cleanFindings };
