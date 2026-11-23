import { ToggleSwitch } from "./ToggleSwitch";
import { renderers } from "./renderers";
import { PluginViewSection } from "./renderers/PluginViewSection";
import { retrieveWantsSuggestions, type RetrieveModalData, type ProviderRow, type ProviderStatus } from "../hooks/useRetrieveModal";
import type { ProviderSuggestion } from "../utils/providerSuggestions";
import { ProviderSuggestionList } from "./ProviderSuggestionList";
import { lyricsFacts } from "../utils/lyricsFacts";
import "./RetrieveModal.css";

interface RetrieveModalProps {
  modal: RetrieveModalData;
  onTryNext: () => void;
  onApplyNow: () => void;
  onCancel: () => void;
  onSetKeepOpen: (keep: boolean) => void;
  /** Plugins that supply this image / information type and aren't helping
   *  now (`utils/providerSuggestions.ts`). Shown only once nothing was found. */
  suggestions?: ProviderSuggestion[] | null;
  /** Opens that plugin's page in Extensions. */
  onShowPlugin?: (pluginId: string) => void;
}

/** What the suggestion block says, by what the chain did. */
function suggestionHeading(modal: RetrieveModalData): string {
  const what = modal.kind === "image"
    ? (modal.entityKind === "album" ? "album art" : `${modal.entityKind} images`)
    : "this information";
  // No rows can also mean an installed plugin's rows are all switched off in
  // Settings → Providers, so don't claim nothing installed provides it.
  if (modal.providers.length === 0) return `No provider for ${what} is switched on. These plugins can supply it:`;
  // One provider asked (Get lyrics ▸ a single source): name it rather than
  // talk about "your providers".
  if (modal.providers.length === 1) {
    const only = modal.providers[0];
    if (only.status === "error") return `${only.name} couldn't be reached. These plugins can look for ${what} too:`;
    if (only.status !== "found") return `${only.name} didn't have it. These plugins can look for ${what} too:`;
  }
  // Something was found and passed over with Try next, so "had nothing" would be untrue.
  if (modal.providers.some((p) => p.status === "found")) return `These plugins can also look for ${what}:`;
  // A provider that errored couldn't look, which is not the same as not having it.
  if (modal.providers.some((p) => p.status === "error")) {
    return `Some of your providers couldn't be reached and none had it. These plugins can look for ${what} too:`;
  }
  return `None of your providers had it. These plugins can look for ${what} too:`;
}

