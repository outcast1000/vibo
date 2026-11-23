#!/usr/bin/env node
// Fixtures for the parsing the code-health scripts rely on. Run after editing
// any script: `node .claude/skills/code-health/scripts/selftest.mjs`.
// A check that silently stops matching is the failure mode these guard.
import assert from "node:assert/strict";
import { stripComments } from "./lib.mjs";
import { FORBIDDEN, overlayDismissHits } from "./canonical-actions.mjs";
import { registeredCommands, withoutHandlerLists, commandDefIndex, rustCommandRefs } from "./unused-commands.mjs";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}
const hits = (src, lang = "ts") => FORBIDDEN.filter((r) => r.re.test(stripComments(src, lang))).map((r) => r.what);

// ── stripComments ────────────────────────────────────────────────────────────
test("strips // and /* */, keeps line count", () => {
  const out = stripComments("a // x\n/* y\n z */ b");
  assert.equal(out.split("\n").length, 3);
  assert.ok(!out.includes("x") && !out.includes("y") && out.includes("b"));
});
test("keeps // inside strings", () => {
  assert.ok(stripComments('const u = "https://x.y/z"; // gone').includes("https://x.y/z"));
  assert.ok(!stripComments('const u = "https://x.y/z"; // gone').includes("gone"));
});
test("rust: lifetime does not swallow a trailing comment", () => {
  const out = stripComments("fn x<'a>(s: &'a str) {} // removed roadie shim", "rs");
  assert.ok(!out.includes("roadie"));
  assert.ok(out.includes("&'a str"));
});
test("rust: char literals, escaped quote included", () => {
  const out = stripComments("let q = '\\''; let c = 'x'; // gone", "rs");
  assert.ok(out.includes("'\\''") && out.includes("'x'") && !out.includes("gone"));
});
test("rust: multi-line string keeps its URL and doesn't turn continuation into code", () => {
  const out = stripComments('let s = "SELECT 1\n  -- see https://example.com\n  FROM t"; // gone', "rs");
  assert.ok(out.includes("https://example.com") && !out.includes("gone"));
});
test("rust: raw string with // inside", () => {
  const out = stripComments('let r = r#"a // b "quoted""#; // gone', "rs");
  assert.ok(out.includes('a // b "quoted"') && !out.includes("gone"));
});

// ── FORBIDDEN patterns ───────────────────────────────────────────────────────
test("removed features match code, not comments", () => {
  assert.deepEqual(hits('invoke("search_youtube", {})'), ["Core YouTube search"]);
  assert.deepEqual(hits("// search_youtube was removed"), []);
  assert.deepEqual(hits("/* onTrackLiked */ ok"), []);
  assert.deepEqual(hits("api.playback.onTrackLiked(h)"), ["Old like event"]);
  assert.deepEqual(hits("return <audio src={x} />"), ["Webview playback engine"]);
  assert.deepEqual(hits("return <AudioFullscreen />"), []);
  assert.deepEqual(hits("plugins.api.p2p.connect()"), ["P2P engine"]);
  assert.deepEqual(hits("const [menuOpen, setMenuOpen] = useState(false)"), ["JS dropdown menu (native menus only)"]);
  assert.deepEqual(hits("fn x<'a>() {} // roadie", "rs"), []);
});
test("scrobble threshold copies are caught, unrelated 240s are not", () => {
  assert.equal(hits("const t = Math.min(durationSecs * 0.5, 240);").length, 1);
  assert.equal(hits("if (pos >= duration * .5) scrobble()").length, 1);
  assert.deepEqual(hits("const SLIDE_MS = 240;"), []);
});

// ── modal overlay ────────────────────────────────────────────────────────────
test("overlay dismiss handler found in any attribute order", () => {
  assert.equal(overlayDismissHits('<div className="ds-modal-overlay" onClick={close}>').length, 1);
  assert.equal(overlayDismissHits('<div onClick={close} className="ds-modal-overlay">').length, 1);
  assert.equal(overlayDismissHits('<div className={cx("ds-modal-overlay", a)} onMouseDown={() => close()}>').length, 1);
  assert.equal(overlayDismissHits('<div className="ds-modal-overlay foo">\n<button onClick={close}>x</button>').length, 0);
});

// ── command registration ─────────────────────────────────────────────────────
const LIB = `
macro_rules! invoke_handler {
    ($($extra:path),* $(,)?) => {
        tauri::generate_handler![
            commands::get_tracks,
            commands::library::delete_tracks,
            $($extra,)*
        ]
    };
}
fn h() { invoke_handler![commands::clear_database] }
fn g() { invoke_handler![] }
fn startup() { commands::run_resync(&app); }
`;
test("registration reads both macros, skips metavariables", () => {
  assert.deepEqual(registeredCommands(LIB), ["clear_database", "delete_tracks", "get_tracks"]);
});
test("handler lists don't count as Rust uses", () => {
  const files = new Map([["lib.rs", withoutHandlerLists(LIB)]]);
  assert.equal(rustCommandRefs(files, "x.rs", "get_tracks"), 0);
  assert.equal(rustCommandRefs(files, "x.rs", "run_resync"), 1);
});
test("command def found past other attributes; same-named Database method ignored", () => {
  const cmdFile = "#[cfg(debug_assertions)]\n#[tauri::command]\npub async fn record_play(state: State) { state.db.record_play(1); }";
  const dbFile = "impl Database {\n  pub fn record_play(&self, id: i64) {}\n}\nfn other(db: &Database) { db.record_play(2); Database::record_play(db, 3); }";
  assert.ok(commandDefIndex(cmdFile, "record_play") > 0);
  assert.equal(commandDefIndex(dbFile, "record_play"), -1);
  const files = new Map([["commands/history.rs", cmdFile], ["db/history.rs", dbFile]]);
  assert.equal(rustCommandRefs(files, "commands/history.rs", "record_play"), 0);
  const withCall = new Map([...files, ["commands/history.rs", cmdFile + "\nfn helper() { record_play(s); }"]]);
  assert.equal(rustCommandRefs(withCall, "commands/history.rs", "record_play"), 1);
});

console.log(process.exitCode ? `selftest: failures above (${passed} passed)` : `selftest: all ${passed} passed`);
