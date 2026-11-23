---
name: code-health
description: Use when the user wants to audit the frontend (React/TS) and backend (Rust) for performance issues, convention violations, code reuse opportunities, duplication, and dead code. Triggers on "code health", "code review", "audit code", "find dead code", "find duplication", "perf review", "check conventions", "optimize", or "/code-health". Reports findings only — does NOT apply fixes unless explicitly asked in a follow-up.
---

# Code Health Review

On-demand audit of frontend and backend code for convention compliance, performance issues, code reuse / duplication, and dead code. **Reports findings only.** It produces a prioritized list of issues with file:line references and concrete suggestions, and the user decides what to fix.

The audit has two halves:

1. **Mechanical (scripts):** canonical-action call sites, removed features coming back, dead Tauri commands, dead exports, lint and cargo. Scripted so it is fast, repeatable, and does not depend on getting a grep right in the moment.
2. **Judgment (you):** reading code for duplication, performance and design smells that no regex finds. This is where the time goes.

It complements `css-review` (skin compliance) and `architect` (feature design). It does not replace them.

## Scope

- **Frontend:** `src/**/*.{ts,tsx}`: components, hooks, utilities
- **Backend:** `src-tauri/src/**/*.rs`: `commands/`, `db/`, `mpv_engine/`, background tasks
- **Plugins:** `src-tauri/plugins/**`, only when relevant to a finding

## Step 0: Run the scripts

```bash
node .claude/skills/code-health/scripts/scan.mjs --tools   # ~35s: scripts + npm run lint + cargo check
node .claude/skills/code-health/scripts/scan.mjs           # ~1s: scripts only
```

Each script also runs on its own (`--json` for machine output):

| Script | Finds | Statuses |
|---|---|---|
| `canonical-actions.mjs` | `invoke("cmd")` outside the file that owns the action, plugin events dispatched from the wrong place, modal overlays with a dismiss handler, code shapes of removed features ("Do Not Reintroduce") and of a reimplemented scrobble threshold, `eslint-disable … no-restricted-syntax` without `-- reason` | `canonical`, `reintroduced`, `unjustified-disable` |
| `unused-commands.mjs` | Commands registered via `generate_handler!` / `invoke_handler!` that no frontend, plugin, script or test names | `unused`, `rust-only` (drop from the handler), `test-only`; `[debug_assertions]` label |
| `unused-exports.mjs` | `src/` exports nothing uses (values by default; `--types` adds types, `--local` lists exports used only in their own file) | `dead`, `test-only`, `local` |

**The output is evidence, not findings.** Read every hit before reporting it. Known blind spots:
- Comments are stripped and strings kept, so a regex literal containing `//` can hide code.
- Identifier matching means two exports with the same name hide each other. This gives false negatives only.
- `test-only` exports named `…ForTest` / `reset…` are deliberate test seams. Don't report those; report the others.
- `lint` and `cargo` are already gated in CI. Report their **errors** and any **cargo warning**. The lint warning backlog is capped (`--max-warnings`) and documented in `eslint.config.js`, so mention only its count, **unless the header says `FAILED (warning cap exceeded)`**. That breaks `npm run lint` and CI, so it is a high finding: name the rules that grew.

## Mandatory pre-scan reading

Build a model of the canonical patterns before judging anything. **Do not skip this.** Findings without grounding in these files are noise.

1. **`CLAUDE.md` → "Do Not Reintroduce"**: removed features. Anything resembling them is high priority.
2. **`.claude/rules/conventions.md`**: Enforcement (what lint already checks), Canonical Actions, Behavioral Rules
3. **`.claude/rules/frontend.md`**, **`backend.md`**, **`plugins.md`**, **`ui.md`**, **`queue.md`**: read the sections relevant to what you are reviewing
4. The canonical implementations: `src/hooks/useContextMenuActions.ts`, `useLikeActions.ts`, `useQueue.ts`, `usePlayActions.ts`, `useDownloadOrchestration.ts`, `src/utils/tagOps.ts`, `src/utils/queueOps.ts`

## Review dimensions

Run all six passes. Collect findings into one prioritized report at the end.

---

### Pass 1: Canonical action violations

