import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor, screen } from "@testing-library/react";
import { LyricsDraftReview } from "../components/renderers/LyricsDraftReview";
import {
  MAX_LYRICS_DRAFT_CHARS,
  closeLyricsDraft,
  getLyricsDraft,
  onLyricsDraftClosed,
  parseLyricsDraft,
  putLyricsDraft,
  resetLyricsDraftsForTest,
  type LyricsDraft,
  type LyricsDraftInput,
} from "../utils/lyricsDrafts";

/**
 * `requestAction("review-lyrics")`: a plugin's lyrics draft is never saved by
 * the host on its own. It opens in the lyrics editor; Save is the approval,
 * Discard draft leaves the song's lyrics as they were, and either way the
 * plugin that sent it is told.
 */

if (!HTMLElement.prototype.scrollTo) HTMLElement.prototype.scrollTo = () => undefined;

afterEach(() => {
  cleanup();
  resetLyricsDraftsForTest();
});

const INPUT: LyricsDraftInput = {
  pluginId: "whisper",
  source: "Whisper",
  title: "Harbour",
  artistName: "Glass Harbour",
  albumTitle: null,
  text: "[00:01.00]Paper boats\n[00:04.00]Along the river",
  note: "92% of lines matched what was sung.",
};
const DRAFT: LyricsDraft = { ...INPUT, seq: 1 };
const NONE = { state: "none" } as const;
const loaded = (text: string, kind = "plain") => ({ state: "loaded" as const, text, kind });

describe("parseLyricsDraft", () => {
  it("takes a plugin's payload, trimmed, named after the plugin unless it says otherwise", () => {
    const d = parseLyricsDraft("whisper", "Whisper Lyrics Sync", { title: " Harbour ", artistName: "Glass Harbour", text: "a\r\nb\n\n" });
    expect(d).toEqual({ pluginId: "whisper", source: "Whisper Lyrics Sync", title: "Harbour", artistName: "Glass Harbour", albumTitle: null, text: "a\nb", note: null });
    expect(parseLyricsDraft("w", "W", { title: "x", text: "y", source: "Whisper" })).toMatchObject({ source: "Whisper" });
  });

  it("refuses a draft without a title or text, or too long to be lyrics", () => {
    expect(parseLyricsDraft("w", "W", { text: "y" })).toEqual({ error: expect.stringMatching(/title/) });
    expect(parseLyricsDraft("w", "W", { title: "x", text: "  " })).toEqual({ error: expect.stringMatching(/text/) });
    expect(parseLyricsDraft("w", "W", null)).toEqual({ error: expect.any(String) });
    expect(parseLyricsDraft("w", "W", { title: "x", text: "a".repeat(MAX_LYRICS_DRAFT_CHARS + 1) })).toEqual({ error: expect.stringMatching(/too long/) });
  });
});

describe("the draft store", () => {
  it("is found by the page under another spelling of the song", () => {
    putLyricsDraft({ ...INPUT, title: "Björk Song", artistName: "Björk" });
    expect(getLyricsDraft({ name: "bjork song", artistName: "BJORK" })?.title).toBe("Björk Song");
    expect(getLyricsDraft({ name: "Björk Song", artistName: "Someone Else" })).toBeNull();
  });

  it("a draft sent without an artist is found by the library row's page, which has one", () => {
    putLyricsDraft({ ...INPUT, artistName: null });
    expect(getLyricsDraft({ name: "Harbour", artistName: "Glass Harbour" })?.text).toBe(INPUT.text);
  });

  it("a re-sent draft replaces the old one with a new seq", () => {
    const a = putLyricsDraft(INPUT);
    const b = putLyricsDraft({ ...INPUT, artistName: "glass harbour", text: "[00:02.00]Corrected" });
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(getLyricsDraft({ name: "Harbour", artistName: "Glass Harbour" })?.text).toBe("[00:02.00]Corrected");
  });

  it("closing a review tells the plugin, and leaves a newer draft alone", () => {
    const told = vi.fn();
    onLyricsDraftClosed(told);
    const a = putLyricsDraft(INPUT);
    const b = putLyricsDraft({ ...INPUT, text: "[00:02.00]Newer" });
    closeLyricsDraft(a, "saved"); // the editor had the old one open
    expect(told).not.toHaveBeenCalled();
    expect(getLyricsDraft({ name: "Harbour", artistName: "Glass Harbour" })?.seq).toBe(b.seq);
    closeLyricsDraft(b, "discarded");
    expect(told).toHaveBeenCalledWith({ pluginId: "whisper", title: "Harbour", artistName: "Glass Harbour", outcome: "discarded" });
    expect(getLyricsDraft({ name: "Harbour", artistName: "Glass Harbour" })).toBeNull();
  });
});

describe("LyricsDraftReview", () => {
  it("opens the editor on the draft and Save approves it as is", async () => {
    const onSave = vi.fn(async () => undefined);
    const onDone = vi.fn();
    render(<LyricsDraftReview draft={DRAFT} current={NONE} live={false} onSave={onSave} onDone={onDone} />);

    expect(screen.getByText("Draft from Whisper: check it, then Save")).toBeTruthy();
    expect(screen.getByText(DRAFT.note!)).toBeTruthy();
    expect((screen.getByLabelText("Lyrics") as HTMLTextAreaElement).value).toBe(DRAFT.text);
    // Unedited, the draft is still a change to the song: Save is offered.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(DRAFT.text, "synced"));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("saved"));
  });

  it("saves what the user corrected", async () => {
    const onSave = vi.fn(async () => undefined);
    render(<LyricsDraftReview draft={DRAFT} current={NONE} live={false} onSave={onSave} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Lyrics"), { target: { value: "[00:01.00]Paper boats\n[00:04.20]Along the rivers" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("[00:01.00]Paper boats\n[00:04.20]Along the rivers", "synced"));
  });

  it("a failed save is not an approval: the editor stays open", async () => {
    const onDone = vi.fn();
    render(<LyricsDraftReview draft={DRAFT} current={NONE} live={false} onSave={vi.fn(async () => { throw new Error("disk full"); })} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText(/disk full/)).toBeTruthy());
    expect(onDone).not.toHaveBeenCalled();
  });

  it("Discard draft asks first, saves nothing and reports a discard", () => {
    const onSave = vi.fn();
    const onDone = vi.fn();
    render(<LyricsDraftReview draft={DRAFT} current={loaded("Old words")} live={false} onSave={onSave} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(screen.getByText("Discard this draft?")).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDone).toHaveBeenCalledWith("discarded");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("says what Save replaces and shows the current lyrics on request", () => {
    render(<LyricsDraftReview draft={DRAFT} current={loaded("[00:02.00]Old words", "synced")} live={false} onSave={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByText(/Saving replaces the song's synced lyrics/)).toBeTruthy();
    expect(screen.queryByLabelText("Current lyrics")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show current lyrics" }));
    expect(screen.getByLabelText("Current lyrics").textContent).toBe("[00:02.00]Old words");
  });

  it("holds Save until the song's current lyrics have been read", () => {
    const { rerender } = render(<LyricsDraftReview draft={DRAFT} current={{ state: "loading" }} live={false} onSave={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByText(/Reading the song's current lyrics/)).toBeTruthy();
    expect(screen.queryByText(/has no lyrics yet/)).toBeNull();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<LyricsDraftReview draft={DRAFT} current={loaded("Old words")} live={false} onSave={vi.fn()} onDone={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a draft identical to the current lyrics has nothing to save", () => {
    render(<LyricsDraftReview draft={DRAFT} current={loaded(DRAFT.text, "synced")} live={false} onSave={vi.fn()} onDone={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
