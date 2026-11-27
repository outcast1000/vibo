import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor, screen } from "@testing-library/react";
import { LyricsRenderer } from "../components/renderers/LyricsRenderer";
import { LyricsEditor } from "../components/renderers/LyricsEditor";
import { setPlaybackPosition } from "../playback/positionStore";

// The stored reaction lead: none, so stamps here land exactly on the
// position — the lead has its own tests below.
const storeGet = vi.hoisted(() => vi.fn(async (): Promise<unknown> => 0));
const storeSet = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../store", () => ({ store: { get: storeGet, set: storeSet } }));

/**
 * The lyrics tab's editing flows: a song with no lyrics offers to add them,
 * the saved kind is read off the text (never a separate choice), a failed
 * save keeps the editor open with the reason, and Sync stamps lines from the
 * playback position without the page's own shortcuts seeing the keys.
 */

// jsdom has no scrolling; the editor centres the cursor line with scrollTo.
if (!HTMLElement.prototype.scrollTo) HTMLElement.prototype.scrollTo = () => undefined;

afterEach(() => {
  cleanup();
  setPlaybackPosition(0);
});

describe("LyricsRenderer editing", () => {
  it("offers to add lyrics when there are none and saves plain text as plain", async () => {
    const onAction = vi.fn(async () => undefined);
    render(<LyricsRenderer data={null} onAction={onAction} />);

    fireEvent.click(screen.getByRole("button", { name: "Add lyrics" }));
    fireEvent.change(screen.getByLabelText("Lyrics"), { target: { value: "First\nSecond" } });
    expect(screen.getByText(/Saves as plain text · 2 lines/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onAction).toHaveBeenCalledWith("save-lyrics", { text: "First\nSecond", kind: "plain", local: false }));
    await waitFor(() => expect(screen.queryByLabelText("Lyrics")).toBeNull());
  });

  it("renders nothing for a missing value when the page can't save", () => {
    const { container } = render(<LyricsRenderer data={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("detects synced text and keeps the editor open when the save fails", async () => {
    const onAction = vi.fn(async () => { throw new Error("disk full"); });
    render(<LyricsRenderer data={{ text: "A", kind: "plain" }} onAction={onAction} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit or sync" }));
    fireEvent.change(screen.getByLabelText("Lyrics"), { target: { value: "[00:01.00]A" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText(/Couldn't save the lyrics: disk full/)).toBeTruthy());
    expect(onAction).toHaveBeenCalledWith("save-lyrics", { text: "[00:01.00]A", kind: "synced", local: false });
    expect(screen.getByLabelText("Lyrics")).toBeTruthy();
  });

  it("asks before discarding changes", () => {
    render(<LyricsRenderer data={{ text: "A", kind: "plain" }} onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit or sync" }));
    fireEvent.change(screen.getByLabelText("Lyrics"), { target: { value: "B" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Discard your changes?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect((screen.getByLabelText("Lyrics") as HTMLTextAreaElement).value).toBe("B");
  });

  it("stamps lines from the playback position and keeps the keys to itself", async () => {
    const onAction = vi.fn(async () => undefined);
    const windowKeys = vi.fn();
    window.addEventListener("keydown", windowKeys);
    try {
      render(
        <LyricsRenderer
          data={{ text: "First\nSecond", kind: "plain" }}
          onAction={onAction}
          context={{ livePosition: true, seek: vi.fn() }}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Edit or sync" }));
      fireEvent.click(screen.getByRole("tab", { name: /Sync/ }));

      const list = screen.getByRole("listbox", { name: "Lines to sync" });
      await waitFor(() => expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("0"));
      setPlaybackPosition(3.2);
      fireEvent.keyDown(list, { key: " " });
      setPlaybackPosition(7.5);
      fireEvent.keyDown(list, { key: " " });
      fireEvent.keyDown(list, { key: "ArrowLeft" });
      expect(windowKeys).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onAction).toHaveBeenCalledWith("save-lyrics", {
        text: "[00:03.20]First\n[00:07.40]Second",
        kind: "synced",
        local: false,
      }));
    } finally {
      window.removeEventListener("keydown", windowKeys);
    }
  });

  it("edits lyrics from the track's own files and says they came from there", async () => {
    // These used to have no editor at all (a cache-only edit would be undone
    // by the next re-read of the file); now the save carries `local` so the
    // host writes it back into the file.
    const onAction = vi.fn(async () => undefined);
    render(<LyricsRenderer data={{ text: "[00:01.00]A", kind: "synced", local: true }} onAction={onAction} />);

    expect(screen.getByText("From file")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Lyrics"), { target: { value: "[00:02.00]A" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onAction).toHaveBeenCalledWith("save-lyrics", { text: "[00:02.00]A", kind: "synced", local: true }));
  });

  it("seeks when a synced line is clicked", () => {
    const seek = vi.fn();
    render(<LyricsRenderer data={{ text: "[00:12.00]Hello", kind: "synced" }} onAction={vi.fn()} context={{ seek }} />);
    fireEvent.click(screen.getByText("Hello"));
    expect(seek).toHaveBeenCalledWith(12);
  });
});

describe("LyricsEditor transport (Edit Properties' Sync)", () => {
  it("plays, pauses and skips from inside the dialog without stealing Space", async () => {
    const seek = vi.fn();
    const onTogglePlay = vi.fn();
    const onTextChange = vi.fn();
    setPlaybackPosition(10);
    render(
      <LyricsEditor
        initialText={"One\nTwo"}
        live
        seek={seek}
        transport={{ playing: true, onTogglePlay, durationSecs: 12 }}
        onTextChange={onTextChange}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Sync/ }));

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(onTogglePlay).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Back 5 seconds" }));
    expect(seek).toHaveBeenLastCalledWith(5);
    fireEvent.click(screen.getByRole("button", { name: "Ahead 5 seconds" }));
    expect(seek).toHaveBeenLastCalledWith(11.5); // stops short of the end

    const list = screen.getByRole("listbox", { name: "Lines to sync" });
    fireEvent.keyDown(list, { key: "p" });
    expect(onTogglePlay).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(list, { key: "[" });
    expect(seek).toHaveBeenLastCalledWith(5);
    fireEvent.change(screen.getByLabelText("Seek"), { target: { value: "3" } });
    expect(seek).toHaveBeenLastCalledWith(3);

    // Space still stamps.
    await waitFor(() => expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("0"));
    fireEvent.keyDown(list, { key: " " });
    expect(onTextChange).toHaveBeenCalledWith("[00:10.00]One\nTwo");
  });

  it("stamps earlier by the stored lead, and a new lead is stored", async () => {
    storeGet.mockResolvedValueOnce(250);
    const onTextChange = vi.fn();
    setPlaybackPosition(10);
    render(<LyricsEditor initialText={"One\nTwo"} live transport={{ playing: true, onTogglePlay: vi.fn() }} onTextChange={onTextChange} />);
    fireEvent.click(screen.getByRole("tab", { name: /Sync/ }));
    const lead = screen.getByRole("combobox") as HTMLSelectElement;
    await waitFor(() => expect(lead.value).toBe("250"));

    fireEvent.keyDown(screen.getByRole("listbox", { name: "Lines to sync" }), { key: " " });
    expect(onTextChange).toHaveBeenLastCalledWith("[00:09.75]One\nTwo");

    fireEvent.change(lead, { target: { value: "0" } });
    expect(storeSet).toHaveBeenCalledWith("lyricsSyncLeadMs", 0);
  });

  it("moves every timed line at once", () => {
    const onTextChange = vi.fn();
    render(<LyricsEditor initialText={"[00:10.00]One\n[00:20.00]Two\nThree"} live transport={{ playing: true, onTogglePlay: vi.fn() }} onTextChange={onTextChange} />);
    fireEvent.click(screen.getByRole("tab", { name: /Sync/ }));
    fireEvent.click(screen.getByRole("button", { name: "All lines later" }));
    expect(onTextChange).toHaveBeenLastCalledWith("[00:10.10]One\n[00:20.10]Two\nThree");
    fireEvent.click(screen.getByRole("button", { name: "All lines earlier" }), { shiftKey: true });
    expect(onTextChange).toHaveBeenLastCalledWith("[00:09.10]One\n[00:19.10]Two\nThree");
  });

  it("the Stamp button hands focus back to the list, so the keys keep working", () => {
    setPlaybackPosition(4);
    render(<LyricsEditor initialText={"One\nTwo"} live transport={{ playing: true, onTogglePlay: vi.fn() }} onTextChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: /Sync/ }));
    fireEvent.click(screen.getByRole("button", { name: "Stamp line" }));
    expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "Lines to sync" }));
  });

  it("Sync is closed until there are words to time", () => {
    render(<LyricsEditor initialText="" live={false} onTextChange={vi.fn()} />);
    expect((screen.getByRole("tab", { name: /Sync/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Lyrics"), { target: { value: "One" } });
    expect((screen.getByRole("tab", { name: /Sync/ }) as HTMLButtonElement).disabled).toBe(false);
    // Embedded, the dialog owns Save: no "Nothing to save yet" line.
    expect(screen.queryByText("Nothing to save yet")).toBeNull();
  });

  it("offers to start the song when another one is playing", () => {
    const seek = vi.fn();
    render(<LyricsEditor initialText={"[00:20.00]One\nTwo"} live={false} seek={seek} transport={{ playing: true, onTogglePlay: vi.fn() }} onTextChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: /Sync/ }));
    // The transport belongs to the song being synced — not to what's playing.
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Play this song" }));
    expect(seek).toHaveBeenLastCalledWith(0);
    fireEvent.click(screen.getByTitle("Replay from this line"));
    expect(seek).toHaveBeenLastCalledWith(18);
  });

  it("seeks once per drag, and leaves ⌘S / Esc to the dialog", () => {
    const seek = vi.fn();
    const onDialogKey = vi.fn();
    setPlaybackPosition(2);
    render(
      <div onKeyDown={e => onDialogKey(e.key)}>
        <LyricsEditor initialText="One" live seek={seek} transport={{ playing: true, onTogglePlay: vi.fn(), durationSecs: 60 }} onTextChange={vi.fn()} />
      </div>,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Sync/ }));
    const bar = screen.getByLabelText("Seek") as HTMLInputElement;

    fireEvent.pointerDown(bar);
    fireEvent.change(bar, { target: { value: "20" } });
    fireEvent.change(bar, { target: { value: "30" } });
    expect(seek).not.toHaveBeenCalled();
    expect(bar.value).toBe("30"); // the thumb stays with the pointer
    fireEvent.pointerUp(bar);
    expect(seek).toHaveBeenCalledTimes(1);
    expect(seek).toHaveBeenCalledWith(30);

    fireEvent.keyDown(bar, { key: "ArrowRight" });
    fireEvent.keyDown(bar, { key: "s", metaKey: true });
    fireEvent.keyDown(bar, { key: "Escape" });
    expect(onDialogKey.mock.calls.map(c => c[0])).toEqual(["s", "Escape"]);
  });

  it("has no transport without one from the host", () => {
    render(<LyricsEditor initialText="One" live seek={vi.fn()} onTextChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: /Sync/ }));
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByLabelText("Seek")).toBeNull();
  });
});
