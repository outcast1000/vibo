import { useCallback, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { InfoEntity, InfoFetchResult, DisplayKind } from "../types/informationTypes";
import { buildEntityKey } from "../types/informationTypes";
import type { ImageFetchResult } from "../types/plugin";
import {
  coreProviderSupports,
  fetchCoreImageProvider,
  imageProviderName,
  isCoreImageProvider,
} from "../utils/coreImageProviders";

import { saveSongLyrics } from "../utils/localLyrics";
import { useAssignRef, useLatestRef } from "./useLatestRef";
// Centered, cancelable "Retrieve" modal for user-triggered image & info fetches.
//
// Model (matches how the background chain already works, but visible + pausable):
//   - The modal runs the provider chain AUTOMATICALLY (auto-fallback). Each
//     provider is shown as a checklist row that ticks pending → fetching →
//     found / not found / error.
//   - When a provider returns a result the chain PAUSES, previews it, and starts
//     a grace countdown. Do nothing → it auto-applies & closes. "Try next"
//     rejects this result and resumes the chain at the next provider. "Apply now"
//     commits immediately. "Keep open" cancels the countdown so it waits.
//   - If every provider is exhausted with nothing usable → an "exhausted" state
//     with a close countdown (also defeatable via Keep open).
//
// Nothing is persisted until apply (auto or manual). A monotonic `genRef` stale-
// guards in-flight fetches across try-next / cancel / close.

const GRACE_SECS = 10;       // paused-with-result → auto-apply
const EXHAUSTED_SECS = 10;   // all providers failed → auto-close
const APPLIED_CLOSE_MS = 1400; // show "✓ Applied" briefly, then close

export type ProviderStatus = "pending" | "fetching" | "found" | "not_found" | "error";

/** What the modal says once the chain ran out. A single-provider run (Get
 *  lyrics from one plugin) names that provider: "from any provider" was
 *  untrue when only one was asked. */
export function exhaustedMessage(providers: ProviderRow[]): string {
  if (providers.length === 1) {
    const p = providers[0];
    return p.status === "error" ? `Couldn't reach ${p.name}` : `${p.name} found nothing`;
  }
  return "No result found from any provider";
}

export interface ProviderRow {
  id: string;
  name: string;
  pluginId?: string;
  integerId?: number;   // info: type integer id to upsert against
  coreId?: string;      // built-in image provider (folder art / embedded artwork)
  status: ProviderStatus;
}

/** A fetched-but-not-yet-saved image, ready to preview + apply. */
export interface ImagePreview {
  src: string;
  save:
    | { kind: "url"; url: string; headers?: Record<string, string> }
    | { kind: "data"; data: string }
    // A built-in provider already wrote a temp copy; apply just files it.
    | { kind: "path"; path: string };
}

export type RetrievePhase =
  | "running"    // walking the chain, no result yet to show
  | "paused"     // a provider returned a result; previewing + grace countdown
  | "applying"   // committing the chosen result
  | "applied"    // done
  | "exhausted"; // all providers tried, nothing usable

/** What the entity has now, shown beside a "get" result so the user can tell
 *  Add from Replace. */
export type RetrieveCurrent =
  | { status: "loading" }
  | { status: "none" }
  | { status: "ok"; imageSrc?: string; info?: Record<string, unknown> };

export interface RetrieveModalData {
  kind: "image" | "info";
  /** `retrieve`: the detail pages' refresh — a found result applies itself
   *  after a countdown. `get`: the menus' Get lyrics / Get image — nothing is
   *  applied or closed without the user's click, and the current value is
   *  shown next to the new one (Add, or Replace / Keep current). Absent = `retrieve`. */
  mode?: "retrieve" | "get";
  current?: RetrieveCurrent;
  label: string;
  title: string;
  entityKind: "artist" | "album" | "tag" | "track";
  name: string;
  artistName?: string | null;
  albumTitle?: string | null;
  /** A track's file, as a hint for lyrics lookups and saves (not part of its key). */
  entityPath?: string | null;
  displayKind?: DisplayKind;
  infoTypeId?: string;
  providers: ProviderRow[];
  currentIndex: number;
  phase: RetrievePhase;
  imagePreview?: ImagePreview;
  infoPreview?: Record<string, unknown>;
  /** Seconds left in the active countdown, or null when none is running. */
  countdown: number | null;
  keepOpen: boolean;
  message?: string;
  /** "exhausted" because saving the chosen result failed, not because no
   *  provider found one — there is nothing to suggest then. */
  applyFailed?: boolean;
}

/** Whether plugin suggestions belong on this modal: the chain came back
 *  without anything to apply. The modal (what it shows) and the hold-open
 *  check (whether it waits) both ask this, so they can't disagree. */
export function retrieveWantsSuggestions(m: RetrieveModalData): boolean {
  return m.phase === "exhausted" && !m.applyFailed;
}

type InvokeInfoFetch = (
  pluginId: string, infoTypeId: string, entity: InfoEntity, onFetchUrl?: (url: string) => void,
) => Promise<InfoFetchResult>;
type InvokeImageFetch = (
  pluginId: string, entity: "artist" | "album" | "tag", name: string, artistName?: string,
) => Promise<ImageFetchResult>;

export interface OpenImageArgs {
  kind: "artist" | "album" | "tag";
  name: string;
  artistName?: string | null;
  providers: Array<[string, number, number]>; // [pluginId, priority, integerId]
  pluginNames: Map<string, string>;
  /** Defaults to `retrieve`; see `RetrieveModalData.mode`. */
  mode?: "retrieve" | "get";
  /** Ask only this provider (its key as it appears in `providers`). */
  onlyProvider?: string | null;
  /** `get` mode: the entity's image now, as an `<img src>`, or null for none. */
  currentImageSrc?: string | null;
}
export interface OpenInfoArgs {
  infoTypeId: string;
  label: string;
  displayKind: DisplayKind;
  entity: InfoEntity;
  providers: Array<[string, number]>; // [pluginId, integerId]
  pluginNames: Map<string, string>;
  /** Defaults to `retrieve`; see `RetrieveModalData.mode`. */
  mode?: "retrieve" | "get";
  /** Ask only this provider (its key as it appears in `providers`). */
  onlyProvider?: string | null;
}

/** The lyrics an apply should save through `saveSongLyrics`, or null when the
 *  result is not a song's lyrics (any other info type keeps the cache write). */
export function lyricsToSave(m: Pick<RetrieveModalData, "kind" | "infoTypeId" | "entityKind" | "infoPreview">): { text: string; kind: string } | null {
  if (m.kind !== "info" || m.infoTypeId !== "lyrics" || m.entityKind !== "track") return null;
  const text = m.infoPreview?.text;
  if (typeof text !== "string" || !text.trim()) return null;
  const kind = m.infoPreview?.kind === "synced" ? "synced" : "plain";
  return { text, kind };
}

/** Keep only `only` when it is given and present; otherwise every row. */
export function pickProviders<T>(rows: T[], keyOf: (row: T) => string, only: string | null | undefined): T[] {
  if (!only) return rows;
  return rows.filter((r) => keyOf(r) === only);
}

/** The cached value a `get` for this info type would replace, from the rows
 *  `info_get_values_for_entity` returns ([integer_id, type_id, value, status, fetched_at]). */
export function currentInfoFromRows(rows: Array<[number, string, string, string, number]>, typeId: string): RetrieveCurrent {
  const row = rows.find(([, t, , status]) => t === typeId && status === "ok");
  if (!row) return { status: "none" };
  try {
    const info = JSON.parse(row[2]) as Record<string, unknown>;
    // A lyrics row with no text is "nothing yet" to the user, not something to replace.
    if (typeId === "lyrics" && !(typeof info?.text === "string" && info.text.trim())) return { status: "none" };
    return { status: "ok", info };
  } catch (e) {
    console.error("Unreadable cached info value:", e);
    return { status: "none" };
  }
}

export interface UseRetrieveModalReturn {
  modal: RetrieveModalData | null;
  openImage: (args: OpenImageArgs) => void;
  openInfo: (args: OpenInfoArgs) => void;
  tryNext: () => void;
  applyNow: () => void;
  cancel: () => void;
  setKeepOpen: (keep: boolean) => void;
}

function entityTitle(name: string, artistName?: string | null): string {
  return artistName ? `${name} · ${artistName}` : name;
}
function imageLabel(kind: "artist" | "album" | "tag", mode: "retrieve" | "get"): string {
  const verb = mode === "get" ? "Get" : "Retrieve";
  if (kind === "album") return `${verb} album art`;
  if (kind === "artist") return `${verb} artist image`;
  return `${verb} tag image`;
}

interface FetchOutcome {
  ok: boolean;
  status: ProviderStatus;
  imagePreview?: ImagePreview;
  infoPreview?: Record<string, unknown>;
}

export function useRetrieveModal(
  invokeImageFetch: InvokeImageFetch,
  invokeInfoFetch: InvokeInfoFetch,
  opts?: {
    /** True when the exhausted modal has something left to read (plugin
     *  suggestions): it then waits for the user instead of auto-closing. */
    holdOpenWhenExhausted?: (m: RetrieveModalData) => boolean;
  },
): UseRetrieveModalReturn {
  const holdOpenRef = useLatestRef(opts?.holdOpenWhenExhausted);
  const [modal, setModal] = useState<RetrieveModalData | null>(null);
  const modalRef = useRef<RetrieveModalData | null>(null);
  useAssignRef(modalRef, modal);

  const genRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const appliedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What the active countdown does when it hits 0.
  const countdownModeRef = useRef<"apply" | "close" | null>(null);
  // Forward refs so the countdown tick can call the latest closures.
  const applyNowRef = useRef<() => void>(() => {});
  const closeRef = useRef<() => void>(() => {});

  const clearTick = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    countdownModeRef.current = null;
  }, []);

  const clearAppliedTimer = useCallback(() => {
    if (appliedTimerRef.current) { clearTimeout(appliedTimerRef.current); appliedTimerRef.current = null; }
  }, []);

  const close = useCallback(() => {
    genRef.current++;
    clearTick();
    clearAppliedTimer();
    setModal(null);
  }, [clearTick, clearAppliedTimer]);
  useAssignRef(closeRef, close);

  // `userArmed`: the user switched Keep open back off, asking for the close —
  // the suggestions hold below must not take that back on the next tick.
  const startCountdown = useCallback((seconds: number, mode: "apply" | "close", userArmed = false) => {
    clearTick();
    countdownModeRef.current = mode;
    setModal((m) => m && { ...m, countdown: seconds });
    tickRef.current = setInterval(() => {
      setModal((m) => {
        if (!m) return m;
        // Suggestions can land after the chain ran out (the gallery index is
        // fetched alongside it): stop closing once there is something to read.
        if (mode === "close" && !userArmed && retrieveWantsSuggestions(m) && holdOpenRef.current?.(m)) {
          clearTick();
          return { ...m, countdown: null };
        }
        const next = (m.countdown ?? 0) - 1;
        if (next <= 0) {
          clearTick();
          const fire = mode;
          queueMicrotask(() => { if (fire === "apply") applyNowRef.current(); else closeRef.current(); });
          return { ...m, countdown: 0 };
        }
        return { ...m, countdown: next };
      });
    }, 1000);
  }, [clearTick, holdOpenRef]);

  // ── Single-provider fetch ─────────────────────────────────
  const fetchProvider = useCallback(async (data: RetrieveModalData, provider: ProviderRow, gen: number): Promise<FetchOutcome> => {
    try {
      if (data.kind === "image") {
        const k = data.entityKind as "artist" | "album" | "tag";
        if (provider.coreId) {
          const path = await fetchCoreImageProvider(provider.coreId, k, data.name, data.artistName);
          if (gen !== genRef.current) return { ok: false, status: "error" };
          return {
            ok: true,
            status: "found",
            imagePreview: { src: `${convertFileSrc(path)}#g=${gen}`, save: { kind: "path", path } },
          };
        }
        const result = await invokeImageFetch(provider.pluginId!, k, data.name, data.artistName ?? undefined);
        if (gen !== genRef.current) return { ok: false, status: "error" };
        if (result.status === "ok") {
          if ("data" in result) return { ok: true, status: "found", imagePreview: { src: `data:image/*;base64,${result.data}`, save: { kind: "data", data: result.data } } };
          return { ok: true, status: "found", imagePreview: { src: result.url, save: { kind: "url", url: result.url, headers: result.headers } } };
        }
        return { ok: false, status: result.status === "not_found" ? "not_found" : "error" };
      } else {
        const entity: InfoEntity = {
          kind: data.entityKind, name: data.name, id: 0,
          artistName: data.artistName ?? undefined, albumTitle: data.albumTitle ?? undefined, path: data.entityPath ?? undefined,
        };
        const result = await invokeInfoFetch(provider.pluginId!, data.infoTypeId!, entity);
        if (gen !== genRef.current) return { ok: false, status: "error" };
        if (result.status === "ok") return { ok: true, status: "found", infoPreview: result.value };
        return { ok: false, status: result.status === "not_found" ? "not_found" : "error" };
      }
    } catch (e) {
      console.error("Retrieve provider fetch failed:", e);
      return { ok: false, status: "error" };
    }
  }, [invokeImageFetch, invokeInfoFetch]);

  const setProviderStatus = useCallback((index: number, status: ProviderStatus, gen: number) => {
    setModal((m) => {
      if (!m || gen !== genRef.current) return m;
      return { ...m, providers: m.providers.map((p, i) => (i === index ? { ...p, status } : p)) };
    });
  }, []);

  // ── Chain walker ──────────────────────────────────────────
  const advanceChain = useCallback(async (data: RetrieveModalData, startIndex: number, gen: number) => {
    for (let i = startIndex; i < data.providers.length; i++) {
      if (gen !== genRef.current) return;
      setModal((m) => m && { ...m, currentIndex: i, phase: "running", countdown: null });
      setProviderStatus(i, "fetching", gen);
      const outcome = await fetchProvider(data, data.providers[i], gen);
      if (gen !== genRef.current) return;
      setProviderStatus(i, outcome.status, gen);
      if (outcome.ok) {
        setModal((m) => m && {
          ...m,
          currentIndex: i,
          phase: "paused",
          imagePreview: outcome.imagePreview,
          infoPreview: outcome.infoPreview,
        });
        const keepOpen = modalRef.current?.keepOpen ?? false;
        // A `get` waits for Add / Replace: it is never applied for the user.
        if (keepOpen || data.mode === "get") setModal((m) => m && { ...m, countdown: null });
        else startCountdown(GRACE_SECS, "apply");
        return;
      }
    }
    // Exhausted — nothing usable from any provider.
    if (gen !== genRef.current) return;
    setModal((m) => m && { ...m, phase: "exhausted", imagePreview: undefined, infoPreview: undefined, message: exhaustedMessage(data.providers) });
    const keepOpen = modalRef.current?.keepOpen ?? false;
    // From `data`, not modalRef: a provider that answers before the first
    // commit leaves the ref unset, and the predicate only needs what is being
    // retrieved (kind / entity / info type), which `data` carries.
    const hold = !!holdOpenRef.current?.({ ...data, phase: "exhausted" });
    if (keepOpen || hold || data.mode === "get") setModal((m) => m && { ...m, countdown: null });
    else startCountdown(EXHAUSTED_SECS, "close");
  }, [fetchProvider, setProviderStatus, startCountdown, holdOpenRef]);

  // ── Public openers ────────────────────────────────────────
  const openImage = useCallback((args: OpenImageArgs) => {
    // The built-in providers arrive inside `args.providers` (they're rows in
    // the same ordered table), so the modal walks them wherever the user put
    // them. Embedded artwork used to be unshifted onto the front here — the
    // frontend half of the "always first" policy that no longer exists.
    const mode = args.mode ?? "retrieve";
    const providers: ProviderRow[] = [];
    for (const [providerId, , integerId] of pickProviders(args.providers, (r) => r[0], args.onlyProvider)) {
      const name = imageProviderName(providerId, args.pluginNames, "long");
      if (isCoreImageProvider(providerId)) {
        if (!coreProviderSupports(providerId, args.kind)) continue;
        providers.push({ id: providerId, name, coreId: providerId, status: "pending" });
      } else {
        providers.push({ id: providerId, name, pluginId: providerId, integerId, status: "pending" });
      }
    }
    const data: RetrieveModalData = {
      kind: "image",
      mode,
      current: mode === "get" ? (args.currentImageSrc ? { status: "ok", imageSrc: args.currentImageSrc } : { status: "none" }) : undefined,
      label: imageLabel(args.kind, mode),
      title: entityTitle(args.name, args.kind === "album" ? args.artistName : null),
      entityKind: args.kind, name: args.name, artistName: args.artistName ?? null,
      providers, currentIndex: 0,
      phase: providers.length ? "running" : "exhausted",
      countdown: null, keepOpen: false,
      message: providers.length ? undefined : "No image providers enabled",
    };
    const gen = ++genRef.current;
    clearTick(); clearAppliedTimer();
    setModal(data);
    if (providers.length) void advanceChain(data, 0, gen);
  }, [advanceChain, clearTick, clearAppliedTimer]);

  const openInfo = useCallback((args: OpenInfoArgs) => {
    const mode = args.mode ?? "retrieve";
    const providers: ProviderRow[] = pickProviders(args.providers, (r) => r[0], args.onlyProvider).map(([pluginId, integerId]) => ({
      id: pluginId, name: args.pluginNames.get(pluginId) ?? pluginId, pluginId, integerId, status: "pending",
    }));
    const data: RetrieveModalData = {
      kind: "info",
      mode,
      current: mode === "get" ? { status: "loading" } : undefined,
      label: `${mode === "get" ? "Get" : "Retrieve"} ${args.label}`,
      title: entityTitle(args.entity.name, args.entity.artistName ?? null),
      entityKind: args.entity.kind, name: args.entity.name,
      artistName: args.entity.artistName ?? null, albumTitle: args.entity.albumTitle ?? null, entityPath: args.entity.path ?? null,
      displayKind: args.displayKind, infoTypeId: args.infoTypeId,
      providers, currentIndex: 0,
      phase: providers.length ? "running" : "exhausted",
      countdown: null, keepOpen: false,
      message: providers.length ? undefined : "No providers for this information",
    };
    const gen = ++genRef.current;
    clearTick(); clearAppliedTimer();
    setModal(data);
    if (mode === "get") {
      // What a Replace would replace: the cached value, read once (no fetch).
      invoke<Array<[number, string, string, string, number]>>("info_get_values_for_entity", { entityKey: buildEntityKey(args.entity) })
        .then((rows) => currentInfoFromRows(rows, args.infoTypeId))
        .catch((e) => { console.error("Failed to read the current value:", e); return { status: "none" } as RetrieveCurrent; })
        .then((current) => setModal((m) => (m && gen === genRef.current ? { ...m, current } : m)));
    }
    if (providers.length) void advanceChain(data, 0, gen);
  }, [advanceChain, clearTick, clearAppliedTimer]);

  // ── Try next (reject current, resume chain) ───────────────
  const tryNext = useCallback(() => {
    const m = modalRef.current;
    if (!m || m.phase !== "paused") return;
    clearTick();
    const gen = ++genRef.current;
    void advanceChain({ ...m, countdown: null }, m.currentIndex + 1, gen);
  }, [clearTick, advanceChain]);

  // ── Apply (persist current paused result) ─────────────────
  const applyNow = useCallback(() => {
    const m = modalRef.current;
    if (!m || m.phase !== "paused") return;
    clearTick();
    const gen = ++genRef.current;
    setModal((cur) => cur && { ...cur, phase: "applying", countdown: null });
    void (async () => {
      try {
        if (m.kind === "image" && m.imagePreview) {
          const save = m.imagePreview.save;
          if (save.kind === "path") {
            await invoke("set_entity_image", { kind: m.entityKind, name: m.name, artistName: m.artistName ?? null, sourcePath: save.path });
          } else {
            await invoke("save_entity_image_from_provider", {
              kind: m.entityKind, name: m.name, artistName: m.artistName ?? null,
              url: save.kind === "url" ? save.url : null,
              headers: save.kind === "url" ? (save.headers ?? null) : null,
              data: save.kind === "data" ? save.data : null,
            });
          }
          window.dispatchEvent(new CustomEvent("retrieve:image-applied", {
            detail: { kind: m.entityKind, name: m.name, artistName: m.artistName ?? null },
          }));
        } else if (m.kind === "info" && m.infoPreview) {
          const provider = m.providers[m.currentIndex];
          const entity: InfoEntity = {
            kind: m.entityKind, name: m.name, id: 0,
            artistName: m.artistName ?? undefined, albumTitle: m.albumTitle ?? undefined, path: m.entityPath ?? undefined,
          };
          const lyrics = lyricsToSave(m);
          if (lyrics) {
            // Song lyrics are saved like the lyrics editor saves them: into the
            // song's files when a library copy is on disk, else the cache. A
            // cache-only row would be lost on the next re-read of the files.
            await saveSongLyrics(entity, lyrics.text, lyrics.kind, "provider", { provider: provider?.pluginId ?? null });
          } else {
            await invoke("info_upsert_value", {
              informationTypeId: provider?.integerId ?? 0,
              entityKey: buildEntityKey(entity),
              value: JSON.stringify(m.infoPreview),
              status: "ok",
            });
          }
          window.dispatchEvent(new CustomEvent("retrieve:info-applied", {
            detail: { infoTypeId: m.infoTypeId, entityKey: buildEntityKey(entity) },
          }));
        }
        if (gen !== genRef.current) return;
        setModal((cur) => cur && { ...cur, phase: "applied", message: "Applied", countdown: null });
        appliedTimerRef.current = setTimeout(() => closeRef.current(), APPLIED_CLOSE_MS);
      } catch (e) {
        if (gen !== genRef.current) return;
        console.error("Retrieve apply failed:", e);
        setModal((cur) => cur && { ...cur, phase: "exhausted", applyFailed: true, message: e instanceof Error ? e.message : String(e), countdown: null });
      }
    })();
  }, [clearTick]);
  useAssignRef(applyNowRef, applyNow);

  const setKeepOpen = useCallback((keep: boolean) => {
    setModal((m) => {
      if (!m) return m;
      if (keep) {
        clearTick();
        return { ...m, keepOpen: true, countdown: null };
      }
      // A `get` has no countdowns to re-arm (the modal doesn't offer the switch).
      if (m.mode === "get") return { ...m, keepOpen: false };
      // Re-arm the appropriate countdown for the current phase.
      if (m.phase === "paused") startCountdown(GRACE_SECS, "apply");
      else if (m.phase === "exhausted") startCountdown(EXHAUSTED_SECS, "close", true);
      return { ...m, keepOpen: false };
    });
  }, [clearTick, startCountdown]);

  return { modal, openImage, openInfo, tryNext, applyNow, cancel: close, setKeepOpen };
}
