import type { ReactNode } from "react";
import { ViewSearchBar } from "./ViewSearchBar";
import { ToggleSwitch } from "./ToggleSwitch";
import "./DetailTrackFilter.css";

interface DetailTrackFilterProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** Rows the list draws unfiltered (library + "Not in library"). */
  total: number;
  /** Rows left after the filter. */
  shown: number;
}

/** The filter box above an artist / album / tag page's track list. The page
 *  decides whether to render it (`showDetailFilter`); this only draws it. */
export function DetailTrackFilter({ query, onQueryChange, total, shown }: DetailTrackFilterProps) {
  return (
    <ViewSearchBar
      className="detail-track-filter"
      query={query}
      onQueryChange={onQueryChange}
      placeholder={`Filter ${total} tracks`}
    >
      {query.trim() && <span className="detail-track-filter-count">{shown} of {total}</span>}
    </ViewSearchBar>
  );
}

interface DetailTrackToolbarProps {
  /** The filter box, or a falsy value when the list is too short for one. */
  filter: ReactNode;
  /** The "Not in library" switch; omitted when the page has no such rows. */
  missing?: { show: boolean; count: number; onChange: (show: boolean) => void };
}

/** What sits above an artist / album page's track list: the filter box and the
 *  switch that shows or hides the provider's tracks the library lacks. Renders
 *  nothing when neither applies. */
export function DetailTrackToolbar({ filter, missing }: DetailTrackToolbarProps) {
  if (!filter && !missing) return null;
  return (
    <div className="detail-track-toolbar">
      {filter}
      {missing && (
        <label className="detail-track-missing-toggle">
          <ToggleSwitch checked={missing.show} onChange={missing.onChange} label="Show tracks not in library" />
          <span>Not in library ({missing.count})</span>
        </label>
      )}
    </div>
  );
}
