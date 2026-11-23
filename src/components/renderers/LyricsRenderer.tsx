import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { RendererProps } from "./index";
import type { LyricsData } from "../../types/informationTypes";
import { usePlaybackPosition } from "../../playback/positionStore";
import { currentSyncedLineIndex, parseLrc, scrollLineToCenter } from "../../utils/lyrics";
import { formatClock, type LyricsKind } from "../../utils/lyricsEditor";
import { LyricsEditor } from "./LyricsEditor";

/**
 * The Lyrics tab: synced lines that follow the song (click one to jump
 * there), plain text, or — when the song has none — an invitation to add
 * them. Editing happens in `LyricsEditor`.
 *
 * `data` is null when the providers found nothing; the host passes that only
 * where adding lyrics makes sense (a track page), so null renders the empty
 * state rather than nothing.
 */
export function LyricsRenderer({ data, onAction, context }: RendererProps) {
  const d = data as LyricsData | null;

  // All hooks MUST be called before any conditional return (React rules of hooks)
  const [editing, setEditing] = useState(false);
  const [follow, setFollow] = useState(true);
  const [userScrolled, setUserScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeLineRef = useRef<HTMLDivElement>(null);
  const userScrollTimeout = useRef<number>(0);

  const live = context?.livePosition ?? false;
  const seek = context?.seek;
  const showTimes = context?.showTimes ?? false;
  // Live position only when the host says this entity is the playing track;
  // otherwise the hook opts out of per-tick re-renders and returns 0. Not
  // while editing: the editor subscribes for itself.
  const positionSecs = usePlaybackPosition(live && !editing);
  const lrcLines = useMemo(
    () => (d?.kind === "synced" && d.text ? parseLrc(d.text).filter(l => l.text) : null),
    [d?.kind, d?.text],
  );
  const currentLineIdx = lrcLines ? currentSyncedLineIndex(lrcLines, positionSecs) : -1;

  // `scrollLineToCenter`, NOT `scrollIntoView({ block: "center" })`: the latter
  // scrolls every scrollable ancestor, so following a line would also drag the
  // detail page's own scroll position around. See utils/lyrics.ts.
  useEffect(() => {
    if (follow && !userScrolled && activeLineRef.current && scrollRef.current) {
      scrollLineToCenter(scrollRef.current, activeLineRef.current);
    }
  }, [currentLineIdx, userScrolled, follow]);

  useEffect(() => () => window.clearTimeout(userScrollTimeout.current), []);

  const handleScroll = useCallback(() => {
    setUserScrolled(true);
    if (userScrollTimeout.current) clearTimeout(userScrollTimeout.current);
    userScrollTimeout.current = window.setTimeout(() => setUserScrolled(false), 5000);
  }, []);

  // `local` tells the host the lyrics came from the track's own files, so the
  // edit is saved back into that file rather than only into the app's copy —
  // which the next scan of the file would overwrite.
  const local = !!d?.local;
  const handleSave = useCallback(async (text: string, kind: LyricsKind) => {
    if (!onAction) throw new Error("This page can't save lyrics");
    await onAction("save-lyrics", { text, kind, local });
  }, [onAction, local]);

  const canEdit = !!onAction;

  if (editing) {
    return (
      <div className="renderer-lyrics">
        <LyricsEditor
          initialText={d?.text ?? ""}
          live={live}
          seek={seek}
          onSave={handleSave}
          onClose={() => setEditing(false)}
        />
      </div>
    );
  }

  if (!d?.text) {
    if (!canEdit) return null;
    return (
      <div className="lyrics-empty">
        <p className="lyrics-empty-title">No lyrics found for this song</p>
        <p className="lyrics-empty-hint">Paste them in yourself, then time each line while the song plays to get lyrics that follow along.</p>
        <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={() => setEditing(true)}>Add lyrics</button>
      </div>
    );
  }

  return (
    <div className="renderer-lyrics">
      <div className="lyrics-actions">
        <span
          className={`lyrics-badge${d.kind === "synced" ? " lyrics-badge-synced" : ""}`}
          title={d.kind === "synced" ? "Each line is timed to the song" : "Text only, without timing"}
        >
          {d.kind === "synced" ? "Synced" : "Plain"}
        </span>
        {d.local && <span className="lyrics-badge" title="From the track's own files. Edits are saved back to the lyrics file">From file</span>}
        <span className="lyrics-actions-spacer" />
        {lrcLines && live && (
          <button
            className={`ds-btn ds-btn--sm ds-btn--ghost lyrics-follow-btn${follow ? " active" : ""}`}
            onClick={() => setFollow(v => !v)}
            aria-pressed={follow}
            title={follow ? "Stop scrolling with the song" : "Scroll with the song"}
          >Follow</button>
        )}
        {canEdit && (
          <button className="ds-btn ds-btn--sm ds-btn--secondary" onClick={() => setEditing(true)}>
            {d.kind === "synced" ? "Edit" : "Edit or sync"}
          </button>
        )}
      </div>
      <div className="lyrics-body" ref={scrollRef} onScroll={handleScroll}>
        {lrcLines ? (
          lrcLines.map((line, i) => {
            const active = i === currentLineIdx;
            return (
              <div
                key={i}
                ref={active ? activeLineRef : undefined}
                className={`lyrics-line${active ? " is-active" : ""}${seek ? " is-seekable" : ""}${showTimes ? " has-time" : ""}`}
                onClick={seek ? () => seek(line.time) : undefined}
                title={seek ? "Play from this line" : undefined}
              >
                {showTimes && <span className="lyrics-line-time">{formatClock(line.time)}</span>}
                {line.text}
              </div>
            );
          })
        ) : (
          <div className="lyrics-plain">{d.text}</div>
        )}
      </div>
    </div>
  );
}
