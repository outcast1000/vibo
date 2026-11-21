import { useRef, useState } from "react";
import type { LyricsDraft } from "../../utils/lyricsDrafts";
import type { LyricsKind } from "../../utils/lyricsEditor";
import { LyricsEditor } from "./LyricsEditor";

/** The song's lyrics as the page knows them while the draft is reviewed. */
export type CurrentLyrics =
  | { state: "loading" }
  | { state: "none" }
  | { state: "loaded"; text: string; kind: string };

interface LyricsDraftReviewProps {
  draft: LyricsDraft;
  current: CurrentLyrics;
  live: boolean;
  seek?: (secs: number) => void;
  onSave: (text: string, kind: LyricsKind) => Promise<void>;
  /** The review ended: saved, or discarded. */
  onDone: (outcome: "saved" | "discarded") => void;
}

/**
 * A plugin's lyrics draft under review (`requestAction("review-lyrics")`):
 * the ordinary lyrics editor, opened on the draft, under a banner saying
 * where it came from and what to check. Save is the approval and replaces the
 * song's lyrics; Discard draft leaves them as they were. Save waits until the
 * song's current lyrics have been read, so it never replaces lyrics the user
 * was told don't exist.
 */
export function LyricsDraftReview({ draft, current, live, seek, onSave, onDone }: LyricsDraftReviewProps) {
  const [comparing, setComparing] = useState(false);
  const saved = useRef(false);
  const currentText = current.state === "loaded" ? current.text : "";

  const replaces =
    current.state === "loading" ? "Reading the song's current lyrics…"
      : current.state === "loaded" ? `Saving replaces the song's ${current.kind === "synced" ? "synced" : "plain"} lyrics.`
        : "The song has no lyrics yet.";

  const banner = (
    <div className="lyrics-draft-banner" role="note">
      <div className="lyrics-draft-banner-row">
        <div className="lyrics-draft-banner-text">
          <span className="lyrics-draft-title">Draft from {draft.source}: check it, then Save</span>
          {draft.note && <span className="lyrics-draft-note">{draft.note}</span>}
          <span className="lyrics-draft-note">{replaces} Use Sync to replay a line and nudge its time.</span>
        </div>
        {currentText && (
          <button
            className={`ds-btn ds-btn--sm ds-btn--ghost${comparing ? " active" : ""}`}
            aria-pressed={comparing}
            onClick={() => setComparing(v => !v)}
          >{comparing ? "Hide current lyrics" : "Show current lyrics"}</button>
        )}
      </div>
      {comparing && currentText && (
        <pre className="lyrics-draft-current" aria-label="Current lyrics">{currentText}</pre>
      )}
    </div>
  );

  return (
    <div className="renderer-lyrics">
      <LyricsEditor
        initialText={draft.text}
        baselineText={currentText}
        live={live}
        seek={seek}
        onSave={async (text, kind) => {
          await onSave(text, kind);
          saved.current = true;
        }}
        onClose={() => onDone(saved.current ? "saved" : "discarded")}
        banner={banner}
        review
        saveBlockedReason={current.state === "loading" ? "Waiting for the song's current lyrics" : null}
      />
    </div>
  );
}
