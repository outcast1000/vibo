// The text context menu — Cut / Copy / Paste / Select All on a right-click in
// a text field, Copy on selected text anywhere else. App suppresses the
// webview's own context menu everywhere (it would offer Reload and Inspect),
// which also took these away from every input; this puts them back as a
// native menu (conventions.md "Native Menus Only").
//
// Clipboard access goes through the backend (`read_clipboard_text` /
// `write_clipboard_text`): a native-menu action isn't a user gesture, and the
// webview's clipboard API can refuse outside one.
import { invoke } from "@tauri-apps/api/core";
import { showNativeMenu, type MenuItemSpec } from "../nativeMenu";

/** Input types that hold editable text with a selection. `number` and
 *  `email` hold text but have no selection API, so they get the menu with
 *  whole-value fallbacks. */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number", ""]);

type TextField = HTMLInputElement | HTMLTextAreaElement;

/** What the right-click landed on, as far as the menu cares. */
export interface TextMenuContext {
  /** A field the user can type into. */
  editable: boolean;
  /** Text is selected (in the field, or on the page). */
  hasSelection: boolean;
  /** A password field: its text is never copied out. */
  secret: boolean;
  /** The field has text to select. */
  hasText: boolean;
}

export interface TextMenuActions {
  cut: () => void;
  copy: () => void;
  paste: () => void;
  selectAll: () => void;
}

/** The menu for a context, or null when there is nothing to offer (a click on
 *  plain page text with nothing selected). Pure — tested. */
export function buildTextEditMenuSpecs(ctx: TextMenuContext, actions: TextMenuActions): MenuItemSpec[] | null {
  if (!ctx.editable) {
    return ctx.hasSelection && !ctx.secret ? [{ kind: "item", text: "Copy", action: actions.copy }] : null;
  }
  const canCopy = ctx.hasSelection && !ctx.secret;
  return [
    { kind: "item", text: "Cut", enabled: canCopy, action: actions.cut },
    { kind: "item", text: "Copy", enabled: canCopy, action: actions.copy },
    { kind: "item", text: "Paste", action: actions.paste },
    { kind: "separator" },
    { kind: "item", text: "Select All", enabled: ctx.hasText, action: actions.selectAll },
  ];
}

function asTextField(el: Element | null): TextField | null {
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type)) return el;
  return null;
}

/** The element under the pointer — the first of the composed path, so a
 *  field inside a plugin's shadow root is found, not its host. */
function pointerTarget(e: MouseEvent): Element | null {
  const first = e.composedPath()[0];
  return first instanceof Element ? first : null;
}

/** The selection range of a field; null when the type has no selection API. */
function fieldRange(field: TextField): [number, number] | null {
  try {
    const { selectionStart, selectionEnd } = field;
    return selectionStart == null || selectionEnd == null ? null : [selectionStart, selectionEnd];
  } catch {
    // Reading selectionStart throws on input types without a selection (number, email).
    return null;
  }
}

function writeClipboard(text: string) {
  invoke("write_clipboard_text", { text }).catch((e) => console.error("Failed to copy to the clipboard:", e));
}

/** Put `text` in place of the field's [start, end), as typing would: through
 *  `insertText` (keeps undo and fires React's onChange), else by setting the
 *  range and announcing an input event. */
function replaceRange(field: TextField, range: [number, number] | null, text: string) {
  field.focus();
  // No range: the type has no selection API (number/email), so the whole
  // value stands for the selection.
  if (range) field.setSelectionRange(range[0], range[1]);
  else field.select();
  if (document.execCommand("insertText", false, text)) return;
  const [start, end] = range ?? [0, field.value.length];
  try {
    field.setRangeText(text, start, end, "end");
  } catch {
    // No range API on this input type: the whole value is what was selected.
    field.value = text;
  }
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Show the text menu for a right-click, if it has anything to offer. Returns
 * whether it handled the event. Called by App's document-level contextmenu
 * handler for events no component claimed (`defaultPrevented` unset).
 */
export function showTextEditMenu(e: MouseEvent): boolean {
  const target = pointerTarget(e);
  const field = asTextField(target);
  const editableHost = !field && target instanceof HTMLElement && target.isContentEditable ? target : null;

  if (field) {
    if (field.disabled) return false;
    const range = fieldRange(field);
    const selected = range ? field.value.slice(range[0], range[1]) : "";
    // No selection API (number/email): the menu acts on the whole value.
    const copyText = range ? selected : field.value;
    const ctx: TextMenuContext = {
      editable: !field.readOnly,
      hasSelection: copyText !== "",
      secret: field instanceof HTMLInputElement && field.type === "password",
      hasText: field.value !== "",
    };
    const selectAll = () => { field.focus(); field.select(); };
    // The range is read again when the action runs: the field can change
    // between the right-click and the pick (and a paste waits on the
    // clipboard), so the menu's snapshot would put the text in the wrong place.
    const cut = () => {
      const now = fieldRange(field);
      const text = now ? field.value.slice(now[0], now[1]) : field.value;
      if (!text) return;
      writeClipboard(text);
      replaceRange(field, now, "");
    };
    const specs = buildTextEditMenuSpecs(ctx, {
      copy: () => writeClipboard(copyText),
      cut,
      paste: () => {
        invoke<string>("read_clipboard_text")
          .then((text) => { if (text) replaceRange(field, fieldRange(field), text); })
          .catch((err) => console.error("Failed to paste from the clipboard:", err));
      },
      selectAll,
    });
    // A read-only field: Copy (when there's a selection) and Select All.
    const menu: MenuItemSpec[] | null = field.readOnly
      ? [
          ...(ctx.hasSelection && !ctx.secret ? [{ kind: "item" as const, text: "Copy", action: () => writeClipboard(copyText) }] : []),
          { kind: "item", text: "Select All", enabled: ctx.hasText, action: selectAll },
        ]
      : specs;
    if (!menu) return false;
    showNativeMenu(e.clientX, e.clientY, menu).catch((err) => console.error("Failed to show the text menu:", err));
    return true;
  }

  const selection = window.getSelection();
  const selected = selection?.toString() ?? "";
  if (editableHost) {
    const savedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
    const restore = () => {
      editableHost.focus();
      if (savedRange) { selection?.removeAllRanges(); selection?.addRange(savedRange); }
    };
    const specs = buildTextEditMenuSpecs(
      { editable: true, hasSelection: selected !== "", secret: false, hasText: (editableHost.textContent ?? "") !== "" },
      {
        copy: () => writeClipboard(selected),
        cut: () => { writeClipboard(selected); restore(); document.execCommand("delete"); },
        paste: () => {
          invoke<string>("read_clipboard_text")
            .then((text) => { if (text) { restore(); document.execCommand("insertText", false, text); } })
            .catch((err) => console.error("Failed to paste from the clipboard:", err));
        },
        selectAll: () => { editableHost.focus(); document.execCommand("selectAll"); },
      },
    );
    if (!specs) return false;
    showNativeMenu(e.clientX, e.clientY, specs).catch((err) => console.error("Failed to show the text menu:", err));
    return true;
  }

  // Plain page text: Copy, when something is selected.
  if (selected.trim() === "") return false;
  showNativeMenu(e.clientX, e.clientY, [{ kind: "item", text: "Copy", action: () => writeClipboard(selected) }])
    .catch((err) => console.error("Failed to show the text menu:", err));
  return true;
}
