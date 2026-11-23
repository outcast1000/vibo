#!/usr/bin/env node
// Pass 1 + "Do Not Reintroduce": flags a canonical command / event called from
// outside the file(s) that own it, and code shapes of removed features coming
// back. Comments are stripped first, so a comment *describing* a removed
// feature never counts.
//
// The tables below mirror .claude/rules/conventions.md ("Canonical Actions")
// and CLAUDE.md ("Do Not Reintroduce"). When either file changes, update the
// table in the same change — a stale table is how this check goes quiet.
//
// Usage: node canonical-actions.mjs [--json]
import { walk, read, code, lineOf, escapeRe, isTest, heading, isMain } from "./lib.mjs";

/** command → files allowed to `invoke` it (repo-relative). */
export const CANONICAL_COMMANDS = [
  { action: "Delete Tracks", commands: ["delete_tracks", "trash_queue_files"], allow: ["src/hooks/useContextMenuActions.ts"], route: "useContextMenuActions → performDelete()" },
  { action: "Like/Unlike", commands: ["set_entity_like_state"], allow: ["src/hooks/useLikeActions.ts"], route: "useLikeActions → setTrackRating / writeEntityLike (fires like:changed)" },
  { action: "Like import (batch)", commands: ["plugin_set_track_likes_batch"], allow: ["src/hooks/usePlugins.ts"], route: "api.library.setTrackLikesBatch" },
  { action: "Record Play", commands: ["record_play"], allow: ["src/App.tsx"], route: "App.tsx handleScrobble" },
  { action: "Tag Operations", commands: ["plugin_apply_tags_bulk", "remove_tag_from_tracks", "bulk_update_tracks"], allow: ["src/utils/tagOps.ts"], route: "utils/tagOps.ts (addTags / removeTags / editTrackTags / writeFileMetadata)" },
  { action: "Tag refresh", commands: ["refresh_tag_counts"], allow: ["src/utils/tagOps.ts", "src/App.tsx"], route: "TagOpsDeps coalesced refresh" },
  { action: "Start Radio", commands: ["build_radio_station", "build_radio_from_hints"], allow: ["src/hooks/usePlayActions.ts"], route: "usePlayActions → startRadio(seed)" },
  { action: "Open Containing Folder", commands: ["show_in_folder"], allow: ["src/hooks/useContextMenuActions.ts"], route: "useContextMenuActions → handleShowInFolder()" },
  // A path that isn't a track (a Settings folder, a file a download just wrote, a plugin's revealPath) may call it directly — conventions.md.
  { action: "Open Containing Folder (path)", commands: ["show_in_folder_path"], allow: ["src/hooks/useContextMenuActions.ts", "src/components/SettingsPanel.tsx", "src/components/download/SingleTrackDownload.tsx", "src/components/download/MultiTrackDownload.tsx", "src/hooks/usePlugins.ts"], route: "useContextMenuActions → handleShowInFolder() for a track's file" },
  { action: "Edit Track Info (playlist)", commands: ["update_playlist_track_metadata"], allow: ["src/components/PlaylistsView.tsx"], route: "PlaylistsView + EditTrackMetadataModal" },
  { action: "Download upgrade", commands: ["download_preview", "confirm_track_upgrade"], allow: ["src/components/download/SingleTrackDownload.tsx"], route: "SingleTrackDownload (local-only upgrade)" },
  { action: "Report a Problem", commands: ["collect_diagnostics"], allow: ["src/utils/diagnosticReport.ts", "src/App.tsx", "src/hooks/useControlApi.ts"], route: "collectDiagnosticReport() — App.tsx (probe dump) and useControlApi.ts (home-dir scrub) only read facts; sanctioned in conventions.md" },
  { action: "Lyrics into files", commands: ["save_local_lyrics"], allow: ["src/utils/localLyrics.ts"], route: "utils/localLyrics.ts → saveSongLyrics" },
  { action: "App update", commands: ["app_update_check", "app_update_install"], allow: ["src/hooks/useAppUpdater.ts"], route: "useAppUpdater" },
  { action: "Extension update", commands: ["download_and_install_plugin_update", "download_and_install_skin_update"], allow: ["src/hooks/useExtensions.ts"], route: "useExtensions → updateExtension / updateAll" },
  { action: "Tool install", commands: ["dependency_install"], allow: ["src/hooks/useDependencies.ts"], route: "useDependencies → installDep" },
];

/** Plugin events with exactly one dispatcher. */
export const CANONICAL_EVENTS = [
  { event: "like:changed", allow: ["src/hooks/useLikeActions.ts"], route: "setTrackRating / writeEntityLike only" },
  { event: "track:scrobbled", allow: ["src/App.tsx"], route: "App.tsx handleScrobble (dispatchEventTo)" },
];

