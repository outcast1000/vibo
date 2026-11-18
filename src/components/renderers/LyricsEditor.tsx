import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { getPlaybackPosition, usePlaybackPosition } from "../../playback/positionStore";
import { scrollLineToCenter } from "../../utils/lyrics";
import {
  clearAllTimes,
  detectLyricsKind,
  firstUntimedIndex,
  formatClock,
  lyricsStats,
  nextSyncable,
  nudgeInText,
  parseEditorLines,
  prevSyncable,
  stampInText,
  syncableIndices,
  type LyricsKind,
} from "../../utils/lyricsEditor";

/** Fine and coarse (Shift) nudge for the last stamp. */
const NUDGE_STEP = 0.1;
const NUDGE_COARSE_STEP = 1;
/** "Replay from here" starts this far before the line, so the lead-in is heard. */
const REPLAY_PREROLL_SECS = 2;
/** How long "Start over" waits for its confirming second click. */
const CONFIRM_WINDOW_MS = 3000;

interface LyricsEditorProps {
  initialText: string;
  /** True when this song is the one playing — Sync needs a live position. */
  live: boolean;
  /** Play this song from `secs` (seeks when it is already playing). Absent
   *  where the page can't start the song; Sync then asks the user to. */
  seek?: (secs: number) => void;
  /** Persist; rejects with the reason when the save failed. */
  onSave: (text: string, kind: LyricsKind) => Promise<void>;
  onClose: () => void;
}

type Tab = "write" | "sync";

/**
 * The lyrics editor: one text, two ways in. **Write** is a textarea for
 * pasting plain lyrics or an LRC; **Sync** times each line by tapping Space
 * while the song plays. Whether it saves as synced or plain is read off the
 * text (`detectLyricsKind`) — there is no type picker to get wrong.
 */
