import { useEffect, useMemo, useState } from "react";
import { useLatestRef } from "../hooks/useLatestRef";
import { createPortal } from "react-dom";
import TagEditor from "./TagEditor";
import { useTagActions } from "../hooks/useTagActions";
import { useCommunityTags, type InvokeInfoFetch } from "../hooks/useCommunityTags";
import { appendCommunityTags } from "../utils/tagSuggestions";
import "./TagPopover.css";
import { normalizeForMatch } from "../utils/normalize";

interface TagPopoverProps {
  /** The library row being tagged. */
  trackId: number;
  /** The song's names: the title heads the dialog, and title + artist fetch
   *  the Last.fm suggestions. */
  title: string;
  artistName?: string | null;
  /** The track's tags, owned by the host (`null` while it is still loading
   *  them). The dialog never loads its own copy, so there is one list and
   *  nothing to fall out of step with the host's display. */
  tags: string[] | null;
  /** Called with the new list: optimistically on each edit, then with the
   *  backend's answer (or the previous list again when the write failed). */
  onTagsChange: (tags: string[]) => void;
  /** Extra class for the trigger button (placement in the host). */
  className?: string;
  suggestions: string[];
  /** Fetches Last.fm community tags for the track so they can be suggested
   *  alongside the library pool (only while the dialog is open). */
  invokeInfoFetch?: InvokeInfoFetch;
  /** Whether plugins finished loading — re-fetches community tags once ready. */
  pluginsLoaded?: boolean;
  /** Opens a tag's detail page. Clicking a chip closes the dialog and navigates. */
  onNavigateToTag?: (name: string) => void;
}

/**
 * The edit-tags dialog behind a small tag button — used on the track page's
 * Details tab (Tags row). Controlled: the host loads and shows the tags; this
 * edits them through `useTagActions` (DB-only, optimistic, reverted on failure).
 */
export default function TagPopover({ trackId, title, artistName, tags, onTagsChange, className, suggestions, invokeInfoFetch, pluginsLoaded, onNavigateToTag }: TagPopoverProps) {
  const [open, setOpen] = useState(false);
  const tagActions = useTagActions();
  // Edits read the newest list (a second edit may start before the first one
  // answers), never the one captured by the render that started them.
  const tagsRef = useLatestRef(tags);

  // Fold Last.fm track + artist tags into the library pool while the dialog
  // is open (cheap: only fetched on demand).
  const { tags: communityTags, loading: communityLoading } = useCommunityTags({
    title,
    artistName: artistName ?? null,
    invokeInfoFetch,
    enabled: open,
    pluginsLoaded,
  });
  const mergedSuggestions = useMemo(
    () => appendCommunityTags(suggestions, communityTags),
    [suggestions, communityTags],
  );
  const communityPills = useMemo(
    () => communityTags.map((t) => t.name),
    [communityTags],
  );

  // A different track closes the dialog.
  useEffect(() => { setOpen(false); }, [trackId]);

  // Escape closes the modal. Per the modal-dismiss convention, an outside click
  // on the overlay does NOT close it — only Escape, the × button, or Done.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  async function handleAdd(name: string) {
    const before = tagsRef.current ?? [];
    onTagsChange([...before, name]);
    const names = await tagActions.add(trackId, name);
    onTagsChange(names ?? (tagsRef.current ?? []).filter((t) => normalizeForMatch(t) !== normalizeForMatch(name)));
  }

  async function handleRemove(name: string) {
    const before = tagsRef.current ?? [];
    onTagsChange(before.filter((t) => normalizeForMatch(t) !== normalizeForMatch(name)));
    const names = await tagActions.remove(trackId, before, name);
    onTagsChange(names ?? before);
  }

  return (
    <>
      <button
        className={className ? `now-tag-btn ${className}` : "now-tag-btn"}
        title="Edit tags"
        onClick={() => setOpen(true)}
        aria-label="Edit tags"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" />
          <line x1="7" y1="7" x2="7.01" y2="7" />
        </svg>
      </button>
      {open && createPortal(
        <div className="ds-modal-overlay">
          <div className="ds-modal tag-edit-modal" role="dialog" aria-label="Tags" aria-modal="true">
            <div className="tag-edit-modal-head">
              <div className="ds-modal-title tag-edit-modal-title">Tags</div>
              <button className="tag-edit-modal-close" onClick={() => setOpen(false)} aria-label="Close" title="Close">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="tag-edit-modal-track">{title}</div>
            {tags != null && tags.length === 0 && (
              <div className="tag-edit-modal-emptyhint">No tags yet — add one below.</div>
            )}
            <TagEditor
              tags={tags ?? []}
              suggestions={mergedSuggestions}
              onAdd={handleAdd}
              onRemove={handleRemove}
              variant="popover"
              disabled={tags == null}
              disabledHint="Loading tags…"
              placeholder="Type a tag and press Enter…"
              autoFocus
              chipPrefix="#"
              onChipLabelClick={onNavigateToTag ? (name) => { setOpen(false); onNavigateToTag(name); } : undefined}
              suggestedPills={communityPills}
              suggestedPillsLabel="Last.fm"
              suggestedPillsLoading={communityLoading}
            />
            <div className="ds-modal-actions">
              <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={() => setOpen(false)}>Done</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
