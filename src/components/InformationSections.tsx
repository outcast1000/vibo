import { renderers } from "./renderers";
import { LyricsDraftReview } from "./renderers/LyricsDraftReview";
import { closeLyricsDraft, useLyricsDraft } from "../utils/lyricsDrafts";
import type { CurrentLyrics } from "./renderers/LyricsDraftReview";
import type { LyricsKind } from "../utils/lyricsEditor";
import type { InfoEntity } from "../types/informationTypes";
import { useInformationTypes } from "../hooks/useInformationTypes";
import type { OpenInfoArgs } from "../hooks/useRetrieveModal";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { saveSongLyrics } from "../utils/localLyrics";
import { openUrl } from "@tauri-apps/plugin-opener";
import { buildEntityKey } from "../types/informationTypes";
import type { QueueTrack } from "../types";
import { buildExternalQueueTrack } from "../utils/externalTrack";
import { entityIdentity, onDetailTabRequest, takeDetailTab } from "../utils/pendingDetailTab";
import { useLatestRef } from "../hooks/useLatestRef";
import { PluginViewSection } from "./renderers/PluginViewSection";
import { parseProviderKey } from "../utils/providerKey";
import { fitTabs } from "../utils/tabOverflow";
import { showNativeMenu } from "../nativeMenu";
import "./InformationSections.css";

/** Row width kept free for the refresh icon (14px + its gap), whether or not
 *  the shown tab has one — so switching tabs never reshuffles the row. */
const REFRESH_RESERVE_PX = 24;
const MORE_MEASURE_ID = "__more__";

interface TabMeasure {
  widths: Record<string, number>;
  available: number;
  more: number;
}

function sameMeasure(a: TabMeasure, b: TabMeasure): boolean {
  if (a.available !== b.available || a.more !== b.more) return false;
  const ak = Object.keys(a.widths);
  if (ak.length !== Object.keys(b.widths).length) return false;
  return ak.every((k) => a.widths[k] === b.widths[k]);
}

export interface CustomTab {
  id: string;
  name: string;
  content: ReactNode;
}

/** Display kinds that render in the header area (above tracks).
 *  Currently empty — only title_line (handled by TitleLineInfo) goes in headers.
 *  All other display kinds render below the track list. */
const HEADER_DISPLAY_KINDS = new Set<string>();

function MoreChevron() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

interface InformationSectionsProps {
  entity: InfoEntity | null;
  exclude?: string[];
  /** Filter sections by placement. "header" shows ranked_list/tag_list/image_gallery; "below" shows everything else. Omit to show all. */
  placement?: "header" | "below";
  customTabs?: CustomTab[];
  /** Requested-tab ids this page answers with another tab (a host tab that was
   *  folded into another one), so `api.ui.navigateToEntity(…, { tab })` with
   *  the old id still lands somewhere sensible. */
  tabAliases?: Record<string, string>;
  /** Skip every plugin info section (no fetches, no cache reads) and render
   * only `customTabs`. For entities where per-entity metadata is meaningless —
   * a "Various Artists" collective, whose Last.fm bio/similar describe nothing. */
  pluginSectionsDisabled?: boolean;
  /** True when the entity is the currently playing track — lets position-aware
      renderers (lyrics) subscribe to the live playback position. */
  livePosition?: boolean;
  /** Play the entity from a position (seeks when it is already playing).
   *  Lets the lyrics tab jump to a line and sync along with the song. */
  onSeek?: (secs: number) => void;
  invokeInfoFetch: (
    pluginId: string,
    infoTypeId: string,
    entity: InfoEntity,
    onFetchUrl?: (url: string) => void,
  ) => Promise<import("../types/informationTypes").InfoFetchResult>;
  pluginNames?: Map<string, string>;
  /** Preferred tab order — tab IDs listed here appear first in this order, rest follow */
  tabOrder?: string[];
  /** Called when user reorders tabs via drag-and-drop; receives the full ordered list of tab IDs */
  onTabOrderChange?: (order: string[]) => void;
  onEntityClick?: (kind: string, id?: number, name?: string) => void;
  onAction?: (actionId: string, payload?: unknown) => void;
  resolveEntity?: (kind: string, name: string) => { id?: number; imageSrc?: string } | undefined;
  /** Called when title_line sections have loaded data (typeId → parsed data) */
  onTitleData?: (typeId: string, data: unknown) => void;
  onTrackContextMenu?: (e: React.MouseEvent, trackInfo: { trackId?: number; title: string; artistName: string | null }) => void;
  onEntityContextMenu?: (e: React.MouseEvent, info: { kind: "track" | "artist" | "album"; id?: number; name: string; artistName?: string | null }) => void;
  /** When provided, the Refresh button opens the centered Retrieve modal (preview → Apply). */
  retrieve?: {
    openInfo: (args: OpenInfoArgs) => void;
  };
}