export function LyricsEditor({ initialText, live, seek, onSave, onClose }: LyricsEditorProps) {
  const [text, setText] = useState(initialText);
  const [tab, setTab] = useState<Tab>("write");
  const [cursor, setCursor] = useState(() => firstUntimedIndex(parseEditorLines(initialText)));
  const [lastStamped, setLastStamped] = useState(-1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const lines = useMemo(() => parseEditorLines(text), [text]);
  const stats = useMemo(() => lyricsStats(lines), [lines]);
  const kind = useMemo(() => detectLyricsKind(text), [text]);
  const syncable = useMemo(() => syncableIndices(lines), [lines]);
  const dirty = text !== initialText;
  const empty = text.trim() === "";

  const position = usePlaybackPosition(live && tab === "sync");
  // The line being sung now, by the stamps so far — so a replay shows
  // whether the times land.
  const singing = useMemo(() => {
    let idx = -1;
    let latest = -Infinity;
    for (const i of syncable) {
      const t = lines[i].time;
      if (t != null && t <= position && t >= latest) { idx = i; latest = t; }
    }
    return idx;
  }, [lines, syncable, position]);

  const listRef = useRef<HTMLDivElement>(null);
  const cursorRowRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep the cursor on a sung line as the text changes underneath it.
  const cursorValid = cursor >= 0 && cursor < lines.length && !lines[cursor].meta && lines[cursor].text !== "";
  const activeCursor = cursorValid ? cursor : firstUntimedIndex(lines);

  useEffect(() => {
    if (tab === "sync") listRef.current?.focus();
    else textareaRef.current?.focus();
  }, [tab]);

  useEffect(() => {
    if (tab === "sync" && listRef.current && cursorRowRef.current) {
      scrollLineToCenter(listRef.current, cursorRowRef.current);
    }
  }, [tab, activeCursor]);

  useEffect(() => {
    if (!confirmClear) return;
    const t = window.setTimeout(() => setConfirmClear(false), CONFIRM_WINDOW_MS);
    return () => window.clearTimeout(t);
  }, [confirmClear]);

  const edit = useCallback((next: string) => {
    setText(next);
    setError(null);
    setConfirmDiscard(false);
  }, []);

  const stamp = useCallback(() => {
    if (!live || activeCursor < 0) return;
    edit(stampInText(text, activeCursor, getPlaybackPosition()));
    setLastStamped(activeCursor);
    const next = nextSyncable(lines, activeCursor);
    if (next >= 0) setCursor(next);
  }, [live, activeCursor, text, lines, edit]);

  const undo = useCallback(() => {
    if (activeCursor < 0) return;
    // On a timed line (the last one, after it was stamped): clear it.
    // Otherwise step back and clear the line before.
    const target = lines[activeCursor].time != null ? activeCursor : prevSyncable(lines, activeCursor);
    if (target < 0) return;
    edit(stampInText(text, target, null));
    setCursor(target);
    setLastStamped(prevSyncable(lines, target));
  }, [activeCursor, lines, text, edit]);

  const nudge = useCallback((delta: number) => {
    const target = lastStamped >= 0 && lines[lastStamped]?.time != null
      ? lastStamped
      : (lines[activeCursor]?.time != null ? activeCursor : -1);
    if (target < 0) return;
    edit(nudgeInText(text, target, delta));
    setLastStamped(target);
  }, [lastStamped, activeCursor, lines, text, edit]);

  const startOver = () => {
    if (!confirmClear) { setConfirmClear(true); return; }
    setConfirmClear(false);
    const cleared = clearAllTimes(text);
    edit(cleared);
    setCursor(firstUntimedIndex(parseEditorLines(cleared)));
    setLastStamped(-1);
  };

  const save = async () => {
    if (saving || empty || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(text.replace(/\s+$/, ""), kind);
      onClose();
    } catch (e) {
      console.error("Failed to save lyrics:", e);
      setError(`Couldn't save the lyrics: ${e instanceof Error ? e.message : String(e)}`);
      setSaving(false);
    }
  };

  const requestClose = () => {
    if (dirty && !confirmDiscard) { setConfirmDiscard(true); return; }
    onClose();
  };

  // Editor-wide keys. Stopped here so the page's own shortcuts don't also
  // run: Escape would close the track page, Space would pause.
  const handleRootKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopPropagation();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (confirmDiscard) setConfirmDiscard(false);
      else requestClose();
    }
  };

  const handleSyncKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    let handled = true;
    switch (e.key) {
      case " ":
      case "Enter": stamp(); break;
      case "Backspace": undo(); break;
      case "ArrowDown": { const n = nextSyncable(lines, activeCursor); if (n >= 0) setCursor(n); break; }
      case "ArrowUp": { const p = prevSyncable(lines, activeCursor); if (p >= 0) setCursor(p); break; }
      case "ArrowLeft": nudge(-(e.shiftKey ? NUDGE_COARSE_STEP : NUDGE_STEP)); break;
      case "ArrowRight": nudge(e.shiftKey ? NUDGE_COARSE_STEP : NUDGE_STEP); break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  const summary = empty
    ? "Nothing to save yet"
    : kind === "synced"
      ? `Saves as synced · ${stats.timed} of ${stats.lines} lines timed`
      : `Saves as plain text · ${stats.lines} ${stats.lines === 1 ? "line" : "lines"}`;
  const warnings: string[] = [];
  if (kind === "synced" && stats.timed < stats.lines) {
    const n = stats.lines - stats.timed;
    warnings.push(`${n} untimed ${n === 1 ? "line won't" : "lines won't"} show while synced`);
  }
  if (stats.outOfOrder > 0) {
    warnings.push(`${stats.outOfOrder} ${stats.outOfOrder === 1 ? "line is" : "lines are"} earlier than the line before`);
  }

  return (
    <div className="lyrics-editor-panel" onKeyDown={handleRootKeyDown}>
      <div className="lyrics-editor-head">
        <div className="ds-tabs ds-tabs--compact ds-tabs--no-border" role="tablist" aria-label="Edit mode">
          <button role="tab" aria-selected={tab === "write"} className={`ds-tab${tab === "write" ? " active" : ""}`} onClick={() => setTab("write")}>Write</button>
          <button role="tab" aria-selected={tab === "sync"} className={`ds-tab${tab === "sync" ? " active" : ""}`} onClick={() => setTab("sync")}>
            Sync
            {stats.lines > 0 && <span className="ds-tab-badge">{stats.timed}/{stats.lines}</span>}
          </button>
        </div>
        {tab === "sync" && live && <span className="lyrics-sync-clock" aria-label="Song position">{formatClock(position)}</span>}
      </div>

      {tab === "write" ? (
        <>
          <textarea
            ref={textareaRef}
            className="lyrics-editor"
            value={text}
            onChange={e => edit(e.target.value)}
            spellCheck={false}
            aria-label="Lyrics"
            placeholder={"Paste the lyrics here, one sung line per line.\n\nHave an LRC file? Paste it as it is — times like [01:23.45] are kept.\nThen open Sync to time the lines while the song plays."}
          />
        </>
      ) : syncable.length === 0 ? (
        <div className="lyrics-sync-empty">
          <p>Add the words in <button className="lyrics-link-btn" onClick={() => setTab("write")}>Write</button> first, then come back to time them.</p>
        </div>
      ) : (
        <>
          <div className="lyrics-sync-bar">
            {live ? (
              <>
                <button className="ds-btn ds-btn--sm ds-btn--primary" onClick={stamp} title="Stamp the highlighted line at the current position (Space)">Stamp line</button>
                <button className="ds-btn ds-btn--sm ds-btn--secondary" onClick={undo} title="Undo the last stamp (Backspace)">Undo</button>
                <button className={`ds-btn ds-btn--sm ${confirmClear ? "ds-btn--danger" : "ds-btn--ghost"}`} onClick={startOver} disabled={stats.timed === 0}>
                  {confirmClear ? "Clear all times?" : "Start over"}
                </button>
              </>
            ) : seek ? (
              <>
                <span className="lyrics-sync-note">Syncing follows the song as it plays.</span>
                <button className="ds-btn ds-btn--sm ds-btn--primary" onClick={() => seek(0)}>Play this song</button>
              </>
            ) : (
              <span className="lyrics-sync-note">Play this song to sync its lines.</span>
            )}
          </div>
          <div
            ref={listRef}
            className={`lyrics-sync-list${live ? "" : " is-idle"}`}
            tabIndex={0}
            role="listbox"
            aria-label="Lines to sync"
            aria-activedescendant={activeCursor >= 0 ? `lyrics-sync-row-${activeCursor}` : undefined}
            onKeyDown={handleSyncKeyDown}
          >
            {syncable.map(i => {
              const line = lines[i];
              const isCursor = i === activeCursor;
              return (
                <div
                  key={i}
                  id={`lyrics-sync-row-${i}`}
                  ref={isCursor ? cursorRowRef : undefined}
                  role="option"
                  aria-selected={isCursor}
                  className={`lyrics-sync-row${isCursor ? " is-cursor" : ""}${i === singing ? " is-singing" : ""}${line.time == null ? " is-untimed" : ""}`}
                  onClick={() => setCursor(i)}
                >
                  {line.time != null && seek ? (
                    <button
                      className="lyrics-sync-time"
                      tabIndex={-1}
                      title="Replay from this line"
                      onClick={e => { e.stopPropagation(); seek(Math.max(0, line.time! - REPLAY_PREROLL_SECS)); listRef.current?.focus(); }}
                    >{formatClock(line.time)}</button>
                  ) : (
                    <span className="lyrics-sync-time">{line.time != null ? formatClock(line.time) : "–:––.–"}</span>
                  )}
                  <span className="lyrics-sync-text">{line.text}</span>
                </div>
              );
            })}
          </div>
          <div className="lyrics-sync-keys" aria-hidden="true">
            <span><kbd>Space</kbd> stamp</span>
            <span><kbd>⌫</kbd> undo</span>
            <span><kbd>↑</kbd><kbd>↓</kbd> choose line</span>
            <span><kbd>←</kbd><kbd>→</kbd> nudge last stamp (<kbd>⇧</kbd> 1s)</span>
          </div>
        </>
      )}

      <div className="lyrics-editor-foot">
        <div className="lyrics-editor-status" role="status">
          {error ? (
            <span className="lyrics-editor-error">{error}</span>
          ) : (
            <>
              <span>{summary}</span>
              {warnings.map(w => <span key={w} className="lyrics-editor-warning">{w}</span>)}
            </>
          )}
        </div>
        <div className="lyrics-editor-buttons">
          {confirmDiscard ? (
            <>
              <span className="lyrics-editor-confirm">Discard your changes?</span>
              <button className="ds-btn ds-btn--sm ds-btn--secondary" onClick={() => setConfirmDiscard(false)}>Keep editing</button>
              <button className="ds-btn ds-btn--sm ds-btn--danger" onClick={onClose}>Discard</button>
            </>
          ) : (
            <>
              <button className="ds-btn ds-btn--sm ds-btn--secondary" onClick={requestClose} disabled={saving} title="Esc">Cancel</button>
              <button className="ds-btn ds-btn--sm ds-btn--primary" onClick={() => void save()} disabled={saving || empty || !dirty} title="⌘S">
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
