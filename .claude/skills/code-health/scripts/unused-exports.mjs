#!/usr/bin/env node
// Pass 5 (frontend): exports under src/ that nothing uses.
//
//   dead       — no other file names it and its own file mentions it only at
//                the declaration: delete it
//   test-only  — only tests name it (production never calls it): delete it and
//                its test, or it's a test seam worth a comment
//   local      — used inside its own file only (--local): the `export` is
//                unnecessary. Harmless; listed only on request because there are
//                hundreds, mostly types exported for documentation.
//
// Matching is by identifier, comments stripped, across src/, tests/ and
// scripts/. Two exports with the same name in different files hide each
// other (a false negative, never a false positive). Re-exports
// (`export { x } from`) and `export default` are not checked.
//
// Usage: node unused-exports.mjs [--local] [--types] [--json]
//   --types  include type/interface exports in dead/test-only (default: values only)
import { walk, code, lineOf, isTest, heading, isMain } from "./lib.mjs";

const ENTRY_POINTS = new Set(["src/main.tsx", "src/vite-env.d.ts"]);
const EXPORT_RE = /^export\s+(?:declare\s+)?(?:async\s+)?(function\*?|const|let|class|abstract\s+class|enum|type|interface)\s+([A-Za-z_$][\w$]*)/gm;

export function run({ includeTypes = false, includeLocal = false } = {}) {
  const src = walk(["src"], [".ts", ".tsx"]).filter((f) => !f.endsWith(".d.ts"));
  const corpus = [...new Set([...src, ...walk(["tests", "scripts"], [".ts", ".tsx", ".js", ".mjs", ".cjs"])])];

  // identifier → Map<file, count>
  const idx = new Map();
  for (const f of corpus) {
    for (const id of code(f).match(/[A-Za-z_$][\w$]*/g) ?? []) {
      let m = idx.get(id);
      if (!m) idx.set(id, (m = new Map()));
      m.set(f, (m.get(f) ?? 0) + 1);
    }
  }

  const findings = [];
  for (const f of src) {
    if (isTest(f) || ENTRY_POINTS.has(f)) continue;
    const text = code(f);
    for (const m of text.matchAll(EXPORT_RE)) {
      const kind = m[1].replace(/\s+/g, " ");
      const name = m[2];
      const isType = kind === "type" || kind === "interface";
      const uses = idx.get(name) ?? new Map();
      const inFile = uses.get(f) ?? 0;
      let prod = 0, tests = 0;
      for (const [file] of uses) {
        if (file === f) continue;
        if (isTest(file)) tests++; else prod++;
      }
      if (prod > 0) continue;
      // Overloads / declaration merging declare the same name more than once;
      // only a line that *declares* it counts (`export function f(a = NAME)`
      // is a use of NAME, not a declaration).
      const decls = [...text.matchAll(new RegExp(
        `^export\\s+(?:declare\\s+)?(?:async\\s+)?(?:function\\*?|const|let|class|abstract\\s+class|enum|type|interface)\\s+${name.replace(/\$/g, "\\$")}(?![\\w$])`, "gm",
      ))].length || 1;
      const localUses = inFile - decls;
      let status;
      if (tests === 0 && localUses <= 0) status = "dead";
      else if (localUses <= 0) status = "test-only";
      else status = "local";
      if (status === "local" && !includeLocal) continue;
      if (isType && status !== "local" && !includeTypes) continue;
      findings.push({ file: f, line: lineOf(text, m.index), name, kind, status });
    }
  }
  const order = { dead: 0, "test-only": 1, local: 2 };
  findings.sort((a, b) => order[a.status] - order[b.status] || a.file.localeCompare(b.file) || a.line - b.line);
  return findings;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const findings = run({ includeTypes: argv.includes("--types"), includeLocal: argv.includes("--local") });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    for (const status of ["dead", "test-only", "local"]) {
      const rows = findings.filter((x) => x.status === status);
      if (status === "local" && !argv.includes("--local")) continue;
      heading(`Exports: ${status} — ${rows.length}`);
      for (const r of rows) console.log(`${r.file}:${r.line} — ${r.kind} ${r.name}`);
    }
  }
}
