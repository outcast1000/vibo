import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../nativeMenu", () => ({ showNativeMenu: vi.fn() }));

const { buildTextEditMenuSpecs } = await import("../utils/textEditMenu");

const actions = () => ({ cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn() });
const labels = (specs: ReturnType<typeof buildTextEditMenuSpecs>) =>
  (specs ?? []).map((s) => (s.kind === "separator" ? "—" : `${s.text}${s.kind === "item" && s.enabled === false ? " (off)" : ""}`));

describe("buildTextEditMenuSpecs", () => {
  it("a text field gets Cut / Copy / Paste / Select All, cut and copy only with a selection", () => {
    expect(labels(buildTextEditMenuSpecs({ editable: true, hasSelection: true, secret: false, hasText: true }, actions())))
      .toEqual(["Cut", "Copy", "Paste", "—", "Select All"]);
    expect(labels(buildTextEditMenuSpecs({ editable: true, hasSelection: false, secret: false, hasText: false }, actions())))
      .toEqual(["Cut (off)", "Copy (off)", "Paste", "—", "Select All (off)"]);
  });

  it("a password field never copies its text out", () => {
    expect(labels(buildTextEditMenuSpecs({ editable: true, hasSelection: true, secret: true, hasText: true }, actions())))
      .toEqual(["Cut (off)", "Copy (off)", "Paste", "—", "Select All"]);
  });

  it("page text offers Copy only when something is selected", () => {
    expect(labels(buildTextEditMenuSpecs({ editable: false, hasSelection: true, secret: false, hasText: true }, actions()))).toEqual(["Copy"]);
    expect(buildTextEditMenuSpecs({ editable: false, hasSelection: false, secret: false, hasText: true }, actions())).toBeNull();
  });

  it("each item runs its own action", () => {
    const a = actions();
    const specs = buildTextEditMenuSpecs({ editable: true, hasSelection: true, secret: false, hasText: true }, a) ?? [];
    for (const s of specs) if (s.kind === "item") s.action();
    expect([a.cut, a.copy, a.paste, a.selectAll].every((f) => f.mock.calls.length === 1)).toBe(true);
  });
});
