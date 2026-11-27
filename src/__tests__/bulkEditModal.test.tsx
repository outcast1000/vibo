import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor, screen } from "@testing-library/react";
import type { Track } from "../types";

/**
 * Edit Properties. Two things it must never get wrong:
 * - a tag edit over several tracks sends an exact add/remove, so a tag only
 *   some of the tracks carry is left on exactly those tracks (the old default
 *   Replace took it off all of them);
 * - the Lyrics tab saves through the lyrics editor's own save
 *   (`saveSongLyrics`), into the song's files.
 */
const defaultInvoke = vi.hoisted(() => async (cmd: string, _args?: unknown): Promise<unknown> => {
  if (cmd === "get_tag_counts_for_tracks") return [[1, "Jazz", 1], [2, "Rock", 2]];
  if (cmd === "bulk_update_tracks") return [];
  return null;
});
const invoke = vi.hoisted(() => vi.fn(defaultInvoke));
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (p: string) => p }));
vi.mock("../utils/tauriEvents", () => ({ subscribe: () => () => undefined, safeUnlisten: vi.fn() }));
const saveSongLyrics = vi.hoisted(() => vi.fn(async () => ({ savedTo: "file" })));
const clearSongLyrics = vi.hoisted(() => vi.fn(async () => undefined));
const readLocalLyrics = vi.hoisted(() => vi.fn(async (): Promise<unknown> => ({ text: "old line", kind: "plain", local: true })));
vi.mock("../utils/localLyrics", () => ({ saveSongLyrics, clearSongLyrics, readLocalLyrics }));
const showNativeMenu = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../nativeMenu", () => ({ showNativeMenu }));

const { default: BulkEditModal } = await import("../components/BulkEditModal");

function track(id: number, title: string): Track {
  return {
    id, path: `file:///m/${title}.flac`, title, artist_id: 1, artist_name: "Band", album_id: 1, album_title: "LP",
    year: 2001, track_number: id, duration_secs: 200, format: "flac", file_size: 1, collection_id: 1,
    collection_name: "Music", liked: 0, added_at: null, modified_at: null,
  };
}

const LRCLIB = { key: "lyrics/lrclib", name: "LRCLIB" };

function renderModal(
  tracks: Track[],
  onSave = vi.fn(),
  opts: { invokeInfoFetch?: ReturnType<typeof vi.fn>; lyricsProviders?: Array<{ key: string; name: string }> } = {},
) {
  render(
    <BulkEditModal
      tracks={tracks}
      artistOptions={[]}
      albumOptions={[]}
      tagOptions={[]}
      invokeInfoFetch={(opts.invokeInfoFetch ?? vi.fn(async () => ({ status: "not_found" }))) as never}
      lyricsProviders={opts.lyricsProviders}
      onClose={vi.fn()}
      onSave={onSave}
    />,
  );
  return onSave;
}

afterEach(() => {
  cleanup();
  invoke.mockClear();
  saveSongLyrics.mockClear();
  clearSongLyrics.mockClear();
  readLocalLyrics.mockClear();
});

