#!/usr/bin/env node
// One entry point for the mechanical half of /code-health.
//
//   node .claude/skills/code-health/scripts/scan.mjs            # the three scripts (~1s)
//   node .claude/skills/code-health/scripts/scan.mjs --tools    # + npm run lint + cargo check (slow)
//   node .claude/skills/code-health/scripts/scan.mjs --json     # machine-readable
//
// Output is raw evidence, not the report: the skill still reads each hit,
// discards false positives and assigns priority.
import { execSync } from "node:child_process";
import { ROOT, heading } from "./lib.mjs";
import * as canonical from "./canonical-actions.mjs";
import * as commands from "./unused-commands.mjs";
import * as exportsScan from "./unused-exports.mjs";

const argv = process.argv.slice(2);
const json = argv.includes("--json");

function sh(cmd, cwd = ROOT) {
  try {
    return { ok: true, out: execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const result = {
  canonical: canonical.run(),
  commands: commands.run(),
  exports: exportsScan.run(),
};

if (argv.includes("--tools")) {
  const lint = sh("npm run lint --silent");
  const summary = lint.out.match(/✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/);
  result.lint = {
    ok: lint.ok,
    errors: summary ? Number(summary[2]) : lint.ok ? 0 : null,
    warnings: summary ? Number(summary[3]) : 0,
    errorLines: lint.out.split("\n").filter((l) => /\berror\b/.test(l) && /^\s+\d+:\d+/.test(l)),
  };
  const cargo = sh("cargo check --message-format=short 2>&1", `${ROOT}/src-tauri`);
  result.cargo = {
    ok: cargo.ok,
    warnings: cargo.out.split("\n").filter((l) => /^src\/.*: warning: /.test(l)),
    errors: cargo.out.split("\n").filter((l) => /^src\/.*: error/.test(l)),
  };
}

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  heading(`Canonical actions & removed features — ${result.canonical.length}`);
  for (const f of result.canonical) console.log(`${f.file}:${f.line} — [${f.kind}] ${f.what} — ${f.fix}`);

  heading(`Tauri commands without a caller — ${result.commands.findings.length} of ${result.commands.total}`);
  for (const f of result.commands.findings) console.log(`${f.file}:${f.line} — ${f.command} — ${f.status}${f.debugOnly ? " [debug_assertions]" : ""}`);

  for (const status of ["dead", "test-only"]) {
    const rows = result.exports.filter((x) => x.status === status);
    heading(`Exports: ${status} — ${rows.length}`);
    for (const r of rows) console.log(`${r.file}:${r.line} — ${r.kind} ${r.name}`);
  }

  if (result.lint) {
    // `lint` exits non-zero on errors *or* on going over its --max-warnings cap;
    // the second fails CI just the same, so say so rather than print a clean count.
    const verdict = result.lint.ok ? "passed" : result.lint.errors ? "FAILED" : "FAILED (warning cap exceeded — see --max-warnings in package.json)";
    heading(`npm run lint — ${verdict}: ${result.lint.errors ?? "?"} errors, ${result.lint.warnings} warnings`);
    for (const l of result.lint.errorLines) console.log(l.trim());
  }
  if (result.cargo) {
    heading(`cargo check — ${result.cargo.ok ? "passed" : "FAILED"}: ${result.cargo.errors.length} errors, ${result.cargo.warnings.length} warnings`);
    for (const l of [...result.cargo.errors, ...result.cargo.warnings]) console.log(l);
  }
}
