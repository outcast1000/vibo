#!/usr/bin/env node
// Pass 5 (backend): Tauri commands registered with the invoke handler that
// nothing outside Rust names. A command is "called" when its name appears
// (comments stripped) in the frontend, a plugin, scripts/ or tests/ — that
// covers `invoke("x")`, plugin `api.invoke("x")` and the e2e mock.
//
//   unused     — no caller anywhere: delete the command (and its handler entry)
//   rust-only  — no frontend/plugin caller, but other Rust code calls the
//                command fn itself (`commands::x(…)`, or `x(…)` in its own
//                file): drop it from the handler list, keep the fn
//   test-only  — only tests/e2e mock name it
//
// Registration is read from every `generate_handler![…]` and every
// `invoke_handler![…]` call in lib.rs (the debug build passes
// `clear_database` that way). Commands under #[cfg(debug_assertions)] are
// labelled, not hidden.
//
// Usage: node unused-commands.mjs [--json]
import { walk, read, code, ROOT, heading, isMain, isTest, escapeRe } from "./lib.mjs";

const HANDLER_LIST = /\b(?:generate_handler|invoke_handler)!\s*\[([\s\S]*?)\]/g;

/** Command names registered in lib.rs source text (comments stripped). */
export function registeredCommands(libText) {
  const out = new Set();
  for (const block of libText.matchAll(HANDLER_LIST)) {
    for (const entry of block[1].split(",")) {
      const path = entry.trim();
      // Skip macro metavariables (`$($extra,)*`) and anything that isn't a path.
      if (!/^[A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)*$/.test(path)) continue;
      out.add(path.split("::").pop());
    }
  }
  return [...out].sort();
}

/** lib.rs with its handler lists blanked, so registration isn't counted as a use. */
export function withoutHandlerLists(libText) {
  return libText.replace(HANDLER_LIST, (m) => m.replace(/[^\n]/g, " "));
}

/** The `#[tauri::command]` fn named `cmd` in `text`, or -1. Other attributes
 *  (`#[cfg(...)]`, `#[allow(...)]`) may sit between. */
export function commandDefIndex(text, cmd) {
  const re = new RegExp(`#\\[tauri::command[^\\]]*\\]\\s*(?:#\\[[^\\]]*\\]\\s*)*pub(?:\\([^)]*\\))?\\s+(?:async\\s+)?fn\\s+${escapeRe(cmd)}\\b`);
  const m = re.exec(text);
  return m ? m.index + m[0].length - cmd.length : -1;
}

/**
 * Rust references to the *command* fn `cmd` (not a same-named `Database`
 * method): `commands::…::cmd` anywhere, or a bare `cmd(` call in its own
 * file. Method calls (`.cmd(`) and other paths (`Database::cmd`) don't count.
 */
export function rustCommandRefs(files, defFile, cmd) {
  const e = escapeRe(cmd);
  const viaPath = new RegExp(`\\bcommands::(?:\\w+::)*${e}\\b`, "g");
  const bare = new RegExp(`(?<![.\\w:])(?<!fn\\s+)${e}\\s*\\(`, "g");
  let n = 0;
  for (const [file, text] of files) {
    n += text.match(viaPath)?.length ?? 0;
    if (file === defFile) n += text.match(bare)?.length ?? 0;
  }
  return n;
}

/** Identifier → set of files mentioning it (comments stripped). */
function index(files) {
  const map = new Map();
  for (const f of files) {
    for (const id of new Set(code(f).match(/[A-Za-z_][\w]*/g) ?? [])) {
      if (!map.has(id)) map.set(id, new Set());
      map.get(id).add(f);
    }
  }
  return map;
}

export function run() {
  const libText = code("src-tauri/src/lib.rs");
  const commands = registeredCommands(libText);
  const callers = walk(["src", "src-tauri/plugins", "scripts", "tests"], [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"]);
  const callerIdx = index(callers);
  const rust = walk(["src-tauri/src"], [".rs"]);
  const rustTexts = new Map(rust.map((f) => [f, f === "src-tauri/src/lib.rs" ? withoutHandlerLists(libText) : code(f)]));

  const findings = [];
  for (const cmd of commands) {
    const files = [...(callerIdx.get(cmd) ?? [])];
    if (files.some((f) => !isTest(f))) continue;

    let defFile = null;
    let defLine = 0;
    for (const [f, text] of rustTexts) {
      const at = commandDefIndex(text, cmd);
      if (at >= 0) { defFile = f; defLine = text.slice(0, at).split("\n").length; break; }
    }
    const debugOnly = defFile
      ? read(defFile).split("\n").slice(Math.max(0, defLine - 6), defLine).some((l) => l.includes("debug_assertions"))
      : false;
    const rustRefs = defFile ? rustCommandRefs(rustTexts, defFile, cmd) : 0;
    const status = files.length > 0 ? "test-only" : rustRefs > 0 ? "rust-only" : "unused";
    findings.push({ command: cmd, status, file: defFile ?? "?", line: defLine, debugOnly, testFiles: files });
  }
  return { total: commands.length, findings };
}

if (isMain(import.meta.url)) {
  const { total, findings } = run();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ total, findings }, null, 2));
  } else {
    heading(`Tauri commands with no frontend/plugin caller — ${findings.length} of ${total}`);
    for (const f of findings) {
      const extra = f.status === "test-only" ? ` (named in ${f.testFiles.join(", ")})` : "";
      console.log(`${f.file}:${f.line} — ${f.command} — ${f.status}${f.debugOnly ? " [debug_assertions]" : ""}${extra}`);
    }
    if (findings.length === 0) console.log(`All ${total} registered commands have a caller. (root: ${ROOT})`);
  }
}
