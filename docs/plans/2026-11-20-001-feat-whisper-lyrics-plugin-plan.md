# Whisper lyrics plugin — plan (2026-11-20)

Time a song's plain lyrics from its audio with whisper.cpp, so a song with plain
lyrics gets synced ones. A plugin, not a host feature and not an AI-assistant
trigger: the pipeline is deterministic and needs no LLM.

## Owner decisions (2026-11-20)

1. **Binaries come from our own build repo** (`outcast1000/viboplr-whisper-cpp`),
   not Homebrew / ggml-org zips.
2. **Songs with no lyrics are skipped** in v1 — whisper's transcription of singing
   is not saved as lyrics.
3. **No `lyrics:files` at first** — saves are cache-only (`savedTo: "app"`) until
   the plugin has proven itself; added later as a plugin update.

## Facts that shaped it

- whisper.cpp's GitHub "Latest" release (v1.9.5) carries **no assets**; binaries
  ride `bNNNN` pre-releases, Windows + Linux only, no checksums file. macOS gets
  only an xcframework, no CLI. A managed `binaryDependencies` tool installs from
  `releases/latest`, so ggml-org can't be the source → our own build repo.
- `api.storage.files.download` caps at 10 MB and buffers in memory
  (`commands/plugin_files.rs`). Models (~550 MB for `large-v3-turbo-q5_0`) go
  through `api.system.programs.download` (streamed, ≤ 1 GB, sha256-pinned,
  confirmed by the user per download; needs `programs:run`, always asked).
- Hugging Face is blocked behind Zscaler; GitHub isn't → mirror the ggml models
  (MIT) as release assets of the build repo.
- Lyrics can already be read: `api.informationTypes.fetch("lyrics", entity)`
  (`plugins:call`, cache-served when fresh) / `getValue` (`library:read`).
- ffmpeg is Vibo's own allow-listed tool (`exec:ffmpeg`); a plugin-defined
  dependency is exec-able too (`exec:whisper-cli`).
- The plugin only sees `QueueTrack.path`, not a stream's resolved URL → **v1 is
  local `file://` tracks only.**

No host change is needed for v1.

## Repos

### `outcast1000/viboplr-whisper-cpp` (binaries + models)
- CI builds a static `whisper-cli` from a pinned whisper.cpp ref:
  macOS arm64 + x64 with Metal (`GGML_METAL_EMBED_LIBRARY=ON`,
  `BUILD_SHARED_LIBS=OFF`), Windows x64 (CPU/BLAS), optionally Linux x64.
- One release per build, assets per platform + `SHA256SUMS`, so it satisfies
  `managed.checksum: { file: "SHA256SUMS" }`.
- Models as release assets of a separate, long-lived tag (`models-1`), so a
  binary release never moves them: `ggml-large-v3-turbo-q5_0.bin`,
  `ggml-small-q5_1.bin`. Plugin pins their sha256.

### `outcast1000/viboplr-whisper` (the plugin)
- `runtime: "worker"`, `stability: "experimental"`, signed with the first-party
  key, `updateUrl` in its own manifest, gallery entry as experimental.
- Permissions: `playback:read`, `plugins:call`, `library:read`, `lyrics:write`,
  `exec:ffmpeg`, `exec:whisper-cli`; optional: `programs:run`,
  `network:github.com`, `network:release-assets.githubusercontent.com`
  (asked when the first model is fetched). Each with a `permissionReasons` line.
- `binaryDependencies`: `whisper-cli`, required, managed from
  `viboplr-whisper-cpp`, `checksum: { file: "SHA256SUMS" }`.
- `eventHooks: ["track:started"]`.

## Pipeline (one job per song)

1. **Trigger** — `onTrackStarted`, after ~5s. Skip: video, < 60s, not `file://`,
   already done / failed / low-confidence for this song (plugin storage, keyed by
   folded title + artist), auto mode off.
2. **Check** — `informationTypes.fetch("lyrics", entity)` (with `durationSecs`).
   Synced → stop. None → stop (decision 2). Plain → continue.
3. **Decode** — `ffmpeg -i <file> -ar 16000 -ac 1 -c:a pcm_s16le <store>/tmp/<job>.wav`.
4. **Transcribe** — `whisper-cli -m <model> -f <wav> -ojf -of <store>/tmp/<job>
   --prompt "<first ~200 chars of the plain lyrics>" -l <lang|auto>` with DTW
   token timestamps; `onOutput` → progress, `onStart` → cancel handle.
5. **Align** — pure `align.ts`: fold words (case, accents, punctuation; Greek
   included), global alignment (Needleman–Wunsch) of lyric words vs transcribed
   tokens with an edit-distance match score; a line starts at its first matched
   word; unanchored lines interpolated between neighbours; forced monotonic.
   Output: LRC text + anchored-line ratio.
6. **Gate** — save only when ≥ ~70% of non-blank lines were anchored; otherwise
   record `low-confidence` and save nothing.
7. **Save** — re-read the lyrics; if they became synced meanwhile, drop the
   result. Else `api.lyrics.save(track, { text, kind: "synced" })`. Never
   overwrite synced lyrics. Temp files removed.

One job at a time, newest first; a skipped track's job stays queued; queue cap
(e.g. 20). The text sent with `--prompt` and the user's lines are kept verbatim —
only timestamps are added.

## Surfaces

- **Settings panel**: Auto mode (Off — default — / when lyrics are plain),
  model (turbo / small), language (auto / pick), model install button, and the
  latest jobs with their outcome (saved / low confidence + ratio / failed + why).
- **Context menu** "Sync lyrics with Whisper" on `track` + `multi-track`
  (manual; ignores auto mode, still skips synced / no-lyrics / non-local).
- **Assistant tool** `sync_lyrics` (→ `whisper__sync_lyrics`); update the MCP
  `synced-lyrics` guide to prefer it over the uv/openai-whisper recipe.
- **Feedback**: view header status / sidebar badge while a job runs; a toast only
  when a save lands or a manual request fails. Missing model / binary → a
  button that runs `require-dependency` / the model download, never on activation.

## Order of work

1. Build repo + CI; measure a 4-minute song on M-series Metal and Windows CPU.
2. `align.ts` + tests (ground truth: the "Άκου μάνα (Lab version)" run).
3. Plugin: manual menu item → auto mode → settings panel → assistant tool.
4. Live test via the dev plugin folder (dev-3 profile).
5. Release both repos, gallery entry.

## Later

- `lyrics:files` (decision 3, once proven).
- Streams: needs the resolved source URL from the host (new API).
- Vocal separation before transcription if busy mixes align badly.
- Transcribing songs with no lyrics (decision 2 — revisit only on request).