/** Removed features: a code-shaped hit (not a comment) is a regression. */
export const FORBIDDEN = [
  { what: "Core YouTube search", re: /search_youtube|watchOnYoutube|youtube\.com\/results/, files: "ts,rs" },
  { what: "P2P engine", re: /\bapi\.p2p\b|["'`]p2p_\w+|\bmod p2p\b/, files: "ts,rs" },
  { what: "Transcode server / stream relay", re: /start_transcode|stop_transcode|needsTranscode|register_stream_relay|\bmod (transcode_server|stream_relay)\b/, files: "ts,rs" },
  { what: "Background download queue", re: /enqueue_download|api\.downloads\.enqueue|["'`]download-(progress|complete|error)["'`]/, files: "ts,rs" },
  { what: "Old like event", re: /onTrackLiked|["'`]track:liked["'`]/, files: "ts" },
  { what: "Webview playback engine", re: /<(audio|video)\b|new Audio\(|createElement\(\s*["'`](audio|video)["'`]|createMediaElementSource|new AudioContext\(/, files: "ts" },
  { what: "playbackEngine store key", re: /["'`]playbackEngine["'`]/, files: "ts", allow: ["src/store.ts"] },
  { what: "Roadie", re: /\broadie\b/i, files: "ts,rs", allow: ["src-tauri/src/roadie_cleanup.rs", "src-tauri/src/lib.rs"] },
  { what: "Retired plugin special-cased", re: /["'`]tidal-browse["'`]/, files: "ts,rs", allow: ["src/utils/retiredPlugins.ts", "src-tauri/src/plugins.rs"] },
  { what: "JS dropdown menu (native menus only)", re: /\[\s*\w*[mM]enuOpen\s*,\s*set\w*[mM]enuOpen\s*\]/, files: "ts" },
  { what: "Scrobble threshold reimplemented (use shouldScrobble)", re: /\w*[dD]uration\w*\s*\*\s*0?\.5\b|\b0?\.5\s*\*\s*\w*[dD]uration|\b240\b[^;\n]*[dD]uration|[dD]uration[^;\n]*\b240\b/, files: "ts", allow: ["src/utils.ts"] },
];

/** JSX opening tags carrying `ds-modal-overlay` and a dismiss handler,
 *  wherever the class and the handler sit in the tag. */
export function overlayDismissHits(text) {
  const hits = [];
  for (const m of text.matchAll(/ds-modal-overlay/g)) {
    const start = text.lastIndexOf("<", m.index);
    if (start < 0 || !/[A-Za-z]/.test(text[start + 1] ?? "")) continue;
    // Walk to the tag's closing `>`, skipping `=>` and anything inside {…}.
    let depth = 0;
    let end = -1;
    for (let i = start + 1; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0 && text[i - 1] !== "=") { end = i; break; }
    }
    if (end < 0 || m.index > end) continue;
    const handler = /\bon(?:Click|MouseDown|MouseUp|PointerDown|PointerUp)\s*=/.exec(text.slice(start, end + 1));
    if (handler) hits.push({ index: start, handler: handler[0].replace(/\s*=$/, "") });
  }
  return hits;
}

const TS = () => walk(["src"], [".ts", ".tsx"]).filter((f) => !isTest(f));
const RS = () => walk(["src-tauri/src"], [".rs"]).filter((f) => !isTest(f));

export function run() {
  const findings = [];
  const ts = TS();

  for (const row of CANONICAL_COMMANDS) {
    for (const cmd of row.commands) {
      const re = new RegExp(`invoke\\s*(?:<[^()]*?>)?\\(\\s*["'\`]${escapeRe(cmd)}["'\`]`, "g");
      for (const f of ts) {
        if (row.allow.includes(f)) continue;
        const text = code(f);
        for (const m of text.matchAll(re)) {
          findings.push({ kind: "canonical", file: f, line: lineOf(text, m.index), what: `${row.action}: invoke("${cmd}")`, fix: `route through ${row.route}` });
        }
      }
    }
  }

  for (const row of CANONICAL_EVENTS) {
    const re = new RegExp(`dispatchEvent(?:To)?\\(\\s*["'\`]${escapeRe(row.event)}["'\`]`, "g");
    for (const f of ts) {
      if (row.allow.includes(f)) continue;
      const text = code(f);
      for (const m of text.matchAll(re)) {
        findings.push({ kind: "canonical", file: f, line: lineOf(text, m.index), what: `dispatches "${row.event}"`, fix: `only ${row.route}` });
      }
    }
  }

  const rs = RS();
  for (const row of FORBIDDEN) {
    const files = [...(row.files.includes("ts") ? ts : []), ...(row.files.includes("rs") ? rs : [])];
    const re = new RegExp(row.re.source, row.re.flags.includes("g") ? row.re.flags : row.re.flags + "g");
    for (const f of files) {
      if (row.allow?.includes(f)) continue;
      const text = code(f);
      for (const m of text.matchAll(re)) {
        findings.push({ kind: "reintroduced", file: f, line: lineOf(text, m.index), what: `${row.what}: \`${m[0]}\``, fix: "removed on purpose — see CLAUDE.md \"Do Not Reintroduce\"" });
      }
    }
  }
  // conventions.md → Modal Dismiss Behavior.
  for (const f of ts) {
    const text = code(f);
    for (const h of overlayDismissHits(text)) {
      findings.push({ kind: "canonical", file: f, line: lineOf(text, h.index), what: `.ds-modal-overlay has ${h.handler}`, fix: "modals close only via their buttons, never on an overlay click" });
    }
  }

  // conventions.md → Enforcement: the fire-and-forget exception is taken with
  // `eslint-disable… no-restricted-syntax -- <reason>`, which makes the
  // justification machine-checked. A disable without `--` skips that.
  for (const f of ts) {
    const lines = read(f).split("\n");
    lines.forEach((l, i) => {
      if (/eslint-disable(?:-next)?-line\s+no-restricted-syntax(?!.*--\s*\S)/.test(l)) {
        findings.push({ kind: "unjustified-disable", file: f, line: i + 1, what: "no-restricted-syntax disabled without `-- <reason>`", fix: "put the reason on the disable comment itself" });
      }
    });
  }
  return findings;
}

if (isMain(import.meta.url)) {
  const findings = run();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    heading(`Canonical actions & removed features — ${findings.length} finding(s)`);
    console.log(`Checked ${CANONICAL_COMMANDS.reduce((n, r) => n + r.commands.length, 0)} commands, ${CANONICAL_EVENTS.length} events, ${FORBIDDEN.length} patterns, modal overlays, lint-disable reasons.`);
    for (const f of findings) console.log(`${f.file}:${f.line} — [${f.kind}] ${f.what} — ${f.fix}`);
  }
}