type TabEntry =
  | { kind: "plugin"; typeId: string; name: string; description?: string; section: import("../types/informationTypes").InfoSection }
  | { kind: "custom"; id: string; name: string; description?: string; content: ReactNode };

export function InformationSections({
  entity,
  exclude,
  placement,
  customTabs,
  pluginSectionsDisabled,
  livePosition,
  onSeek,
  invokeInfoFetch,
  pluginNames,
  tabOrder,
  onTabOrderChange,
  onEntityClick,
  onAction,
  resolveEntity,
  onTitleData,
  onTrackContextMenu,
  onEntityContextMenu,
  retrieve,
  tabAliases,
}: InformationSectionsProps) {
  const { sections, refresh, reloadCache, getTypeMeta, activate } = useInformationTypes({ entity, exclude, disabled: pluginSectionsDisabled, invokeInfoFetch, pluginNames });
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const entityKey = entity ? buildEntityKey(entity) : null;
  // A plugin's lyrics draft waiting for review on this track (review-lyrics):
  // the lyrics tab opens on it, in the editor, whatever the tab holds now.
  const lyricsDraft = useLyricsDraft(entity?.kind === "track" ? { name: entity.name, artistName: entity.artistName } : null);
  const rendererContext = useMemo(
    () => (livePosition != null || onSeek ? { livePosition, seek: onSeek } : undefined),
    [livePosition, onSeek],
  );

  // After the Retrieve modal applies new info for one of our types, reload the
  // section from cache so it reflects the newly-saved value.
  useEffect(() => {
    const onApplied = (e: Event) => {
      const detail = (e as CustomEvent).detail as { infoTypeId?: string; entityKey?: string };
      if (detail.entityKey && detail.entityKey === entityKey) reloadCache();
    };
    window.addEventListener("retrieve:info-applied", onApplied);
    return () => window.removeEventListener("retrieve:info-applied", onApplied);
  }, [entityKey, reloadCache]);

  const handleRefresh = useCallback((typeId: string, _name: string) => {
    // Prefer the centered Retrieve modal (preview → Apply, provider switching).
    // Fall back to the legacy in-place delete+refetch when no modal is wired.
    const meta = getTypeMeta(typeId);
    if (retrieve && entity && meta) {
      retrieve.openInfo({
        infoTypeId: typeId,
        label: meta.name,
        displayKind: meta.displayKind,
        entity,
        providers: meta.providers,
        pluginNames: pluginNames ?? new Map(),
      });
      return;
    }
    refresh(typeId);
  }, [retrieve, entity, getTypeMeta, pluginNames, refresh]);

  // Tab drag-and-drop state
  const [draggedTab, setDraggedTab] = useState<string | null>(null);
  const [dragOverTab, setDragOverTab] = useState<string | null>(null);
  const draggedTabRef = useRef<string | null>(null);
  const dragOverTabRef = useRef<string | null>(null);
  const didDragTabRef = useRef(false);
  const tabGhostRef = useRef<HTMLDivElement | null>(null);

  // Reset to first tab when entity changes — or to the tab a plugin asked for
  // when it opened this page (`api.ui.navigateToEntity(…, { tab })`). Only the
  // page's main tab bar takes that request: the artist page's header strip
  // (Albums) is a second instance for the same entity and would use it up.
  const takesTabRequests = placement !== "header";
  const tabAliasesRef = useLatestRef(tabAliases);
  const entityRef = useLatestRef(entity);
  // The entity the reset last ran for, folded. Neither of these is a new
  // page, and a second reset would throw away the tab the first one chose:
  // StrictMode running this effect twice, and a page respelled by the
  // navigation that brought the request ("Björk" → "bjork" on a page built
  // from a name — the listener below has already taken the request then).
  const resetForRef = useRef<string | null>(null);
  useEffect(() => {
    const current = entityRef.current;
    const identity = current ? entityIdentity(current) : null;
    if (resetForRef.current === identity) return;
    resetForRef.current = identity;
    const requested = current && takesTabRequests ? takeDetailTab(current) : null;
    setActiveTab(requested ? (tabAliasesRef.current?.[requested] ?? requested) : null);
  }, [entityKey, takesTabRequests, entityRef, tabAliasesRef]);
  // A request for the page already showing: the entity doesn't change, so the
  // effect above never runs — take it as it arrives.
  useEffect(() => {
    if (!takesTabRequests) return;
    return onDetailTabRequest(() => {
      const current = entityRef.current;
      const tab = current ? takeDetailTab(current) : null;
      if (tab) setActiveTab(tabAliasesRef.current?.[tab] ?? tab);
    });
  }, [takesTabRequests, entityRef, tabAliasesRef]);

  // Notify parent about title_line data (filtered from tabs but still fetched)
  useEffect(() => {
    if (!onTitleData) return;
    for (const s of sections) {
      if (s.displayKind === "title_line" && s.state.kind === "loaded" && s.state.data) {
        onTitleData(s.typeId, s.state.data);
      }
    }
  }, [sections, onTitleData]);

  const handleAction = useCallback(async (actionId: string, payload?: unknown, sectionName?: string) => {
    // The list item rarely carries an explicit artist (e.g. Last.fm "Top Songs"
    // emits track name only). Fall back to the section's own entity: its
    // artistName for album/track pages, or its name when it IS an artist.
    const resolveArtist = (explicit?: string): string | undefined =>
      explicit ??
      entity?.artistName ??
      (entity?.kind === "artist" ? entity.name : undefined);
    if (actionId === "save-lyrics" && entity) {
      const p = payload as { text: string; kind: string; local?: boolean } | undefined;
      if (!p) return;
      // A track's lyrics are always saved into its files when it has a local
      // one (owner decision, 2026-11-20), whichever provider the edited text
      // came from; a song with no local file keeps them in the cache
      // (saveSongLyrics, shared with the control API's lyrics.set). The save
      // announces the change, so this section (and any other open view of the
      // song) re-reads by itself — after a refused file save too. Rethrown:
      // the editor stays open with the reason.
      try {
        await saveSongLyrics(entity, p.text, p.kind, "edit");
      } catch (e) {
        console.error("Failed to save lyrics:", e);
        throw e;
      }
      return;
    }
    if (actionId === "play-track" || actionId === "enqueue-track") {
      const p = payload as { name?: string; artist?: string } | undefined;
      if (!p?.name || !onAction) return;
      const artist = resolveArtist(p.artist);
      const ext: QueueTrack = buildExternalQueueTrack(p.name, artist);
      onAction(actionId === "enqueue-track" ? "enqueue-track" : "play-track", ext);
      return;
    }
    // A click on a row of a track list (Similar Tracks, Top Songs): queue the
    // whole list from that row, metadata-only — the stream resolvers find each
    // track's source when it plays, a library copy first.
    if (actionId === "play-list") {
      const p = payload as { items?: { name: string; artist?: string }[]; startIndex?: number } | undefined;
      if (!p?.items?.length || !onAction) return;
      const tracks = p.items.map(it => buildExternalQueueTrack(it.name, resolveArtist(it.artist)));
      const startIndex = Math.min(Math.max(p.startIndex ?? 0, 0), tracks.length - 1);
      const name = sectionName && entity ? `${sectionName} · ${entity.name}` : sectionName ?? entity?.name;
      onAction("play-tracks", { tracks, startIndex, context: name ? { name } : null });
      return;
    }
    if (onAction) onAction(actionId, payload);
  }, [entity, onAction]);

  function handleTabMouseDown(e: React.MouseEvent, tabId: string) {
    if (e.button !== 0 || !onTabOrderChange) return;
    draggedTabRef.current = tabId;
    dragOverTabRef.current = null;
    didDragTabRef.current = false;
    const startX = e.clientX;
    const startY = e.clientY;

    function findTabId(el: Element | null): string | null {
      while (el) {
        const id = el.getAttribute("data-tab-id");
        if (id) return id;
        el = el.parentElement;
      }
      return null;
    }

    function showGhost(x: number, y: number) {
      if (!tabGhostRef.current) {
        const ghost = document.createElement("div");
        ghost.className = "info-tab-drag-ghost";
        const entry = tabs.find(t => getTabId(t) === tabId);
        ghost.textContent = entry?.name ?? tabId;
        document.body.appendChild(ghost);
        tabGhostRef.current = ghost;
      }
      tabGhostRef.current.style.left = `${x + 12}px`;
      tabGhostRef.current.style.top = `${y - 10}px`;
    }

    function removeGhost() {
      if (tabGhostRef.current) { tabGhostRef.current.remove(); tabGhostRef.current = null; }
    }

    function onMouseMove(ev: MouseEvent) {
      if (!draggedTabRef.current) return;
      if (!didDragTabRef.current) {
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 5) return;
        didDragTabRef.current = true;
        setDraggedTab(draggedTabRef.current);
      }
      showGhost(ev.clientX, ev.clientY);
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const overId = target ? findTabId(target) : null;
      if (overId && overId !== draggedTabRef.current) {
        dragOverTabRef.current = overId;
        setDragOverTab(overId);
      } else {
        dragOverTabRef.current = null;
        setDragOverTab(null);
      }
    }

    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      removeGhost();
      const from = draggedTabRef.current;
      const to = dragOverTabRef.current;
      if (didDragTabRef.current && from && to && from !== to) {
        // Compute new order from the current visible (non-empty-sorted) tab list
        const ids = tabs.map(t => getTabId(t));
        const fromIdx = ids.indexOf(from);
        const toIdx = ids.indexOf(to);
        if (fromIdx !== -1 && toIdx !== -1) {
          ids.splice(fromIdx, 1);
          ids.splice(toIdx, 0, from);
          onTabOrderChange!(ids);
        }
      }
      draggedTabRef.current = null;
      dragOverTabRef.current = null;
      setDraggedTab(null);
      setDragOverTab(null);
      setTimeout(() => { didDragTabRef.current = false; }, 0);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  const filtered = sections.filter(s => {
    if (s.displayKind === "title_line") return false;
    if (placement === "header") return HEADER_DISPLAY_KINDS.has(s.displayKind);
    if (placement === "below") return !HEADER_DISPLAY_KINDS.has(s.displayKind);
    return true;
  });

  // Build unified tab list: custom tabs first, then plugin sections
  const tabs: TabEntry[] = [
    ...(customTabs ?? []).map(ct => ({ kind: "custom" as const, id: ct.id, name: ct.name, content: ct.content })),
    ...filtered.map(s => ({ kind: "plugin" as const, typeId: s.typeId, name: s.name, description: s.description, section: s })),
  ];

  const getTabId = (t: TabEntry) => t.kind === "custom" ? t.id : t.typeId;

  // Apply preferred tab ordering if specified, then sort empty tabs last
  {
    const isEmpty = (t: TabEntry) => {
      if (t.kind === "custom") return 0;
      return t.section.state.kind === "empty" ? 1 : 0;
    };
    tabs.sort((a, b) => {
      // Primary: tabs with data before empty tabs
      const emptyDiff = isEmpty(a) - isEmpty(b);
      if (emptyDiff !== 0) return emptyDiff;
      // Secondary: preferred tab order
      if (tabOrder && tabOrder.length > 0) {
        const aId = getTabId(a);
        const bId = getTabId(b);
        const aIdx = tabOrder.indexOf(aId);
        const bIdx = tabOrder.indexOf(bId);
        if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
        if (aIdx >= 0) return -1;
        if (bIdx >= 0) return 1;
      }
      return 0;
    });
  }

  const resolvedTab = !tabs.length ? null : (activeTab && tabs.some(t => getTabId(t) === activeTab))
    ? activeTab
    : getTabId(tabs[0]);
  const activeEntry = tabs.find(t => getTabId(t) === resolvedTab);

  // The shown tab: a lazy kind (`plugin_view`) is fetched only now. Re-run on
  // `sections` too: on a new entity the hook reads that entity's types after
  // this first fires, and only then holds the fetch to start.
  const shownTypeId = activeEntry?.kind === "plugin" ? activeEntry.typeId : null;
  useEffect(() => {
    if (shownTypeId) activate(shownTypeId);
  }, [shownTypeId, entityKey, sections, activate]);

  // ── Tabs that don't fit go behind "More" ──
  // Every tab is laid out once more in a hidden row, at its natural width, and
  // a ResizeObserver reports those widths plus the bar's own. What fits is then
  // decided during render (fitTabs), so the active tab is always on the row.
  const tabsRowRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [measure, setMeasure] = useState<TabMeasure>({ widths: {}, available: 0, more: 0 });
  const tabStateOf = (tab: TabEntry): string | null => {
    // A tab waiting to be shown has nothing in flight: no loading dot.
    const st = tab.kind === "plugin" ? tab.section.state : null;
    return st && !(st.kind === "loading" && st.deferred) ? st.kind : null;
  };
  const tabsKey = tabs.map((t) => `${getTabId(t)}\u0001${t.name}\u0001${tabStateOf(t) ?? ""}`).join("\u0002");
  const rendered = !!activeEntry;
  useEffect(() => {
    const row = tabsRowRef.current;
    const meas = measureRef.current;
    if (!row || !meas || typeof ResizeObserver === "undefined") return;
    const read = () => {
      const widths: Record<string, number> = {};
      let more = 0;
      for (const el of Array.from(meas.children) as HTMLElement[]) {
        const id = el.dataset.measureId;
        const width = el.getBoundingClientRect().width;
        if (id === MORE_MEASURE_ID) more = width;
        else if (id) widths[id] = width;
      }
      const next = { widths, available: Math.max(0, row.clientWidth - REFRESH_RESERVE_PX), more };
      setMeasure((prev) => (sameMeasure(prev, next) ? prev : next));
    };
    const ro = new ResizeObserver(read);
    ro.observe(row);
    for (const el of Array.from(meas.children)) ro.observe(el);
    return () => ro.disconnect();
  }, [tabsKey, rendered]);

  if (!activeEntry) return null;

  const fit = fitTabs({
    ids: tabs.map(getTabId),
    widths: measure.widths,
    available: measure.available,
    moreWidth: measure.more,
    activeId: resolvedTab,
  });
  const overflowIds = new Set(fit.overflow);
  const overflowTabs = tabs.filter((t) => overflowIds.has(getTabId(t)));

  const openMoreMenu = (e: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    showNativeMenu(
      rect.left,
      rect.bottom,
      overflowTabs.map((t) => ({ kind: "item" as const, text: t.name, action: () => setActiveTab(getTabId(t)) })),
    ).catch((err) => console.error("Failed to show the More tabs menu:", err));
  };

  // Extract meta for provider attribution (plugin sections only)
  let meta: { url?: string; providerName?: string; homepageUrl?: string } | undefined;
  if (activeEntry.kind === "plugin") {
    const s = activeEntry.section;
    meta = s.state.kind === "loaded" && s.state.data
      ? (s.state.data as Record<string, unknown>)?._meta as { url?: string; providerName?: string; homepageUrl?: string } | undefined
      : undefined;
  }

  return (
    <div className="information-sections">
      <div className={`info-sections-tabs${measure.available > 0 ? "" : " info-sections-tabs--measuring"}`} ref={tabsRowRef}>
        <div className="info-sections-measure" aria-hidden="true">
          <div className="info-sections-measure-row" ref={measureRef}>
            {/* The label is drawn by ::before from data-label, so these copies
                add no text (or tab nodes) for anything that looks tabs up. */}
            {tabs.map(tab => {
              const tabState = tabStateOf(tab);
              return (
                <div key={getTabId(tab)} data-measure-id={getTabId(tab)} data-label={tab.name} className="info-sections-measure-tab">
                  {(tabState === "loading" || tabState === "loaded") && <span className="info-tab-dot" />}
                </div>
              );
            })}
            <div data-measure-id={MORE_MEASURE_ID} data-label="More" className="info-sections-measure-tab">
              <MoreChevron />
            </div>
          </div>
        </div>
        {tabs.map(tab => {
          const tabId = getTabId(tab);
          if (overflowIds.has(tabId)) return null;
          const tabState = tabStateOf(tab);
          return (
            <div
              key={tabId}
              data-tab-id={tabId}
              className={`info-sections-tab${tabId === resolvedTab ? " active" : ""}${tabState === "empty" ? " empty" : ""}${tabState === "loading" ? " loading" : ""}${tabState === "loaded" ? " has-data" : ""}${draggedTab === tabId ? " dragging" : ""}${dragOverTab === tabId ? " drag-over" : ""}`}
              onClick={() => { if (!didDragTabRef.current) setActiveTab(tabId); }}
              onMouseDown={(e) => handleTabMouseDown(e, tabId)}
              {...(tab.description ? { "data-tooltip": tab.description } : {})}
            >
              {tab.name}
              {tabState === "loading" && <span className="info-tab-dot loading" />}
              {tabState === "loaded" && <span className="info-tab-dot loaded" />}
            </div>
          );
        })}
        {overflowTabs.length > 0 && (
          <div
            className="info-sections-tab info-sections-more"
            role="button"
            tabIndex={0}
            aria-haspopup="menu"
            aria-label={`More tabs (${overflowTabs.length})`}
            title={overflowTabs.map(t => t.name).join(", ")}
            onClick={openMoreMenu}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openMoreMenu(e); }
            }}
          >
            More<MoreChevron />
          </div>
        )}
        {activeEntry.kind === "plugin" && (
          <svg
            className="info-sections-refresh"
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            onClick={() => handleRefresh(activeEntry.typeId, activeEntry.name)}
          >
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        )}
      </div>
      <div className="info-section-content">
        {activeEntry.kind === "custom" ? (
          activeEntry.content
        ) : (() => {
          const s = activeEntry.section;
          if (s.displayKind === "plugin_view" && s.state.kind === "loaded") {
            const providerId = s.state.providerId;
            // Actions go to the plugin that owns the row — the provider key's
            // plugin half, for a plugin offering several (providerKey.ts).
            const ownerId = providerId ? parseProviderKey(providerId).pluginId : undefined;
            // Keyed per entity and type: typed text and other node state must
            // not carry over to the next page, where a Post would send it
            // with that page's entity.
            return (
              <PluginViewSection
                key={`${entityKey}|${s.typeId}`}
                data={s.state.data}
                pluginId={ownerId}
                pluginName={(ownerId && pluginNames?.get(ownerId)) || s.name}
                entity={entity}
              />
            );
          }
          const Renderer = renderers[s.displayKind];
          if (s.displayKind === "lyrics" && lyricsDraft && entity?.kind === "track") {
            const loaded = s.state.kind === "loaded" ? (s.state.data as { text?: string; kind?: string } | null) : null;
            const current: CurrentLyrics =
              // The section has no error state of its own: a chain that failed
              // ends "empty", which reads as no lyrics.
              s.state.kind === "loading" ? { state: "loading" }
                : loaded?.text ? { state: "loaded", text: loaded.text, kind: loaded.kind ?? "plain" }
                  : { state: "none" };
            const draft = lyricsDraft;
            return (
              <LyricsDraftReview
                // Per draft: a re-sent draft for this song replaces the editor.
                key={`${entityKey}|draft|${draft.seq}`}
                draft={draft}
                current={current}
                live={!!rendererContext?.livePosition}
                seek={rendererContext?.seek}
                onSave={(text: string, kind: LyricsKind) => handleAction("save-lyrics", { text, kind }, s.name)}
                onDone={(outcome) => closeLyricsDraft(draft, outcome)}
              />
            );
          }
          return s.state.kind === "loading" ? (
            <div className="info-section-loading">
              <div className="info-section-skeleton" />
              {s.state.progress && s.state.progress.length > 0 && (
                <div className="info-section-progress">
                  {s.state.progress.map((p, i) => (
                    <div key={i} className={`info-progress-entry${p.status === "ok" ? " ok" : p.status === "not_found" || p.status === "error" ? " fail" : ""}`}>
                      <span className="info-progress-provider">{p.provider}</span>
                      {p.url && <span className="info-progress-url">{p.url}</span>}
                      {p.status === "fetching" && <span className="info-progress-status">...</span>}
                      {p.status === "ok" && <span className="info-progress-status">found</span>}
                      {p.status === "not_found" && <span className="info-progress-status">not found</span>}
                      {p.status === "error" && <span className="info-progress-status">error</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : s.state.kind === "loaded" && s.state.data && Renderer ? (
            <Renderer data={s.state.data} onEntityClick={onEntityClick} onAction={(id, p) => handleAction(id, p, s.name)} resolveEntity={resolveEntity} context={rendererContext} onTrackContextMenu={onTrackContextMenu} onEntityContextMenu={onEntityContextMenu} />
          ) : s.state.kind === "empty" && s.displayKind === "lyrics" && entity?.kind === "track" && Renderer ? (
            // No lyrics found: the tab offers to add them (the renderer draws
            // its own empty state) instead of a bare "No data available".
            <Renderer data={null} onAction={(id, p) => handleAction(id, p, s.name)} context={rendererContext} />
          ) : s.state.kind === "empty" ? (
            <div className="info-section-empty">No data available</div>
          ) : null;
        })()}
        {meta?.providerName && (meta?.url ? (
          <a className="info-section-view-on" href="#" onClick={(e) => { e.preventDefault(); openUrl(meta.url!); }}>
            View on {meta.providerName}
          </a>
        ) : (
          <span className="info-section-view-on">
            Source: {meta.homepageUrl ? (
              <a href="#" onClick={(e) => { e.preventDefault(); openUrl(meta!.homepageUrl!); }}>{meta.providerName}</a>
            ) : meta.providerName}
          </span>
        ))}
      </div>
    </div>
  );
}
