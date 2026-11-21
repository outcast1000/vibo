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
const invoke = vi.hoisted(() => vi.fn(async (cmd: string, _args?: unknown): Promise<unknown> => {
  if (cmd === "get_tag_counts_for_tracks") return [[1, "Jazz", 1], [2, "Rock", 2]];
  if (cmd === "bulk_update_tracks") return [];
  return null;
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (p: string) => p }));
vi.mock("../utils/tauriEvents", () => ({ subscribe: () => () => undefined, safeUnlisten: vi.fn() }));
const saveSongLyrics = vi.hoisted(() => vi.fn(async () => ({ savedTo: "file" })));
vi.mock("../utils/localLyrics", () => ({ saveSongLyrics }));
const fetchInfoValue = vi.hoisted(() => vi.fn(async () => ({ status: "ok", value: { text: "old line", kind: "plain" } })));
vi.mock("../utils/infoFetchChain", () => ({ fetchInfoValue }));

const { default: BulkEditModal } = await import("../components/BulkEditModal");

function track(id: number, title: string): Track {
  return {
    id, path: `file:///m/${title}.flac`, title, artist_id: 1, artist_name: "Band", album_id: 1, album_title: "LP",
    year: 2001, track_number: id, duration_secs: 200, format: "flac", file_size: 1, collection_id: 1,
    collection_name: "Music", liked: 0, added_at: null, modified_at: null,
  };
}

function renderModal(tracks: Track[], onSave = vi.fn()) {
  render(
    <BulkEditModal
      tracks={tracks}
      artistOptions={[]}
      albumOptions={[]}
      tagOptions={[]}
      invokeInfoFetch={vi.fn(async () => ({ status: "not_found" })) as never}
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
});

describe("BulkEditModal", () => {
  it("adding a tag to two tracks sends only that tag — the tag one track has stays", async () => {
    const onSave = renderModal([track(1, "A"), track(2, "B")]);
    fireEvent.click(screen.getByRole("tab", { name: "Tags" }));
    const input = await screen.findByPlaceholderText("Add a tag…");
    fireEvent.change(input, { target: { value: "Live" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const call = invoke.mock.calls.find(([cmd]) => cmd === "bulk_update_tracks");
    expect(call?.[1]).toEqual({ trackIds: [1, 2], fields: { tags_add: ["Live"] } });
  });

  it("lyrics edited in the Lyrics tab are saved with the editor's save", async () => {
    const onSave = renderModal([track(1, "A")]);
    fireEvent.click(screen.getByRole("tab", { name: "Lyrics" }));
    const area = await screen.findByLabelText("Lyrics");
    fireEvent.change(area, { target: { value: "new line" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(saveSongLyrics).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "track", name: "A", id: 1, path: "file:///m/A.flac" }),
      "new line", "plain", "edit",
    );
    // Nothing else changed, so no file metadata write.
    expect(invoke.mock.calls.some(([cmd]) => cmd === "bulk_update_tracks")).toBe(false);
  });

  it("a failed lyrics save keeps the dialog open and doesn't rewrite the details", async () => {
    saveSongLyrics.mockRejectedValueOnce(new Error("disk full"));
    const onSave = renderModal([track(1, "A")]);
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "1999" } });
    fireEvent.click(screen.getByRole("tab", { name: "Lyrics" }));
    fireEvent.change(await screen.findByLabelText("Lyrics"), { target: { value: "new line" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(await screen.findByText(/Couldn't save the lyrics: disk full/)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
    // Retry: only the lyrics are saved again.
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "bulk_update_tracks")).toHaveLength(1);
    expect(saveSongLyrics).toHaveBeenCalledTimes(2);
  });

  it("an edit survives leaving the Lyrics tab and coming back", async () => {
    renderModal([track(1, "A")]);
    fireEvent.click(screen.getByRole("tab", { name: "Lyrics" }));
    fireEvent.change(await screen.findByLabelText("Lyrics"), { target: { value: "new line" } });
    fireEvent.click(screen.getByRole("tab", { name: "Details" }));
    // Its name now carries the unsaved dot ("Lyrics modified").
    fireEvent.click(screen.getByRole("tab", { name: /^Lyrics/ }));
    expect((screen.getByLabelText("Lyrics") as HTMLTextAreaElement).value).toBe("new line");
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

  it("a lyrics load that fails offers Try again instead of an empty editor", async () => {
    fetchInfoValue.mockResolvedValueOnce({ status: "error" } as never);
    renderModal([track(1, "A")]);
    fireEvent.click(screen.getByRole("tab", { name: "Lyrics" }));
    expect(await screen.findByText(/Couldn't read the current lyrics/)).toBeTruthy();
    expect(screen.queryByLabelText("Lyrics")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Lyrics")).toBeTruthy();
  });

  it("some files failing still reports the change on Close, and nothing is written twice", async () => {
    invoke.mockImplementationOnce(async (cmd: string) => (cmd === "get_tag_counts_for_tracks" ? [] : null));
    invoke.mockImplementationOnce(async () => ["/m/A.flac: read-only"]);
    const onSave = renderModal([track(1, "A")]);
    fireEvent.change(screen.getByLabelText("Album"), { target: { value: "New LP" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(await screen.findByText(/read-only/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ albumChanged: true, newAlbum: "New LP" }));
  });
});
