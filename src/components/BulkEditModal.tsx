import { useState, useMemo, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track } from "../types";
import type { InfoEntity, LyricsData } from "../types/informationTypes";
import AutocompleteInput from "./AutocompleteInput";
import TagEditor from "./TagEditor";
import { LyricsEditor, type LyricsEditorTransport } from "./renderers/LyricsEditor";
import {
  addToAll, EMPTY_TAG_SELECTION, hasTagChanges, removeFromAll, selectionFromCounts, tagDelta,
  type TagSelection,
} from "../utils/bulkEditTags";
import { useCommunityTagsForTracks, type InvokeInfoFetch } from "../hooks/useCommunityTags";
import { appendCommunityTags } from "../utils/tagSuggestions";
import { writeFileMetadata, type FileMetadataEdit } from "../utils/tagOps";
import { useTagOpsDeps } from "../contexts/TagOpsContext";
import { CORE_LOCAL_LYRICS_PROVIDER, describeInfoFailures, fetchInfoValue } from "../utils/infoFetchChain";
import { saveSongLyrics } from "../utils/localLyrics";
import { detectLyricsKind } from "../utils/lyricsEditor";
import { isLocalTrack } from "../queueEntry";
import { formatDuration, formatDateTime, formatFileSize } from "../utils";
import { fileNameOf, formatAudioSummary, prettifyTagKey, type AudioProperties } from "../utils/trackFileInfo";
import "./BulkEditModal.css";

/** Summary of the album-identity fields an edit changed, so callers can re-point
 *  an album detail page to where the edited tracks now live. */
export interface BulkEditResult {
  /** Album title was edited (`newAlbum` holds the value, null = cleared). */
  albumChanged: boolean;
  /** Artist was edited (`newArtist` holds the value, null = cleared). */
  artistChanged: boolean;
  /** Album artist was edited (`newAlbumArtist` holds the value, null = cleared
   * back to the track-artist fallback). Changes which artist the album files
   * under, so album re-pointing must prefer it over the track artist. */
  albumArtistChanged: boolean;
  newAlbum: string | null;
  newArtist: string | null;
  newAlbumArtist: string | null;
}

interface BulkEditModalProps {
  tracks: Track[];
  artistOptions: string[];
  albumOptions: string[];
  tagOptions: string[];
  /** Fetches Last.fm community tags (suggestions) and the song's lyrics. */
  invokeInfoFetch?: InvokeInfoFetch;
  pluginNames?: Map<string, string>;
  /** Whether plugins finished loading — re-fetches community tags once ready. */
  pluginsLoaded?: boolean;
  /** The one edited track is the one playing — the Lyrics tab's Sync needs it. */
  live?: boolean;
  /** Play this track from `secs`: a seek while `live`, otherwise it starts
   *  the track (Sync's "Play this song" and a stamp's replay). */
  seek?: (secs: number) => void;
  /** Play/pause for the Lyrics tab's Sync — the dialog covers the player bar. */
  transport?: LyricsEditorTransport;
  onClose: () => void;
  onSave: (result: BulkEditResult) => void;
  /** Reveal the track's file — useContextMenuActions.showTrackInFolder, the
   *  one Open Containing Folder for a track (its failure dialog included). */
  onShowInFolder?: (track: { libraryId: number; path: string | null }) => void;
}

type Tab = "details" | "tags" | "lyrics" | "file";

/** One editable text field. Changed means *differs from what the tracks
 *  have* — retyping the same value is no edit, and leaves no dot behind.
 *  "Cleared" saves as null. On one track an emptied field is a clear; across
 *  several (`multi`) an empty box means "leave alone" and only the Clear
 *  button clears, so typing and deleting can't wipe a field on every track. */
function useField(initial: string, { multi = false, mixed = false } = {}) {
  const [value, setValue] = useState(initial);
  const [clearRequested, setClearRequested] = useState(false);
  const cleared = clearRequested || (!multi && initial !== "" && value === "");
  const dirty = cleared || (value !== initial && !(multi && value === ""));
  return {
    value,
    dirty,
    cleared,
    /** There is something to clear: a value, or (several tracks) differing ones. */
    canClear: initial !== "" || mixed,
    set: (v: string) => { setValue(v); setClearRequested(false); },
    clear: () => { setValue(""); setClearRequested(true); },
    revert: () => { setValue(initial); setClearRequested(false); },
  };
}
type Field = ReturnType<typeof useField>;

