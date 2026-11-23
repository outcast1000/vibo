// Shared helpers for the code-health scripts. No dependencies: plain Node.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, relative, sep } from "node:path";

/** Repo root (works from any worktree / subdirectory). */
export const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

const SKIP_DIRS = new Set(["node_modules", "target", "dist", ".git", "gen", "test-results", "playwright-report"]);

/** Every file under `dirs` (repo-relative) whose name matches `exts`, as repo-relative posix paths. */
export function walk(dirs, exts) {
  const out = [];
  const visit = (abs) => {
    let st;
    try { st = statSync(abs); } catch { return; } // a listed root that doesn't exist (tests/ on a fresh clone)
    if (st.isDirectory()) {
      for (const name of readdirSync(abs)) if (!SKIP_DIRS.has(name)) visit(join(abs, name));
    } else if (exts.some((e) => abs.endsWith(e))) {
      out.push(relative(ROOT, abs).split(sep).join("/"));
    }
  };
  for (const d of dirs) visit(join(ROOT, d));
  return out;
}

const cache = new Map();
export function read(rel) {
  if (!cache.has(rel)) cache.set(rel, readFileSync(join(ROOT, rel), "utf8"));
  return cache.get(rel);
}

/**
 * Blank out comments, keeping newlines so offsets still map to the right
 * line. Strings and template literals are left alone (a command name lives in
 * a string). `lang` is "rs" for Rust: there `'a` is a lifetime (not a
 * string), char literals are `'x'` / `'\\n'`, `"…"` may span lines and raw
 * strings are `r"…"` / `r#"…"#`. Known blind spot: JS regex literals
 * containing `//`.
 */
export function stripComments(text, lang = "ts") {
  const rust = lang === "rs";
  let out = "";
  let i = 0;
  const n = text.length;
  const copyUntil = (end) => { out += text.slice(i, end); i = end; };
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && text[i] !== "\n") { out += " "; i++; }
    } else if (c === "/" && d === "*") {
      out += "  "; i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) { out += text[i] === "\n" ? "\n" : " "; i++; }
      out += "  "; i += 2;
    } else if (rust && c === "r" && (d === '"' || d === "#") && !/[\w]/.test(text[i - 1] ?? "")) {
      // Raw string r"…" / r#"…"#: no escapes, ends at the matching hashes.
      const m = /^r(#*)"/.exec(text.slice(i, i + 64));
      if (!m) { out += c; i++; continue; }
      const close = '"' + m[1];
      const end = text.indexOf(close, i + m[0].length);
      copyUntil(end < 0 ? n : end + close.length);
    } else if (rust && c === "'") {
      // Char literal ('x', '\n', '\u{1F600}') or a lifetime ('a, 'static).
      if (d === "\\") {
        const end = text.indexOf("'", i + 3); // i+2 is the escaped char itself ('\'')
        copyUntil(end < 0 || end - i > 12 ? i + 1 : end + 1);
      } else {
        const cp = text.codePointAt(i + 1);
        const w = cp > 0xffff ? 2 : 1;
        copyUntil(text[i + 1 + w] === "'" ? i + 2 + w : i + 1); // otherwise a lifetime: just the quote
      }
    } else if (c === '"' || c === "'" || c === "`") {
      // Copy a string verbatim, honouring escapes, so `"https://x"` isn't eaten as a comment.
      const q = c; out += c; i++;
      const multiline = q === "`" || (rust && q === '"');
      while (i < n && text[i] !== q) {
        if (text[i] === "\\") { out += text[i] + (text[i + 1] ?? ""); i += 2; continue; }
        if (!multiline && text[i] === "\n") break; // unterminated — stop at the line end
        out += text[i]; i++;
      }
      if (i < n && text[i] === q) { out += q; i++; }
    } else {
      out += c; i++;
    }
  }
  return out;
}

const stripped = new Map();
export function code(rel) {
  if (!stripped.has(rel)) stripped.set(rel, stripComments(read(rel), rel.endsWith(".rs") ? "rs" : "ts"));
  return stripped.get(rel);
}

export function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export const isTest = (rel) =>
  rel.includes("/__tests__/") || rel.startsWith("tests/") || /\.test\.[cm]?[jt]sx?$/.test(rel) || rel.endsWith("/tests.rs");

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function heading(title) {
  console.log(`\n${title}\n${"─".repeat(title.length)}`);
}

/** True when the module at `metaUrl` is the script node was started with
 *  (symlinks, Windows paths and `#`/`?` in the path all resolved). */
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false; // argv[1] isn't a file (node -e / a REPL) — not run directly
  }
}