describe("BulkEditModal", () => {
  const saveButton = () => screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;

  it("retyping a field's own value is no change", () => {
    renderModal([track(1, "A")]);
    const album = screen.getByLabelText("Album");
    fireEvent.change(album, { target: { value: "LP2" } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.change(album, { target: { value: "LP" } });
    expect(saveButton().disabled).toBe(true);
  });

  it("across several tracks, typing into a field and deleting it again clears nothing", () => {
    renderModal([track(1, "A"), { ...track(2, "B"), artist_name: "Other" }]);
    const artist = screen.getByLabelText("Artist");
    fireEvent.change(artist, { target: { value: "X" } });
    fireEvent.change(artist, { target: { value: "" } });
    expect(saveButton().disabled).toBe(true);
    expect(screen.queryByText("Will be cleared")).toBeNull();
  });

  it("across several tracks, only the Clear button clears", async () => {
    const onSave = renderModal([track(1, "A"), { ...track(2, "B"), artist_name: "Other" }]);
    fireEvent.click(screen.getByRole("button", { name: "Clear Artist" }));
    expect(screen.getByText("Will be cleared")).toBeTruthy();
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const call = invoke.mock.calls.find(([cmd]) => cmd === "bulk_update_tracks");
    expect((call?.[1] as { fields: Record<string, unknown> }).fields).toHaveProperty("artist_name");
  });

  it("offers no Clear on a field that is already empty", () => {
    renderModal([{ ...track(1, "A"), year: null }]);
    expect(screen.queryByRole("button", { name: "Clear Year" })).toBeNull();
    expect(screen.getByRole("button", { name: "Clear Album" })).toBeTruthy();
  });

  it("adding a tag to two tracks sends only that tag — the tag one track has stays", async () => {
    const onSave = renderModal([track(1, "A"), track(2, "B")]);
    fireEvent.click(screen.getByRole("tab", { name: "Tags" }));
    const input = await screen.findByPlaceholderText("Add a tag…");
    fireEvent.change(input, { target: { value: "Live" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const call = invoke.mock.calls.find(([cmd]) => cmd === "bulk_update_tracks");
    expect(call?.[1]).toEqual({ trackIds: [1, 2], fields: { tags_add: ["Live"] } });
  });

  it("lyrics edited in the Lyrics tab are saved with the editor's save", async () => {
    const onSave = renderModal([track(1, "A")]);
    fireEvent.click(screen.getByRole("tab", { name: "Lyrics" }));
    const area = await screen.findByRole("textbox", { name: "Lyrics" });
    fireEvent.change(area, { target: { value: "new line" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(saveSongLyrics).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "track", name: "A", id: 1, path: "file:///m/A.flac" }),
      "new line", "plain", "edit", undefined,
    );
    // Nothing else changed, so no file metadata write.
    expect(invoke.mock.calls.some(([cmd]) => cmd === "bulk_update_tracks")).toBe(false);
  });

  it("a failed lyrics save keeps the dialog open and doesn't rewrite the details", async () => {
    saveSongLyrics.mockRejectedValueOnce(new Error("disk full"));
    const onSave = renderModal([track(1, "A")]);
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "1999" } });
    fireEvent.click(screen.getByRole("tab", { name: "Lyrics" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Lyrics" }), { target: { value: "new line" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Couldn't save the lyrics: disk full/)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
    // Retry: only the lyrics are saved again.
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "bulk_update_tracks")).toHaveLength(1);
    expect(saveSongLyrics).toHaveBeenCalledTimes(2);
  });

  it("an edit survives leaving the Lyrics tab and coming back", async () => {
    renderModal([track(1, "A")]);
    fireEvent.click(screen.getByRole("tab", { name: "Lyrics" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Lyrics" }), { target: { value: "new line" } });
    fireEvent.click(screen.getByRole("tab", { name: "Details" }));
    // Its name now carries the unsaved dot ("Lyrics modified").
    fireEvent.click(screen.getByRole("tab", { name: /^Lyrics/ }));
    expect((screen.getByRole("textbox", { name: "Lyrics" }) as HTMLTextAreaElement).value).toBe("new line");
  });

  it("Escape with unsaved changes asks first, and stops at the dialog", async () => {
    const onClose = vi.fn();
    const windowKey = vi.fn();
    window.addEventListener("keydown", windowKey);
    render(
      <BulkEditModal tracks={[track(1, "A")]} artistOptions={[]} albumOptions={[]} tagOptions={[]}
        invokeInfoFetch={vi.fn(async () => ({ status: "not_found" })) as never} onClose={onClose} onSave={vi.fn()} />,
    );
    const year = screen.getByLabelText("Year");
    fireEvent.change(year, { target: { value: "1999" } });
    fireEvent.keyDown(year, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Discard your changes?")).toBeTruthy();
    expect(windowKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onClose).toHaveBeenCalled();
    window.removeEventListener("keydown", windowKey);
  });

  // The files may hold lyrics an empty editor's save would replace.
  it("a lyrics load that fails offers Try again instead of an empty editor", async () => {
    readLocalLyrics.mockRejectedValueOnce(new Error("permission denied"));
    renderModal([track(1, "A")]);
    fireEvent.click(screen.getByRole("tab", { name: "Lyrics" }));
    expect(await screen.findByText(/Couldn't read the current lyrics: permission denied/)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Lyrics" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("textbox", { name: "Lyrics" })).toBeTruthy();
  });

  it("opening the Lyrics tab asks no provider — it reads the song's files", async () => {
    const invokeInfoFetch = vi.fn(async () => ({ status: "ok", value: { text: "web words", kind: "plain" } }));
    renderModal([track(1, "A")], vi.fn(), { invokeInfoFetch, lyricsProviders: [LRCLIB] });
    fireEvent.click(screen.getByRole("tab", { name: "Lyrics" }));
    const area = await screen.findByRole("textbox", { name: "Lyrics" }) as HTMLTextAreaElement;
    expect(area.value).toBe("old line");
    expect(readLocalLyrics).toHaveBeenCalled();
    expect(invokeInfoFetch.mock.calls.some((c) => (c as unknown[])[1] === "lyrics")).toBe(false);
  });

  it("with no lyrics in the files, a copy Vibo already holds is shown — still without asking a provider", async () => {
    readLocalLyrics.mockResolvedValueOnce(null);
    invoke.mockImplementation(async (cmd: string) => {
      // A stale row of the files' own provider is not "online" lyrics; the
      // user's first switched-on provider wins over a later one.
      if (cmd === "info_get_types_for_entity") {
        return [["lyrics", "Lyrics", "lyrics", 0, 0, [["core:local-lyrics", 3], ["lyrics/lrclib", 7], ["genius", 9]], ""]];
      }
      if (cmd === "info_get_values_for_entity") {
        return [
          [3, "lyrics", JSON.stringify({ text: "stale file words", kind: "plain", local: true }), "ok", 0],
          [9, "lyrics", JSON.stringify({ text: "genius words", kind: "plain" }), "ok", 0],
          [7, "lyrics", JSON.stringify({ text: "cached words", kind: "plain" }), "ok", 0],
        ];
      }
      if (cmd === "get_tag_counts_for_tracks") return [];
      return null;
    });
    try {
      const invokeInfoFetch = vi.fn(async () => ({ status: "not_found" }));
      renderModal([track(1, "A")], vi.fn(), { invokeInfoFetch });
      fireEvent.click(screen.getByRole("tab", { name: "Lyrics" }));
      expect(((await screen.findByRole("textbox", { name: "Lyrics" })) as HTMLTextAreaElement).value).toBe("cached words");
      expect(invokeInfoFetch.mock.calls.some((c) => (c as unknown[])[1] === "lyrics")).toBe(false);
    } finally {
      invoke.mockImplementation(defaultInvoke);
    }
  });

  it("Get lyrics asks the picked provider, and Save writes its answer", async () => {
    const invokeInfoFetch = vi.fn(async () => ({ status: "ok", value: { text: "web words", kind: "plain" } }));
    const onSave = renderModal([track(1, "A")], vi.fn(), { invokeInfoFetch, lyricsProviders: [LRCLIB] });
    fireEvent.click(screen.getByRole("tab", { name: "Lyrics" }));
    await screen.findByRole("textbox", { name: "Lyrics" });
    fireEvent.click(screen.getByRole("button", { name: "Get lyrics from LRCLIB" }));
    await waitFor(() => expect(((screen.getByRole("textbox", { name: "Lyrics" })) as HTMLTextAreaElement).value).toBe("web words"));
    expect(invokeInfoFetch).toHaveBeenCalledWith("lyrics/lrclib", "lyrics", expect.objectContaining({ name: "A" }));
    expect(screen.getByText(/From LRCLIB — not saved yet/)).toBeTruthy();
    expect(saveSongLyrics).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    // Saved as it came: credited to the provider, not the user's edit.
    expect(saveSongLyrics).toHaveBeenCalledWith(
      expect.objectContaining({ name: "A" }), "web words", "plain", "provider", { provider: "lyrics/lrclib" },
    );
  });

  it("a provider's answer edited before Save is the user's edit", async () => {
    const invokeInfoFetch = vi.fn(async () => ({ status: "ok", value: { text: "web words", kind: "plain" } }));
    const onSave = renderModal([track(1, "A")], vi.fn(), { invokeInfoFetch, lyricsProviders: [LRCLIB] });
    fireEvent.click(screen.getByRole("tab", { name: "Lyrics" }));
    await screen.findByRole("textbox", { name: "Lyrics" });
    fireEvent.click(screen.getByRole("button", { name: "Get lyrics from LRCLIB" }));
    await waitFor(() => expect(((screen.getByRole("textbox", { name: "Lyrics" })) as HTMLTextAreaElement).value).toBe("web words"));
    fireEvent.change(screen.getByRole("textbox", { name: "Lyrics" }), { target: { value: "web words, fixed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(saveSongLyrics).toHaveBeenCalledWith(expect.anything(), "web words, fixed", "plain", "edit", undefined);
  });

  it("an answer arriving over the user's edits waits to be accepted — Keep my edits keeps them", async () => {
    const invokeInfoFetch = vi.fn(async () => ({ status: "ok", value: { text: "web words", kind: "plain" } }));
    renderModal([track(1, "A")], vi.fn(), { invokeInfoFetch, lyricsProviders: [LRCLIB] });
    fireEvent.click(screen.getByRole("tab", { name: "Lyrics" }));
    const area = await screen.findByRole("textbox", { name: "Lyrics" });
    fireEvent.change(area, { target: { value: "my own fix" } });
    fireEvent.click(screen.getByRole("button", { name: "Get lyrics from LRCLIB" }));
    expect(await screen.findByText("LRCLIB found lyrics. Replace your edits with them?")).toBeTruthy();
    expect(((screen.getByRole("textbox", { name: "Lyrics" })) as HTMLTextAreaElement).value).toBe("my own fix");
    fireEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
    expect(((screen.getByRole("textbox", { name: "Lyrics" })) as HTMLTextAreaElement).value).toBe("my own fix");
    // Asked again, Replace takes the answer.
    fireEvent.click(screen.getByRole("button", { name: "Get lyrics from LRCLIB" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
    expect(((screen.getByRole("textbox", { name: "Lyrics" })) as HTMLTextAreaElement).value).toBe("web words");
  });

  it("an editor emptied by hand saves nothing — only Clear lyrics clears", async () => {
    renderModal([track(1, "A")]);
    fireEvent.click(screen.getByRole("tab", { name: "Lyrics" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Lyrics" }), { target: { value: "" } });
    expect(screen.getByText(/An empty editor saves nothing/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("several providers open a menu of them; a provider with nothing says so and leaves the text", async () => {
    const invokeInfoFetch = vi.fn(async () => ({ status: "not_found" }));
    renderModal([track(1, "A")], vi.fn(), { invokeInfoFetch, lyricsProviders: [LRCLIB, { key: "genius", name: "Genius" }] });
    fireEvent.click(screen.getByRole("tab", { name: "Lyrics" }));
    await screen.findByRole("textbox", { name: "Lyrics" });
    fireEvent.click(screen.getByRole("button", { name: "Get lyrics ▾" }));
    const specs = (showNativeMenu.mock.calls.at(-1) as unknown as [number, number, Array<{ text: string; action: () => void }>])[2];
    expect(specs.map((s) => s.text)).toEqual(["LRCLIB", "Genius"]);
    specs[1].action();
    expect(await screen.findByText("Genius has no lyrics for this song.")).toBeTruthy();
    expect(invokeInfoFetch).toHaveBeenCalledWith("genius", "lyrics", expect.anything());
    expect(((screen.getByRole("textbox", { name: "Lyrics" })) as HTMLTextAreaElement).value).toBe("old line");
  });

  it("Clear lyrics removes them on Save, from the file and Vibo — nothing is saved in their place", async () => {
    const onSave = renderModal([track(1, "A")]);
    fireEvent.click(screen.getByRole("tab", { name: "Lyrics" }));
    await screen.findByRole("textbox", { name: "Lyrics" });
    fireEvent.click(screen.getByRole("button", { name: "Clear lyrics" }));
    expect(screen.getByText(/Save removes the lyrics from the track's file/)).toBeTruthy();
    expect(clearSongLyrics).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(clearSongLyrics).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "A", id: 1 }), expect.objectContaining({ name: "A", id: 1 })], 1,
    );
    expect(saveSongLyrics).not.toHaveBeenCalled();
  });

  it("Revert after Clear brings the lyrics back and leaves nothing to save", async () => {
    renderModal([track(1, "A")]);
    fireEvent.click(screen.getByRole("tab", { name: "Lyrics" }));
    await screen.findByRole("textbox", { name: "Lyrics" });
    fireEvent.click(screen.getByRole("button", { name: "Clear lyrics" }));
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(((screen.getByRole("textbox", { name: "Lyrics" })) as HTMLTextAreaElement).value).toBe("old line");
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("some files failing still reports the change on Close, and nothing is written twice", async () => {
    invoke.mockImplementationOnce(async (cmd: string) => (cmd === "get_tag_counts_for_tracks" ? [] : null));
    invoke.mockImplementationOnce(async () => ["/m/A.flac: read-only"]);
    const onSave = renderModal([track(1, "A")]);
    fireEvent.change(screen.getByLabelText("Album"), { target: { value: "New LP" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/read-only/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ albumChanged: true, newAlbum: "New LP" }));
  });
});