/** What an empty box says: what Save will do with it. */
function fieldPlaceholder(field: Field, initial: string, mixedPlaceholder: string | undefined, clearedText = "Will be cleared") {
  if (field.cleared) return clearedText;
  if (mixedPlaceholder) return mixedPlaceholder;
  return initial !== "" ? `Unchanged (${initial})` : undefined;
}

function FieldRow({ label, field, clearable, hint, children }: {
  label: string;
  field: Field;
  clearable?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="modal-field">
      {/* Not a <label>: it holds interactive buttons and has no associated input.
          In WKWebView a button nested in a <label> can have its click swallowed. */}
      <div className="bulk-edit-field-label">
        <span>{label}{field.dirty && <DirtyDot />}</span>
        <span className="bulk-edit-field-actions">
          {clearable && field.cleared && <span className="bulk-edit-cleared-tag">Will be cleared</span>}
          {clearable && field.canClear && !field.cleared && (
            <button type="button" className="bulk-edit-clear" onClick={field.clear} title="Clear this field (set to empty)" aria-label={`Clear ${label}`}>Clear</button>
          )}
          {field.dirty && (
            <button type="button" className="bulk-edit-revert" onClick={field.revert} title="Revert this field" aria-label={`Revert ${label}`}>↺</button>
          )}
        </span>
      </div>
      {children}
      {hint && <p className="bulk-edit-hint">{hint}</p>}
    </div>
  );
}

/** The "has unsaved changes" dot, with words for screen readers. */
function DirtyDot() {
  return (
    <span className="bulk-edit-dirty-dot">
      <span className="bulk-edit-sr">(modified)</span>
    </span>
  );
}

const IS_MAC = typeof navigator !== "undefined" && navigator.platform.includes("Mac");
const SAVE_SHORTCUT = IS_MAC ? "⌘S" : "Ctrl+S";

/** After this long the lyrics wait says how long it has been. */
const LYRICS_SLOW_MS = 3000;

const NUMBER_INPUT_PROPS = { type: "number", autoComplete: "off", autoCorrect: "off", spellCheck: false, style: { width: 120 } } as const;