**Scripted:** `canonical-actions.mjs` covers every canonical action that reduces to "only this file may invoke command X / dispatch event Y". Its tables (`CANONICAL_COMMANDS`, `CANONICAL_EVENTS`, `FORBIDDEN`) mirror conventions.md and CLAUDE.md. **If you notice a canonical action in conventions.md that the table lacks, add the row** (see "Maintaining the scripts").

**By hand** (the shapes a grep can't pin down):
- **Play / Enqueue / Play Next:** callers outside the queue UI (plugin bridge, Cmd+K results, control API) must use `utils/queueOps.ts` (`playNow` / `addToQueue` / `playWithBackfill`). Look for `playTracks(` / `enqueueTracks(` in those callers, and for `playTracks` + `insertTracks` used together (a hand-rolled backfill with no staleness guard).
- **Play With Backfill:** a play whose list arrives later must go through `usePlayActions.playWithBackfill`. Watch for a call site that notifies "empty" itself after awaiting it (use `onEmpty`).
- **Menus:** every menu is a native `MenuItemSpec[]` built via `showNativeMenu`. Plugin items come from `plugins.menuItems`, never from raw manifests, and are never re-filtered at the call site. Get lyrics / Get image rows come from `contextMenu/providerMenus.ts`.
- **Universal Track Actions:** every surface that shows tracks must open a right-click menu that includes the plugins' track items. These are the files that pop a menu but never mention plugin items. Read each one; a menu that isn't about tracks is fine:
  `rg -l 'showNativeMenu' src/components | xargs rg --files-without-match 'menuItems|buildContextMenuSpecs|buildAndShowNativeMenu|onTrackContextMenu'`
  (Not `rg -L`, which means "follow symlinks".) Many hits are fine: TrackList and QueuePanel pop a local menu but get their track menu from an `onContextMenu` prop wired in App. Follow the prop. Also check track lists that have no `onContextMenu` at all.
- **Scrobble threshold:** the script flags copies of `shouldScrobble`'s maths (`duration * 0.5`, `240`). Also look for a second "has this play counted yet" check outside `usePlayback.crossScrobbleThreshold`.
- **Download:** the host offers a download only from the now-playing button via `decideDownload`. Flag any new host "Download…" menu entry, `decideMetadataDownload`, or per-provider "Download from X".
- **Edit Track Info / Tags:** new metadata editors must reuse `EditTrackMetadataModal`, and new tag editors must reuse `TagEditor`.
- **Track matching:** JS-side title/artist comparisons for library lookups instead of `find_track_by_metadata`.
- **Startup:** writes to the `view` / `selected*` store keys for restore-on-start.

**Report format:** `file:line — <action> reimplemented; route through <canonical hook/function>`

---

### Pass 2: Behavioral rule violations

**Already enforced by lint, so don't re-grep:** empty `catch {}` / `.catch(() => {})` without a disable comment, bare `console.log`, `any`, ref writes in render, rules of hooks. The script covers disable comments with no `-- reason`.

**By hand:**
- **Swallowed errors that lint allows:** `} catch {` (no binding) is legal syntax and lint doesn't flag it. Most hits are parse fallbacks (`JSON.parse`, `new URL`), which are fine. Flag only the ones wrapping real I/O (`invoke`, fs, network) with no `console.error`:
  `rg -n -A3 '\} catch \{' src --glob '!**/__tests__/**'`
  On the Rust side, `let _ = <fallible db/fs call>` in a background thread is the same smell.
- **User feedback:** failures shown only via `console.error` on a user-initiated action, and new `notify(...)` calls for failures/warnings/successes that don't pass `{ kind }`.
- **Success toasts** where conventions say the result itself is the feedback (delete, updates, tag quick-edit).
- **Modals:** dismiss only via buttons. The script catches a dismiss handler on any tag that names `ds-modal-overlay`. Also check overlays built another way: a class from a variable, a wrapper component, or an Escape handler on a modal that has a Cancel button.
- **Plugin-first:** new information-section-like content or external fetching hard-coded in `src/components/` instead of a plugin.
- **Skin compatibility:** delegate to `/css-review`; don't duplicate.

**Report format:** `file:line — <rule> — <what's wrong>`

---

### Pass 3: Code reuse opportunities

Find duplicated logic that should live in one shared helper. Report 3+ copies as medium.

**Frontend:**
- **Duration / clock formatting** (`m:ss`) reimplemented next to `utils.ts` → `formatDuration`:
  `rg -n 'Math\.floor\(\w+ / 60\)' src --glob '!**/__tests__/**'`
- **Entity keys** built by hand (`` `album:${…}:${…}` ``) instead of `types/informationTypes.ts` → `buildEntityKey`, or `likeKeys.ts` for like keys.
- **Local-track checks** (`track.path.startsWith("file://")`) instead of `queueEntry.ts` → `isLocalTrack`.
- **Repeated `invoke` shapes** across 3+ files, a candidate for a shared util or hook.
- **Repeated relative-time / byte-size / plural formatting**: check `utils.ts` first.

**Backend:**
- **HTTP clients:** `reqwest::…Client::builder()` / `Client::new()` / `reqwest::blocking::get` sprinkled across modules with differing timeouts and user agents. Point at the existing shared builder (`image_provider::http_client`).
  `rg -n 'reqwest::(blocking::)?(Client::(new|builder)\(\)|get\()' src-tauri/src`
- **SQL fragments** copy-pasted across `db/*.rs` (the same WHERE/JOIN for "visible tracks", the same accent-folded match).
- **Filename / tag parsing** that duplicates `scanner.rs`.

**Report format:** `<pattern> — seen at file1:line, file2:line, file3:line — consolidate into <suggested location>`

---

### Pass 4: Performance issues

**Frontend:**
- **Long lists:** `TrackList` and `QueuePanel` rows use `content-visibility: auto` (see their CSS) rather than windowing. That is the chosen approach, so don't flag it. Flag *new* unbounded lists that use neither.
- **Rows** inside long lists without `React.memo`, or memoized rows receiving inline object/function props.
- **`invoke(` in a render body** (outside an effect or handler): a fetch on every render.
- **State-then-effect hops** where a direct call from the handler would do (project preference).
- **Search inputs** firing `invoke` per keystroke without a debounce.
- **`Math.random()` / `Date.now()` inside `useMemo`**: re-deals on every recompute (the `react-hooks/purity` lesson).

**Backend** (read code; these are the files to sample first):
- **Per-request client construction:** a new HTTP client per call in loops (e.g. a sync fetching per album) means a new TLS handshake each time. Start with `subsonic.rs`, `sync.rs`, `image_provider/`, `downloader.rs`.
- **N+1 queries:** loops in `commands/*.rs` / `db/*.rs` calling a per-row `get_*_by_id` / `query_row`.
- **Locks held across I/O:** a DB guard alive while doing HTTP or a long fs walk. Search `commands/` for a guard followed by `.send()` in the same scope.
- **Long background work** without a cancellation `AtomicBool` (backend.md requires one), and `app.emit` inside tight loops without throttling.
- **Missing indexes:** new WHERE clauses on large tables (`tracks`, `history`) against the schema in `db/`. Use `/db-bench` to measure.

**Report format:** `file:line — <issue> — <suggested fix>`

---

### Pass 5: Dead code

**Scripted:** `unused-commands.mjs`, `unused-exports.mjs`, and the cargo warnings from `scan.mjs --tools`.

**By hand:**
- **Unused `pub fn` in `db/*.rs`:** cargo doesn't warn on `pub` items. Spot-check functions added recently (`git log -p --since=…`), grepping the crate for each name.
- **Unused fields in `models.rs` structs** that are serialized but never read on the TS side.
- **Dead branches:** `if (false)`, code after an unconditional return, commented-out blocks longer than 3 lines.
- **Retired store keys** still read outside `RETIRED_STORE_KEYS` / restore migration.
- **Plugins:** flag only a plugin dir with no manifest or a broken one. Plugins are user-installable, so "unused" doesn't apply.

**Report format:** `file:line — <symbol> — no external references found`

---

### Pass 6: Misc smells

- **TODO / FIXME / HACK / XXX:** `rg -n '\b(TODO|FIXME|HACK|XXX)\b' src src-tauri/src`. Low priority unless the comment marks a bug.
- **Magic numbers** that duplicate a documented constant (scrobble threshold, rate limits, timeouts).
- **File size:**
  `find src/components -name '*.tsx' | xargs wc -l | sort -rn | head` (flag >500 lines)
  `find src-tauri/src -name '*.rs' ! -name tests.rs | xargs wc -l | sort -rn | head` (flag >800 lines)
  Report the top few, plus counts. Don't list every file.
- **Test placement:** frontend tests belong in `src/__tests__/`, Rust tests in `#[cfg(test)] mod tests` (see testing.md).
- `console.debug` tracing that runs on every hot-path event (every resolve, every tick).

---

## Report format

```
Code Health Report
══════════════════
Files scanned: N frontend + N backend + N plugin
Findings: N total (H high / M medium / L low)

─── Clean (checked, nothing found) ───
- one line per check that passed: canonical commands (N checked), removed features,
  Tauri commands (N/N have a caller), lint errors, cargo warnings, …

─── High Priority ───
1. [Canonical Action] file:line — <issue> — <fix>
...

─── Medium Priority ───
...

─── Low Priority ───
...

─── Summary by Dimension ───
Canonical Actions:   N
Behavioral Rules:    N
Code Reuse:          N
Performance:         N
Dead Code:           N
Misc:                N
```

The **Clean** section matters: "nothing found" is only useful if it says what was checked.

**Priority rubric:**
- **High:** anything matching "Do Not Reintroduce"; canonical action violations that skip a side effect (a like that doesn't fire `like:changed`, a delete that skips the confirmation gate); silently swallowed errors on user-initiated actions; main-thread stalls (render-time invokes, a lock held across network I/O).
- **Medium:** canonical-route bypasses with no lost side effect; 3+ duplicates; per-request client construction in loops; dead exports or commands in public-facing modules; missing memoization with measurable render cost.
- **Low:** TODOs, magic numbers, file size, single duplications, test-only exports, comment/behaviour mismatches.

It is fine to report zero high findings. Don't promote a finding to fill the section.

## After the report

Ask the user how to proceed:
- **Fix highest priority:** apply the top N findings
- **Fix by dimension:** pick a pass (e.g. "fix all dead code")
- **Fix by file:** walk through one file at a time
- **Report only:** keep it as a reference, no edits

Do NOT start editing until the user picks an option.

## Maintaining the scripts

- **The tables in `canonical-actions.mjs` are a copy of conventions.md and CLAUDE.md.** When a canonical action, a single-dispatcher event, or a "Do Not Reintroduce" entry is added or changed, update the table in the same change. A missing row is a check that silently never runs.
- An `allow` entry is a decision, not a workaround. Add a file to `allow` only when conventions.md sanctions that caller, and say why in the `route` text (see `collect_diagnostics`).
- After editing a script, run `node .claude/skills/code-health/scripts/selftest.mjs`. It pins the parsing the checks depend on: comment stripping (including Rust lifetimes and raw strings), the removed-feature patterns, the overlay walker, and handler-list parsing. When you add a pattern, add a fixture that must match and one that must not. Then run `scan.mjs` and check the known-good state stays quiet (no `reintroduced` hits on main).
- Scripts are plain Node with no dependencies (`lib.mjs` has the walker and comment stripper). Keep it that way. The project minimizes dependencies.

## What this skill does NOT do

- **Skin / CSS compliance:** use `/css-review`.
- **New feature design:** use `/architect`.
- **Release / version bumps:** use `/release`.
- **Running benchmarks:** use `/db-bench` (DB) or `npm run perf:probe` (host resources).
- **Interactive refactors or autofixing:** report first, edit only when asked.

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Skipping the pre-scan reading | Findings without grounding are low-signal noise. Read the rule files first. |
| Reporting script output verbatim | Read each hit. The scripts find candidates; you decide what is a finding. |
| Re-grepping what lint enforces | Run lint (`scan.mjs --tools`) and report its errors. Don't hand-scan for empty catches or `console.log`. |
| Flagging documented exceptions | conventions.md documents some: fire-and-forget catches with a reason, the two fact-only `collect_diagnostics` readers (Report a Problem), non-track `show_in_folder_path` callers (Open Containing Folder), and the bulk like import. Re-read before flagging. |
| Flagging `local` exports or `…ForTest` seams as dead | Harmless. Report only `dead` and genuine `test-only` production helpers. |
| Flagging list virtualization on TrackList / QueuePanel | They use `content-visibility: auto` on purpose. |
| Listing every TODO as high priority | TODOs are low unless the comment marks a bug. |
| Treating `rust-only` commands as dead functions | The fn is used. Only its `generate_handler!` entry is unnecessary. |
| Debug-only commands reported as dead | Check `#[cfg(debug_assertions)]` (the script labels it). |
| Editing during the scan | Never. Report first, edit only after the user approves. |
