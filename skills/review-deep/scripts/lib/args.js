// Minimal flag parser: --key value, repeatable keys collect into arrays, --flag alone is true.
function parseArgs(argv, repeatable = []) {
  const out = { _: [] };
  for (const k of repeatable) out[k] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    if (key.includes("=")) { console.error(`use "--${key.split("=")[0]} <value>", not "--${key}"`); process.exit(1); }
    const next = argv[i + 1];
    const val = next === undefined || next.startsWith("--") ? true : (i++, next);
    if (repeatable.includes(key)) out[key].push(val);
    else out[key] = val;
  }
  return out;
}

function required(args, keys, usage) {
  const missing = keys.filter((k) => args[k] === undefined || args[k] === true);
  if (missing.length) {
    console.error(`missing --${missing.join(", --")}\n${usage}`);
    process.exit(1);
  }
}

module.exports = { parseArgs, required };