function toInt(value: string): number | null {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/** The value every track shares, or "" with a "Multiple values" placeholder. */
function sharedValue(tracks: Track[], pick: (t: Track) => string | number | null | undefined) {
  const values = new Set(tracks.map((t) => pick(t) ?? ""));
  const [only] = values;
  return values.size === 1
    ? { value: String(only), placeholder: undefined }
    : { value: "", placeholder: "Multiple values" };
}

export default function BulkEditModal({
  tracks, artistOptions, albumOptions, tagOptions, invokeInfoFetch, pluginNames, pluginsLoaded,
  live = false, seek, transport, onClose, onSave, onShowInFolder,
}: BulkEditModalProps) {
  const count = tracks.length;
  const single = count === 1 ? tracks[0] : null;
  const tagOpsDeps = useTagOpsDeps();
  const [tab, setTab] = useState<Tab>("details");

  // --- Details ---
  const shared = useMemo(() => ({
    artist: sharedValue(tracks, (t) => t.artist_name),
    albumArtist: sharedValue(tracks, (t) => t.album_artist_name),
    album: sharedValue(tracks, (t) => t.album_title),
    year: sharedValue(tracks, (t) => t.year),
  }), [tracks]);
  const multi = count > 1;
  const title = useField(single?.title ?? "");
  const trackNumber = useField(single?.track_number != null ? String(single.track_number) : "");
  const artist = useField(shared.artist.value, { multi, mixed: !!shared.artist.placeholder });
  const albumArtist = useField(shared.albumArtist.value, { multi, mixed: !!shared.albumArtist.placeholder });
  const album = useField(shared.album.value, { multi, mixed: !!shared.album.placeholder });
  const year = useField(shared.year.value, { multi, mixed: !!shared.year.placeholder });
  // Several tracks: say how many albums they span, so the reach of a save is visible.
  const albumCount = useMemo(
    () => new Set(tracks.map((t) => `${t.album_title ?? ""}\u0001${t.album_artist_name ?? t.artist_name ?? ""}`)).size,
    [tracks],
  );
  const fields = [title, trackNumber, artist, albumArtist, album, year];
  const detailsDirty = fields.some((f) => f.dirty);
  const titleInvalid = title.dirty && title.value.trim() === "";

  // --- Tags: tags on every track vs on some; one batched read ---
  const [tagsOriginal, setTagsOriginal] = useState<TagSelection | null>(null);
  const [tagSel, setTagSel] = useState<TagSelection>(EMPTY_TAG_SELECTION);
  useEffect(() => {
    let cancelled = false;
    const ids = tracks.map((t) => t.id).filter((id): id is number => id != null);
    invoke<Array<[number, string, number]>>("get_tag_counts_for_tracks", { trackIds: ids })
      .then((rows) => {
        if (cancelled) return;
        const sel = selectionFromCounts(rows, ids.length);
        setTagsOriginal(sel);
        setTagSel(sel);
      })
      .catch((e) => {
        console.error("Failed to load the tracks' tags:", e);
        if (!cancelled) { setTagsOriginal(EMPTY_TAG_SELECTION); setTagSel(EMPTY_TAG_SELECTION); }
      });
    return () => { cancelled = true; };
  }, [tracks]);
  const tagsDirty = tagsOriginal != null && hasTagChanges(tagsOriginal, tagSel);
  const partialChips = useMemo(
    () => tagSel.partial.map((p) => ({ name: p.name, count: p.count, total: p.total })),
    [tagSel.partial],
  );

  const { tags: communityTags, loading: communityLoading } = useCommunityTagsForTracks({ tracks, invokeInfoFetch, pluginsLoaded });
  const tagSuggestions = useMemo(() => appendCommunityTags(tagOptions, communityTags), [tagOptions, communityTags]);
  const communityPills = useMemo(() => communityTags.map((t) => t.name), [communityTags]);

  // --- Lyrics (one track): loaded the first time the tab opens ---
  const lyricsEntity = useMemo<InfoEntity | null>(() => single && single.id != null ? {
    kind: "track", name: single.title, id: single.id,
    artistName: single.artist_name ?? undefined, albumTitle: single.album_title ?? undefined,
    path: single.path ?? undefined, durationSecs: single.duration_secs ?? undefined,
  } : null, [single]);
  const [lyricsInitial, setLyricsInitial] = useState<string | null>(null);
  const [lyricsFromFile, setLyricsFromFile] = useState(false);
  const [lyricsText, setLyricsText] = useState("");
  // Reading the current lyrics failed: no editor, since an empty one would
  // look like "this song has none" and saving it would replace what the file
  // holds.
  const [lyricsLoadError, setLyricsLoadError] = useState<string | null>(null);
  const [lyricsRequested, setLyricsRequested] = useState(false);
  // Some web source couldn't be asked while the editor still opened.
  const [lyricsLoadWarning, setLyricsLoadWarning] = useState<string | null>(null);
  const lyricsDirty = lyricsInitial != null && lyricsText.trim() !== "" && lyricsText !== lyricsInitial;
  // Emptying the editor saves nothing (there is no "remove lyrics" write) —
  // said, so a disabled Save isn't a mystery.
  const lyricsEmptied = lyricsInitial != null && lyricsInitial.trim() !== "" && lyricsText.trim() === "";

  async function loadLyrics(entity: InfoEntity) {
    setLyricsLoadError(null);
    setLyricsLoadWarning(null);
    if (!invokeInfoFetch) {
      setLyricsLoadError("The lyrics providers aren't loaded yet.");
      return;
    }
    try {
      const out = await fetchInfoValue({ typeId: "lyrics", entity, invokeInfoFetch, pluginNames });
      const failures = out.failures ?? [];
      const filesFailed = failures.find((f) => f.providerId === CORE_LOCAL_LYRICS_PROVIDER);
      // No editor when the song's own files couldn't be read — whatever a
      // later source said, they may hold lyrics an empty editor's save would
      // replace — or when the walk failed without saying who. A web source
      // failing beside readable files is a warning.
      if (filesFailed || (out.status === "error" && failures.length === 0)) {
        setLyricsLoadError(filesFailed
          ? `reading the song's files failed${filesFailed.message ? ` (${filesFailed.message})` : ""}.`
          : "the lyrics lookup failed.");
        return;
      }
      const failed = describeInfoFailures(failures);
      setLyricsLoadWarning(!failed ? null
        : out.status === "ok" && out.answeredBy ? `${failed}. These are from ${out.answeredBy.name}.`
          : `${failed}. No other source had lyrics for this song.`);
      const data = out.status === "ok" ? out.value as LyricsData | null : null;
      const text = data?.text ?? "";
      setLyricsFromFile(!!data?.local);
      setLyricsText(text);
      setLyricsInitial(text);
    } catch (e) {
      console.error("Failed to load lyrics:", e);
      setLyricsLoadError(e instanceof Error ? e.message : String(e));
    }
  }

  // --- File (one track): loaded the first time the tab opens ---
  const [audioProps, setAudioProps] = useState<AudioProperties | null>(null);
  const [extraTags, setExtraTags] = useState<Record<string, string> | null>(null);
  const fileRequested = useRef(false);

  function loadFileInfo(trackId: number) {
    invoke<AudioProperties>("get_track_audio_properties", { trackId })
      .then(setAudioProps).catch((e) => console.error("Failed to load audio properties:", e));
    invoke<Record<string, string> | null>("get_track_extra_tags", { trackId })
      .then(setExtraTags).catch((e) => console.error("Failed to load extra tags:", e));
  }

  function openTab(next: Tab) {
    setTab(next);
    if (next === "lyrics" && lyricsEntity && !lyricsRequested) {
      setLyricsRequested(true);
      void loadLyrics(lyricsEntity);
    }
    if (next === "file" && single?.id != null && !fileRequested.current) {
      fileRequested.current = true;
      loadFileInfo(single.id);
    }
  }

  // --- Save ---
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [lyricsError, setLyricsError] = useState<string | null>(null);
  // Details and tags already written — the lyrics save then failed, or some
  // files failed while the library rows changed: not written again, and
  // handed to the caller even if the user then cancels, so an open page still
  // re-points.
  const [metadataSaved, setMetadataSaved] = useState<BulkEditResult | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const metadataDirty = !metadataSaved && (detailsDirty || tagsDirty);
  const hasChanges = metadataDirty || lyricsDirty;
  const canSave = hasChanges && !saving && !titleInvalid;

  function buildEdit(): FileMetadataEdit {
    const edit: FileMetadataEdit = {};
    if (title.dirty) edit.title = title.value;
    if (trackNumber.dirty) edit.trackNumber = toInt(trackNumber.value);
    if (artist.dirty) edit.artistName = artist.value;
    if (albumArtist.dirty) edit.albumArtistName = albumArtist.value;
    if (album.dirty) edit.albumTitle = album.value;
    if (year.dirty) edit.year = toInt(year.value);
    if (tagsOriginal && tagsDirty) {
      const { add, remove } = tagDelta(tagsOriginal, tagSel);
      if (add.length > 0) edit.tagsAdd = add;
      if (remove.length > 0) edit.tagsRemove = remove;
    }
    return edit;
  }

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setErrors([]);
    setLyricsError(null);
    setConfirmDiscard(false);
    try {
      let result = metadataSaved;
      if (!result) {
        const written: BulkEditResult = {
          albumChanged: album.dirty,
          artistChanged: artist.dirty,
          albumArtistChanged: albumArtist.dirty,
          newAlbum: album.value || null,
          newArtist: artist.value || null,
          newAlbumArtist: albumArtist.value || null,
        };
        if (metadataDirty) {
          const fileErrors = await writeFileMetadata(tagOpsDeps, tracks.flatMap((t) => t.id != null ? [t.id] : []), buildEdit());
          if (fileErrors.length > 0) {
            // The library rows changed even where a file didn't: record it as
            // written, so Close still re-points the page and a retry doesn't
            // write everything again.
            setMetadataSaved(written);
            setErrors(fileErrors);
            return;
          }
        }
        result = written;
      }
      if (lyricsDirty && lyricsEntity) {
        // Under the names the track has now, so the lyrics cache matches the
        // page the edited track opens on.
        const entity: InfoEntity = {
          ...lyricsEntity,
          name: title.dirty ? title.value : lyricsEntity.name,
          artistName: artist.dirty ? artist.value || undefined : lyricsEntity.artistName,
          albumTitle: album.dirty ? album.value || undefined : lyricsEntity.albumTitle,
        };
        try {
          await saveSongLyrics(entity, lyricsText.replace(/\s+$/, ""), detectLyricsKind(lyricsText), "edit");
        } catch (e) {
          console.error("Failed to save lyrics:", e);
          setMetadataSaved(result);
          setLyricsError(e instanceof Error ? e.message : String(e));
          setTab("lyrics");
          return;
        }
      }
      onSave(result);
    } catch (e) {
      console.error("Failed to edit tracks:", e);
      setErrors([e instanceof Error ? e.message : String(e)]);
    } finally {
      setSaving(false);
    }
  }

  // What was already written must still reach the caller (re-point the open
  // album page, close the dialog) if the user gives up on the lyrics.
  const close = () => (metadataSaved ? onSave(metadataSaved) : onClose());
  // Unsaved work is asked about first — Escape included, which the embedded
  // lyrics editor leaves to the dialog.
  const requestClose = () => {
    if (hasChanges && !confirmDiscard) { setConfirmDiscard(true); return; }
    close();
  };

  const tabs: { id: Tab; label: string; dirty: boolean }[] = [
    { id: "details", label: "Details", dirty: detailsDirty },
    { id: "tags", label: "Tags", dirty: tagsDirty },
    ...(single ? [
      { id: "lyrics" as const, label: "Lyrics", dirty: lyricsDirty },
      { id: "file" as const, label: "File", dirty: false },
    ] : []),
  ];

  const fileName = fileNameOf(single?.path);

  // Tabs: arrow keys move between them (and open the one they land on).
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());
  function onTabKeyDown(e: React.KeyboardEvent, index: number) {
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next == null) return;
    e.preventDefault();
    const id = tabs[next].id;
    openTab(id);
    tabRefs.current.get(id)?.focus();
  }

  return (
    <div className="ds-modal-overlay">
      <div
        className="ds-modal bulk-edit-modal"
        role="dialog"
        aria-label={single ? `Edit properties of “${single.title}”` : `Edit properties of ${count} tracks`}
        onKeyDown={(e) => {
          // Never let Escape reach the page behind (it would close a track page).
          if (e.key === "Escape") e.stopPropagation();
          if (e.defaultPrevented) return; // AutocompleteInput / the Sync list consume their own keys
          if ((e.metaKey || e.ctrlKey) && (e.key === "Enter" || e.key.toLowerCase() === "s")) {
            e.preventDefault();
            e.stopPropagation();
            void handleSave();
          } else if (e.key === "Escape") {
            e.preventDefault();
            if (confirmDiscard) setConfirmDiscard(false);
            else requestClose();
          }
        }}
      >
        <div className="bulk-edit-head">
          {/* Named like the menu item that opens it ("Edit Properties") — the
              queue's "Edit info…" is a different dialog that never writes files. */}
          <h3 className="ds-modal-title">Edit Properties</h3>
          {single ? (
            <p className="bulk-edit-subtitle" title={single.path ?? undefined}>
              {[single.title, single.artist_name].filter(Boolean).join(" · ")}
              {fileName && <span className="bulk-edit-filename">{fileName}</span>}
            </p>
          ) : (
            <p className="bulk-edit-subtitle">
              {count} tracks{albumCount > 1 ? ` from ${albumCount} albums` : ""} — saving changes every one of their files.
            </p>
          )}
        </div>

        <div className="ds-tabs bulk-edit-tabs" role="tablist" aria-label="Edit">
          {tabs.map((t, i) => (
            <button
              key={t.id}
              ref={(el) => { if (el) tabRefs.current.set(t.id, el); else tabRefs.current.delete(t.id); }}
              id={`bulk-edit-tab-${t.id}`}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`bulk-edit-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={`ds-tab${tab === t.id ? " active" : ""}`}
              onClick={() => openTab(t.id)}
              onKeyDown={(e) => onTabKeyDown(e, i)}
            >
              {t.label}
              {t.dirty && <DirtyDot />}
            </button>
          ))}
        </div>

        <div className="bulk-edit-body">
          <fieldset className="bulk-edit-fieldset" disabled={!!metadataSaved} hidden={tab !== "details"}
            id="bulk-edit-panel-details" role="tabpanel" aria-labelledby="bulk-edit-tab-details">
            {single && (
              <>
                <FieldRow label="Title" field={title}>
                  <input
                    className="ds-input"
                    aria-label="Title"
                    type="text"
                    autoFocus
                    value={title.value}
                    onChange={(e) => title.set(e.target.value)}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                  {titleInvalid && <p className="bulk-edit-hint bulk-edit-hint--error">A track needs a title.</p>}
                </FieldRow>
                <FieldRow label="Track #" field={trackNumber} clearable>
                  <input
                    {...NUMBER_INPUT_PROPS}
                    className="ds-input"
                    aria-label="Track #"
                    value={trackNumber.value}
                    placeholder={trackNumber.cleared ? "Will be cleared" : undefined}
                    onChange={(e) => trackNumber.set(e.target.value)}
                  />
                </FieldRow>
              </>
            )}
            <FieldRow label="Artist" field={artist} clearable>
              <AutocompleteInput
                value={artist.value}
                onChange={artist.set}
                ariaLabel="Artist"
                suggestions={artistOptions}
                placeholder={fieldPlaceholder(artist, shared.artist.value, shared.artist.placeholder)}
                autoFocus={!single}
              />
            </FieldRow>
            {/* ALBUMARTIST: which artist the album files under. Setting it (e.g.
                "Various Artists") merges per-track-artist forks of a compilation
                into one album; clearing falls back to each track's own artist. */}
            <FieldRow
              label="Album artist"
              field={albumArtist}
              clearable
              hint="Who the album is filed under. Set “Various Artists” to keep a compilation together as one album."
            >
              <AutocompleteInput
                value={albumArtist.value}
                onChange={albumArtist.set}
                ariaLabel="Album artist"
                suggestions={artistOptions}
                placeholder={fieldPlaceholder(albumArtist, shared.albumArtist.value, shared.albumArtist.placeholder, "Will follow each track's artist")}
              />
            </FieldRow>
            <FieldRow label="Album" field={album} clearable>
              <AutocompleteInput
                value={album.value}
                onChange={album.set}
                ariaLabel="Album"
                suggestions={albumOptions}
                placeholder={fieldPlaceholder(album, shared.album.value, shared.album.placeholder)}
              />
            </FieldRow>
            <FieldRow label="Year" field={year} clearable>
              <input
                {...NUMBER_INPUT_PROPS}
                className="ds-input"
                aria-label="Year"
                value={year.value}
                placeholder={fieldPlaceholder(year, shared.year.value, shared.year.placeholder)}
                onChange={(e) => year.set(e.target.value)}
              />
            </FieldRow>
          </fieldset>

          <fieldset className="bulk-edit-fieldset" disabled={!!metadataSaved} hidden={tab !== "tags"}
            id="bulk-edit-panel-tags" role="tabpanel" aria-labelledby="bulk-edit-tab-tags">
            <p className="bulk-edit-hint">
              {single
                ? "Tags are written into the file's genre field as well as the library."
                : `Tags you add or remove change all ${count} tracks. Tags you don't touch stay as they are.`}
            </p>
            <TagEditor
              tags={tagSel.applied}
              partialTags={single ? undefined : partialChips}
              suggestions={tagSuggestions}
              onAdd={(name) => setTagSel((s) => addToAll(s, name, tagsOriginal ?? undefined))}
              onFillToAll={(name) => setTagSel((s) => addToAll(s, name, tagsOriginal ?? undefined))}
              onRemove={(name) => setTagSel((s) => removeFromAll(s, name))}
              variant="inline"
              addAreaFirst
              placeholder={tagsOriginal == null ? "Loading tags…" : "Add a tag…"}
              disabled={tagsOriginal == null}
              emptyText="No tags yet"
              suggestedPills={communityPills}
              suggestedPillsLabel="Last.fm"
              suggestedPillsLoading={communityLoading}
            />
          </fieldset>

          {/* Hidden, not unmounted, on another tab: the editor holds the edit
              (and the place in Sync), and a remount would show the original
              text while Save still wrote the edited one. */}
          {single && lyricsRequested && (
            <div className="bulk-edit-lyrics" hidden={tab !== "lyrics"}
              id="bulk-edit-panel-lyrics" role="tabpanel" aria-labelledby="bulk-edit-tab-lyrics">
              {lyricsLoadError ? (
                <div className="bulk-edit-hint bulk-edit-hint--error">
                  Couldn't read the current lyrics: {lyricsLoadError}
                  {lyricsEntity && (
                    <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={() => void loadLyrics(lyricsEntity)}>Try again</button>
                  )}
                </div>
              ) : lyricsInitial == null ? (
                <LyricsWait />
              ) : (
                <>
                  <p className="bulk-edit-hint">
                    {lyricsSourceHint(isLocalTrack(single), lyricsFromFile, lyricsInitial.trim() !== "")}
                  </p>
                  {lyricsLoadWarning && <p className="bulk-edit-hint bulk-edit-hint--warning">{lyricsLoadWarning}</p>}
                  {lyricsError && <p className="bulk-edit-hint bulk-edit-hint--error">Couldn't save the lyrics: {lyricsError}</p>}
                  {lyricsEmptied && (
                    <p className="bulk-edit-hint bulk-edit-hint--warning">
                      Lyrics can't be removed here — an empty editor saves nothing. Revert, or write the lyrics you want instead.
                    </p>
                  )}
                  {metadataSaved && errors.length === 0 && <p className="bulk-edit-hint">Details and tags are saved.</p>}
                  <LyricsEditor initialText={lyricsInitial} live={live} seek={seek} transport={live ? transport : undefined} onTextChange={setLyricsText} />
                </>
              )}
            </div>
          )}

          {single && tab === "file" && (
            <div id="bulk-edit-panel-file" role="tabpanel" aria-labelledby="bulk-edit-tab-file">
            {single.id != null && isLocalTrack(single) && onShowInFolder && (
              <div className="bulk-edit-file-actions">
                <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" onClick={() => { if (single.id != null) onShowInFolder({ libraryId: single.id, path: single.path }); }}>
                  {IS_MAC ? "Show in Finder" : "Show in Folder"}
                </button>
              </div>
            )}
            <dl className="bulk-edit-file">
              <FileRow label="Path">{single.path ? <span className="bulk-edit-path">{single.path}</span> : null}</FileRow>
              <FileRow label="Format">{formatAudioSummary(single.format, audioProps) || null}</FileRow>
              {audioProps?.channels != null && <FileRow label="Channels">{String(audioProps.channels)}</FileRow>}
              <FileRow label="Duration">{single.duration_secs != null ? formatDuration(single.duration_secs) : null}</FileRow>
              <FileRow label="Size">{single.file_size != null ? formatFileSize(single.file_size) : null}</FileRow>
              <FileRow label="Collection">{single.collection_name}</FileRow>
              <FileRow label="Added">{single.added_at ? formatDateTime(single.added_at) : null}</FileRow>
              {extraTags && Object.entries(extraTags).map(([k, v]) => (
                <FileRow key={k} label={prettifyTagKey(k)}>{String(v)}</FileRow>
              ))}
            </dl>
            </div>
          )}
        </div>

        {errors.length > 0 && (
          <div className="bulk-edit-errors">
            <p className="bulk-edit-errors-title">Some files could not be updated:</p>
            {errors.map((e, i) => <p key={i} className="bulk-edit-errors-line">{e}</p>)}
          </div>
        )}

        <div className="ds-modal-actions">
          {confirmDiscard ? (
            <>
              <span className="bulk-edit-confirm">Discard your changes?</span>
              <button className="ds-btn ds-btn--secondary" onClick={() => setConfirmDiscard(false)} autoFocus>Keep editing</button>
              <button className="ds-btn ds-btn--danger" onClick={close}>Discard</button>
            </>
          ) : (
            <>
              <button className="ds-btn ds-btn--ghost" onClick={requestClose}>{metadataSaved && !hasChanges ? "Close" : "Cancel"}</button>
              <button className="ds-btn ds-btn--primary" onClick={() => void handleSave()} disabled={!canSave} title={SAVE_SHORTCUT}>
                {saving ? "Saving…" : "Save changes"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Where the lyrics in the editor came from, and where Save puts them. Text
 *  that didn't come from the files was found by a lyrics provider online. */
function lyricsSourceHint(local: boolean, fromFile: boolean, hasText: boolean): string {
  if (!local) return "This track has no local file, so the lyrics are kept in Vibo.";
  if (fromFile) return "From the track's own files. Saving writes them back there.";
  if (hasText) return "Found online — not in the track's file yet. Saving writes them into it.";
  return "No lyrics yet. Saving writes them into the track's file.";
}

/** The wait for the lyrics chain, which may ask web providers one by one —
 *  after a moment it says how long, so a slow provider doesn't read as a hang. */
function LyricsWait() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(() => setElapsed(Date.now() - started), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <p className="bulk-edit-hint">
      <span className="ds-spinner ds-spinner--sm" />
      {elapsed < LYRICS_SLOW_MS
        ? "Loading lyrics…"
        : `Asking the lyrics providers… ${Math.round(elapsed / 1000)}s`}
    </p>
  );
}

function FileRow({ label, children }: { label: string; children: React.ReactNode }) {
  if (children == null || children === "") return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}
