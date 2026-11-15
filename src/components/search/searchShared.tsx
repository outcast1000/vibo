// Shared search UI primitives (split out of SearchView.tsx).
import { useRef, useCallback, type RefCallback } from "react";
import { chainPosition, chainDir, type SortKey } from "../../sortChain";
import { IconPlay } from "../Icons";

export function LoadMoreSentinel({ hasMore, loading, onLoadMore }: { hasMore: boolean; loading: boolean; onLoadMore: () => void }) {
  const observerRef = useRef<IntersectionObserver | null>(null);

  const sentinelRef: RefCallback<HTMLDivElement> = useCallback((node) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (!node || !hasMore) return;
    observerRef.current = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) onLoadMore(); },
      { threshold: 0 },
    );
    observerRef.current.observe(node);
  }, [hasMore, onLoadMore]);

  if (!hasMore) return null;
  return (
    <div ref={sentinelRef} className="search-view-load-more">
      {loading && <span className="ds-spinner ds-spinner--sm" />}
    </div>
  );
}

export function SortButton({ label, field, chain, onClick }: {
  label: string;
  field: string;
  chain: SortKey[];
  onClick: (field: string, e: React.MouseEvent) => void;
}) {
  const pos = chainPosition(chain, field);
  const dir = chainDir(chain, field);
  const arrow = dir === "asc" ? " ▲" : dir === "desc" ? " ▼" : "";
  return (
    <button
      className={`sort-btn${pos >= 0 ? " active" : ""}`}
      onClick={e => onClick(field, e)}
    >
      {label}{arrow}
      {chain.length > 1 && pos >= 0 && <span className="sort-btn-badge">{pos + 1}</span>}
    </button>
  );
}

/** "Play" in a track tab's bar: replaces the queue with the rows on screen
 *  (only the loaded pages; scrolling for more extends what it plays), or with
 *  the selection when there is one. Hidden when there's nothing to play, so
 *  the bar doesn't carry a dead button on an empty result.
 *
 *  `count` / `selectedCount` are what a click will queue, not the row count
 *  (History's play log names a song once per play and queues it once).
 *  `total`, when larger than `count`, is how many the list holds in all, so
 *  the tooltip says only the loaded part plays. */
export function PlayAllButton({ count, selectedCount, total, onClick }: {
  count: number;
  selectedCount: number;
  total?: number;
  onClick: () => void;
}) {
  if (count === 0) return null;
  const tracks = (n: number) => `${n} track${n === 1 ? "" : "s"}`;
  const label = selectedCount > 0 ? `Play ${selectedCount}` : "Play";
  const title = selectedCount > 0
    ? `Play the ${tracks(selectedCount)} selected`
    : total != null && total > count
      ? `Play the first ${tracks(count)} of ${total} (scroll down to load more)`
      : `Play these ${tracks(count)}`;
  return (
    <button
      className="ds-btn ds-btn--primary ds-btn--sm play-all-btn"
      onClick={onClick}
      title={title}
      aria-label={title}
    >
      <IconPlay size={12} />
      {label}
    </button>
  );
}
