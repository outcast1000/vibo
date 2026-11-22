/**
 * Which detail-page tabs fit on one row, and which go behind "More".
 *
 * Pure: `InformationSections` measures every tab off-screen and asks this.
 * Tabs keep their order (the user's drag order, empty tabs already last), so
 * the row is always a prefix of that order — plus the active tab, which is
 * never hidden: picking a tab from the menu brings it onto the row.
 */
export interface FitTabsInput {
  /** Tab ids in display order. */
  ids: string[];
  /** Measured width of each tab, in px. A tab with no measurement counts as 0. */
  widths: Record<string, number>;
  /** Width the row may use, in px. */
  available: number;
  /** Width of the "More" tab, in px. */
  moreWidth: number;
  /** The tab on screen; always kept on the row. */
  activeId: string | null;
}

export interface FitTabsResult {
  visible: string[];
  overflow: string[];
}

export function fitTabs({ ids, widths, available, moreWidth, activeId }: FitTabsInput): FitTabsResult {
  const w = (id: string) => widths[id] ?? 0;
  const total = ids.reduce((sum, id) => sum + w(id), 0);
  // Not measured yet (0 width), or everything fits: no menu.
  if (available <= 0 || total <= available) return { visible: ids.slice(), overflow: [] };

  const active = activeId != null && ids.includes(activeId) ? activeId : null;
  let budget = available - moreWidth - (active ? w(active) : 0);
  const keep = new Set<string>();
  if (active) keep.add(active);
  for (const id of ids) {
    if (id === active) continue;
    if (w(id) > budget) break;
    budget -= w(id);
    keep.add(id);
  }
  return {
    visible: ids.filter((id) => keep.has(id)),
    overflow: ids.filter((id) => !keep.has(id)),
  };
}