function StatusIcon({ status }: { status: ProviderStatus }) {
  if (status === "found") {
    return (
      <svg className="rm-row-icon rm-row-icon--ok" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  if (status === "not_found" || status === "error") {
    return (
      <svg className="rm-row-icon rm-row-icon--fail" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    );
  }
  if (status === "fetching") return <span className="rm-row-icon rm-row-spinner ds-motion-essential" aria-hidden />;
  return <span className="rm-row-icon rm-row-dot" aria-hidden />;
}

function statusText(status: ProviderStatus): string {
  switch (status) {
    case "fetching": return "searching…";
    case "found": return "found";
    case "not_found": return "not found";
    case "error": return "error";
    default: return "pending";
  }
}

function ProviderChecklist({ providers, currentIndex }: { providers: ProviderRow[]; currentIndex: number }) {
  return (
    <ul className="rm-providers">
      {providers.map((p, i) => (
        <li key={p.id} className={`rm-row rm-row--${p.status}${i === currentIndex ? " rm-row--current" : ""}`}>
          <StatusIcon status={p.status} />
          <span className="rm-row-name">{p.name}</span>
          <span className="rm-row-status">{statusText(p.status)}</span>
        </li>
      ))}
    </ul>
  );
}

/** One value drawn as its tab would draw it: an image, or an info value
 *  through its display kind's renderer. */
function ValueView({ modal, imageSrc, info }: { modal: RetrieveModalData; imageSrc?: string; info?: Record<string, unknown> }) {
  if (modal.kind === "image" && imageSrc) {
    return <div className="rm-preview"><img className="rm-image" src={imageSrc} alt="" /></div>;
  }
  if (modal.kind === "info" && info && modal.displayKind) {
    // An interactive tab, drawn as it will be — with no plugin to route to, so
    // its buttons do nothing in the preview.
    if (modal.displayKind === "plugin_view") {
      return (
        <div className="rm-preview rm-preview--info">
          <PluginViewSection data={info} pluginId={undefined} pluginName={modal.label} entity={null} />
        </div>
      );
    }
    const Renderer = renderers[modal.displayKind];
    // A `get` of lyrics says what each copy is beside its words: where it came
    // from, which song and cut the source filed it under, how far its timing
    // runs — so Replace isn't decided on the words alone.
    const facts = modal.mode === "get" && modal.displayKind === "lyrics"
      ? lyricsFacts(info, { title: modal.name, artist: modal.artistName, album: modal.albumTitle, durationSecs: modal.entityDurationSecs })
      : [];
    if (Renderer && facts.length) {
      return (
        <>
          <dl className="rm-facts">
            {facts.map((f) => (
              <div key={f.label} className={`rm-fact${f.differs ? " rm-fact--differs" : ""}`} title={f.hint}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
          <div className="rm-preview rm-preview--info"><Renderer data={info} context={{ showTimes: true }} /></div>
        </>
      );
    }
    // Lyrics show their line times: when comparing two copies, the timing is
    // often the only thing that differs.
    if (Renderer) return <div className="rm-preview rm-preview--info"><Renderer data={info} context={{ showTimes: true }} /></div>;
    return <div className="rm-preview rm-preview--info"><pre className="rm-json">{JSON.stringify(info, null, 2)}</pre></div>;
  }
  return null;
}

function Preview({ modal }: { modal: RetrieveModalData }) {
  const found = <ValueView modal={modal} imageSrc={modal.imagePreview?.src} info={modal.infoPreview} />;
  // A `get` shows what it would replace beside the new value, so Replace is a
  // decision made with both in view.
  if (modal.mode === "get" && modal.current?.status === "ok") {
    const source = modal.providers[modal.currentIndex]?.name ?? "the provider";
    return (
      <div className="rm-compare">
        <div className="rm-compare-col">
          <div className="rm-compare-label">Current</div>
          <ValueView modal={modal} imageSrc={modal.current.imageSrc} info={modal.current.info} />
        </div>
        <div className="rm-compare-col">
          <div className="rm-compare-label">From {source}</div>
          {found}
        </div>
      </div>
    );
  }
  return found;
}

/** The apply button's words: a `get` says whether it adds or replaces. */
export function applyLabel(modal: RetrieveModalData): string {
  if (modal.mode === "get") return modal.current?.status === "ok" ? "Replace" : "Add";
  return modal.countdown != null ? `Apply now (${modal.countdown})` : "Apply";
}

/**
 * Centered modal for user-triggered image & info retrieval. The provider chain
 * runs automatically (auto-fallback); each provider shows as a checklist row.
 * When a provider returns a result the chain pauses, previews it, and a grace
 * countdown auto-applies unless the user picks "Try next" or toggles Keep open.
 * No overlay-click dismiss (per app modal rules).
 */
export function RetrieveModal({
  modal, onTryNext, onApplyNow, onCancel, onSetKeepOpen, suggestions, onShowPlugin,
}: RetrieveModalProps) {
  const { phase } = modal;
  // Same test the hook's hold-open check uses, so a held-open modal always has
  // suggestions on it. A result the user passed over with Try next doesn't
  // count against them: the chain still came back with nothing applied.
  const showSuggestions = retrieveWantsSuggestions(modal) && !!suggestions?.length && !!onShowPlugin;
  const paused = phase === "paused";
  const busy = phase === "running" || phase === "applying";
  const applied = phase === "applied";
  const isGet = modal.mode === "get";
  // Replace can't be offered until we know what it would replace.
  const currentPending = isGet && modal.current?.status === "loading";

  const statusLine = (() => {
    if (phase === "running") return `Searching ${modal.providers[modal.currentIndex]?.name ?? ""}…`;
    if (phase === "applying") return "Applying…";
    if (phase === "applied") return "✓ Applied";
    if (phase === "exhausted") return modal.message ?? "No result found";
    if (phase === "paused") {
      const name = modal.providers[modal.currentIndex]?.name ?? "a provider";
      return modal.countdown != null
        ? `Found via ${name} · applying in ${modal.countdown}s…`
        : `Found via ${name}`;
    }
    return "";
  })();

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal ds-modal--lg rm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ds-modal-title">{modal.label}</div>
        <div className="rm-subtitle" title={modal.title}>{modal.title}</div>

        <ProviderChecklist providers={modal.providers} currentIndex={modal.currentIndex} />

        {(paused || applied) && <Preview modal={modal} />}

        <div className={`rm-statusline rm-statusline--${phase}`}>{statusLine}</div>

        {showSuggestions && suggestions && onShowPlugin && (
          <ProviderSuggestionList
            heading={suggestionHeading(modal)}
            plugins={suggestions}
            onShowPlugin={onShowPlugin}
            note="Once one is on, it joins Settings → Providers; then retrieve again."
          />
        )}

        {!applied && !isGet && (
          <label className="rm-keepopen">
            <ToggleSwitch checked={modal.keepOpen} onChange={onSetKeepOpen} />
            <span className="rm-keepopen-label">Keep open (don’t auto-close)</span>
          </label>
        )}

        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onCancel}>
            {applied ? "Close" : isGet && paused && modal.current?.status === "ok" ? "Keep current" : "Cancel"}
          </button>
          {paused && (
            <button className="ds-btn ds-btn--secondary" onClick={onTryNext} disabled={modal.currentIndex >= modal.providers.length - 1}>
              Try next
            </button>
          )}
          {paused && (
            <button className="ds-btn ds-btn--primary" onClick={onApplyNow} disabled={currentPending}>
              {applyLabel(modal)}
            </button>
          )}
          {busy && (
            <button className="ds-btn ds-btn--primary" disabled>
              <span className="ds-spinner ds-spinner--sm" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
