// Opt-in automatic updates for managed tools — the frontend half.
//
// Rust decides and enforces (`src-tauri/src/tool_auto_update.rs`): whether a
// tool may update itself at all, whether it is switched on, and every
// guardrail around the install. What lives here is presentation and the one
// rule Rust doesn't need to know: when to *offer* the switch from the update
// notice. All pure, so it's asserted without a store or a render.

/** Why Rust refuses a tool's automatic updates (`tool_auto_update::Ineligible`). */
export type AutoUpdateIneligible = "not-managed" | "not-vibos-copy" | "unverified" | "source-mismatch" | "service";

/** One tool's auto-update state (`tool_auto_update_get`). */
export interface ToolAutoUpdateState {
  name: string;
  enabled: boolean;
  offerDeclined: boolean;
  lastAttemptAt?: number | null;
  consecutiveFailures: number;
  lastInstall?: { from?: string | null; to: string; at: number } | null;
  lastError?: string | null;
  disabledByFailures: boolean;
  ineligible?: AutoUpdateIneligible | null;
  ineligibleMessage?: string | null;
}

/** What one automatic attempt did (`dependency_auto_install`). */
export type AutoInstallOutcome =
  | { status: "installed"; from?: string | null; to: string; restartErrors: string[] }
  | { status: "skipped"; reason: string; retryLater: boolean }
  | { status: "failed"; error: string; switchedOff: boolean };

/**
 * The attempt got as far as downloading, so the progress row it drew is its
 * own to clear: an install that landed or failed, or one whose verified
 * download was thrown away because the tool was in use at swap time. Every
 * other skip downloaded nothing — and `busy` means the progress row on screen
 * is the user's own install's.
 */
export function autoAttemptDownloaded(outcome: AutoInstallOutcome): boolean {
  return outcome.status !== "skipped" || outcome.reason === "in-use";
}

/** Name → the latest versions the update notice saw announced, with when. */
export type ToolUpdateSightings = Record<string, { version: string; at: number }[]>;

/** The offer appears once a tool has been announced this many times… */
export const AUTO_UPDATE_OFFER_MIN_SIGHTINGS = 3;
/** …with distinct versions, inside this window. */
export const AUTO_UPDATE_OFFER_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** A tool that was running when its automatic update came due is asked again after this. */
export const AUTO_UPDATE_IN_USE_RETRY_MS = 10 * 60 * 1000;

/**
 * The tool updates the notice announces: outdated copies Vibo installed from
 * the source in force, minus every tool the user let update itself — that
 * one isn't theirs to click. A running background program is marked, since
 * its update restarts it.
 */
export function announcedToolUpdates(
  updates: { name: string; installed?: string; latest?: string; outdated: boolean; origin?: string | null; sourceMismatch?: boolean }[],
  autoUpdate: Record<string, ToolAutoUpdateState>,
  isRunning: (name: string) => boolean,
): { name: string; installed?: string; latest: string; running: boolean }[] {
  return updates
    .filter((u) => u.outdated && u.origin === "managed" && !!u.latest && !u.sourceMismatch)
    .filter((u) => !autoUpdates(autoUpdate[u.name]))
    .map((u) => ({ name: u.name, installed: u.installed, latest: u.latest!, running: isRunning(u.name) }));
}

/** The stored sightings, keeping only well-formed entries. */
export function coerceToolSightings(raw: unknown): ToolUpdateSightings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ToolUpdateSightings = {};
  for (const [name, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const ok = list.filter(
      (s): s is { version: string; at: number } =>
        !!s && typeof s === "object" && typeof (s as { version?: unknown }).version === "string" &&
        typeof (s as { at?: unknown }).at === "number",
    );
    if (ok.length > 0) out[name] = ok;
  }
  return out;
}

/** Switched on and allowed:Rust installs its updates, so the notice leaves it out. */
export function autoUpdates(state: ToolAutoUpdateState | undefined): boolean {
  return !!state && state.enabled && !state.ineligible;
}

/**
 * Remember which versions were announced. One entry per distinct version — a
 * notice re-rendered a hundred times is still one announcement — and nothing
 * older than the offer window is kept. Returns the previous object when
 * nothing changed, so the persist effect doesn't write the store on a repeat.
 */
export function recordToolSightings(
  prev: ToolUpdateSightings,
  announced: { name: string; latest: string }[],
  now: number,
): ToolUpdateSightings {
  let next = prev;
  for (const { name, latest } of announced) {
    const seen = (next[name] ?? []).filter((s) => now - s.at < AUTO_UPDATE_OFFER_WINDOW_MS);
    const known = seen.some((s) => s.version === latest);
    const pruned = seen.length !== (next[name] ?? []).length;
    if (known && !pruned) continue;
    next = { ...next, [name]: known ? seen : [...seen, { version: latest, at: now }] };
  }
  return next;
}

/**
 * The tool the notice should offer automatic updates for, if any: announced
 * now, announced often lately, allowed, not already on, and not declined. One
 * at a time — the notice is one line.
 */
export function pickAutoUpdateOffer(
  announced: { name: string }[],
  sightings: ToolUpdateSightings,
  states: Record<string, ToolAutoUpdateState>,
  now: number,
): string | null {
  for (const { name } of announced) {
    const state = states[name];
    if (!state || state.enabled || state.offerDeclined || state.ineligible) continue;
    const recent = (sightings[name] ?? []).filter((s) => now - s.at < AUTO_UPDATE_OFFER_WINDOW_MS);
    if (new Set(recent.map((s) => s.version)).size >= AUTO_UPDATE_OFFER_MIN_SIGHTINGS) return name;
  }
  return null;
}

/**
 * The Tools row's status line about automatic updates, or null for nothing
 * to say. A failure outranks a success: it is what the user has to act on.
 */
export function autoUpdateStatusLine(
  state: ToolAutoUpdateState | undefined,
  formatDate: (unixSecs: number) => string = (s) => new Date(s * 1000).toLocaleString(),
): { tone: "error" | "info"; text: string } | null {
  if (!state) return null;
  if (state.disabledByFailures) {
    return {
      tone: "error",
      text: `Automatic updates were turned off after ${state.consecutiveFailures} failed attempts${
        state.lastError ? `: ${state.lastError}` : ""
      }. Updates are announced again.`,
    };
  }
  if (state.enabled && state.lastError) {
    return { tone: "error", text: `The last automatic update failed: ${state.lastError}. It will try again tomorrow.` };
  }
  if (state.lastInstall) {
    const { from, to, at } = state.lastInstall;
    return { tone: "info", text: `Updated automatically ${from ? `${from} → ` : "to "}${to} · ${formatDate(at)}` };
  }
  return null;
}
