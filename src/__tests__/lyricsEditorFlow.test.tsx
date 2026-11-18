import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor, screen } from "@testing-library/react";
import { LyricsRenderer } from "../components/renderers/LyricsRenderer";
import { setPlaybackPosition } from "../playback/positionStore";

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

    await waitFor(() => expect(onAction).toHaveBeenCalledWith("save-lyrics", { text: "First\nSecond", kind: "plain" }));
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
    expect(onAction).toHaveBeenCalledWith("save-lyrics", { text: "[00:01.00]A", kind: "synced" });
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
      }));
    } finally {
      window.removeEventListener("keydown", windowKeys);
    }
  });

  it("seeks when a synced line is clicked", () => {
    const seek = vi.fn();
    render(<LyricsRenderer data={{ text: "[00:12.00]Hello", kind: "synced" }} onAction={vi.fn()} context={{ seek }} />);
    fireEvent.click(screen.getByText("Hello"));
    expect(seek).toHaveBeenCalledWith(12);
  });
});
