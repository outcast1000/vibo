import { describe, it, expect, vi } from "vitest";
import { buildContextMenuSpecs, type ContextMenuDeps } from "../contextMenu/buildContextMenuSpecs";
import type { MenuItemSpec } from "../nativeMenu";
import type { ContextMenuTarget } from "../types/contextMenu";
import type { PluginMenuItem } from "../types/plugin";

// The track menus: Play Full Album → Library (once only in the now-playing
// bar's menu, so the queue's submenu offered Last.fm alone), the queue's
// Track Details / Go to Album / Edit Properties-or-Edit-info, and the shared
// plugin actions sitting with the host's own actions, above the plugin section.

const lastfmFullAlbum: PluginMenuItem = {
  pluginId: "lastfm", pluginName: "Last.fm", id: "full", label: "Play the Full Album",
  targets: ["track", "multi-track"], action: "play-full-album",
};
const ytdlpDownload: PluginMenuItem = {
  pluginId: "ytdlp", pluginName: "yt-dlp", id: "dl", label: "Download",
  targets: ["track", "multi-track"], action: "download",
};
const ffmpegInfo: PluginMenuItem = {
  pluginId: "ffmpeg", pluginName: "FFmpeg Tools", id: "info", label: "Media Info",
  targets: ["track", "multi-track"],
};

const queued = (over: Record<string, unknown> = {}) => ({
  key: "q:1", title: "Going Under", artist_name: "Evanescence", album_artist_name: null,
  album_title: "Fallen", path: "file:///x.flac", ...over,
});

function deps(over: {
  onPlayAlbumByName?: ContextMenuDeps["onPlayAlbumByName"];
  menuItems?: PluginMenuItem[];
  queue?: unknown[];
  locate?: "album" | "artist" | null;
  handleTrackClick?: (sel: unknown) => void;
  handleBulkEdit?: () => void;
  openEditTrackInfo?: (i: number) => void;
} = {}): ContextMenuDeps {
  return {
    contextMenuActions: {
      startRadio: vi.fn(), handleShowInFolder: vi.fn(),
      handleBulkEdit: over.handleBulkEdit ?? vi.fn(),
    },
    videoLayout: {},
    queueHook: { queue: over.queue ?? [queued()] },
    library: {
      handleTrackClick: over.handleTrackClick ?? vi.fn(),
      handleLocateTrack: vi.fn(),
      locateTrackTarget: () => ("locate" in over ? over.locate : "album"),
      navigateToTrackByName: vi.fn(() => Promise.resolve()),
      tracks: [],
    },
    plugins: { menuItems: over.menuItems ?? [lastfmFullAlbum], dispatchContextMenuAction: vi.fn() },
    getMenus: { lyrics: [], images: { artist: [], album: [], tag: [] }, openLyrics: vi.fn(), openImage: vi.fn() },
    userPlaylists: [],
    onAddToPlaylist: vi.fn(), onAddToNewPlaylist: vi.fn(), onBrowsePlaylists: vi.fn(),
    openEditTrackInfoRef: { current: over.openEditTrackInfo ?? vi.fn() },
    handleExportAsMixtapeRef: { current: null },
    openPublishMusicSourceRef: { current: null },
    trashLabel: "Trash",
    onPlayAlbumByName: over.onPlayAlbumByName ?? vi.fn(),
  } as unknown as ContextMenuDeps;
}

const queueTarget = (trackIds: number[], indices = [0]): ContextMenuTarget => ({
  kind: "queue-multi", indices, trackIds,
  firstTrack: { title: "Going Under", artistName: "Evanescence", albumTitle: "Fallen", isLocal: true },
});

const texts = (specs: MenuItemSpec[] | null) =>
  (specs ?? []).map((s) => (s.kind === "separator" ? "---" : s.text));
const find = (specs: MenuItemSpec[] | null, text: string | RegExp) =>
  specs?.find((s) => s.kind !== "separator" && (typeof text === "string" ? s.text === text : text.test(s.text)));
const run = (spec: MenuItemSpec | undefined) => { if (spec && (spec.kind === "item" || spec.kind === "check")) spec.action(); };

describe("track menus: Play Full Album", () => {
  it("joins the library album with Last.fm's in the queue menu", () => {
    const play = vi.fn();
    const row = find(buildContextMenuSpecs(queueTarget([5]), deps({ onPlayAlbumByName: play })), /full album/i);
    expect(row?.kind).toBe("submenu");
    if (row?.kind !== "submenu") return;
    expect(row.items.map((i) => (i.kind === "item" ? i.text : i.kind))).toEqual(["Library", "Last.fm"]);
    run(row.items[0]);
    expect(play).toHaveBeenCalledWith({ albumTitle: "Fallen", artistName: "Evanescence" });
  });

  it("offers the library album alone when no plugin does, in the library track menu", () => {
    const target: ContextMenuTarget = { kind: "track", trackId: 7, title: "Going Under", artistName: "Evanescence", albumTitle: "Fallen" };
    expect(find(buildContextMenuSpecs(target, deps({ menuItems: [] })), /full album/i)).toMatchObject({ kind: "item", text: "Play Full Album" });
  });

  it("has no library row for a track without an album", () => {
    const target: ContextMenuTarget = { kind: "track", trackId: 7, title: "Going Under", artistName: "Evanescence", albumTitle: null };
    expect(find(buildContextMenuSpecs(target, deps({ menuItems: [] })), /full album/i)).toBeUndefined();
  });
});

describe("queue menu: details and editing", () => {
  it("a library entry gets Track Details, Go to Album and Edit Properties — no Edit info", () => {
    const handleTrackClick = vi.fn();
    const handleBulkEdit = vi.fn();
    const specs = buildContextMenuSpecs(queueTarget([5]), deps({ handleTrackClick, handleBulkEdit }));
    const t = texts(specs);
    expect(t).toContain("Track Details");
    expect(t).toContain("Go to Album");
    expect(t).toContain("Edit Properties…");
    expect(t).not.toContain("Edit info…");
    expect(t).not.toContain("Details");
    expect(t).not.toContain("View Details");
    run(find(specs, "Track Details"));
    expect(handleTrackClick).toHaveBeenCalledWith({ kind: "library", libraryId: 5 });
    run(find(specs, "Edit Properties…"));
    expect(handleBulkEdit).toHaveBeenCalled();
  });

  it("an entry outside the library gets Edit info and the id-less track page", () => {
    const handleTrackClick = vi.fn();
    const openEditTrackInfo = vi.fn();
    const specs = buildContextMenuSpecs(queueTarget([]), deps({ handleTrackClick, openEditTrackInfo, locate: "artist" }));
    const t = texts(specs);
    expect(t).toContain("Edit info…");
    expect(t).not.toContain("Edit Properties…");
    expect(t).toContain("Go to Artist");
    run(find(specs, "Track Details"));
    expect(handleTrackClick).toHaveBeenCalledWith({ kind: "entry", key: "q:1" });
    run(find(specs, "Edit info…"));
    expect(openEditTrackInfo).toHaveBeenCalledWith(0);
  });

  it("names the search fallback when the library has neither the album nor the artist", () => {
    expect(texts(buildContextMenuSpecs(queueTarget([]), deps({ locate: null })))).toContain("Find in Library");
  });

  it("a multi-selection edits the library tracks among it", () => {
    const specs = buildContextMenuSpecs(queueTarget([5, 6], [0, 1, 2]), deps({ queue: [queued(), queued(), queued()] }));
    const t = texts(specs);
    expect(t).toContain("Edit Properties (2 tracks)…");
    expect(t).not.toContain("Edit info…");
    expect(t).not.toContain("Track Details");
  });
});

describe("track menus: shared plugin actions sit with the host's actions", () => {
  const menuItems = [lastfmFullAlbum, ytdlpDownload, ffmpegInfo];

  it("in the queue menu, Download is above the plugin section and the plain item below it", () => {
    const t = texts(buildContextMenuSpecs(queueTarget([5]), deps({ menuItems })));
    const lastSep = t.lastIndexOf("---");
    expect(t.indexOf("Download (yt-dlp)")).toBeGreaterThan(-1);
    expect(t.indexOf("Download (yt-dlp)")).toBeLessThan(lastSep);
    expect(t.indexOf("FFmpeg Tools: Media Info")).toBeGreaterThan(lastSep);
  });

  it("in the library track menu too", () => {
    const target: ContextMenuTarget = { kind: "track", trackId: 7, title: "Going Under", artistName: "Evanescence", albumTitle: "Fallen" };
    const t = texts(buildContextMenuSpecs(target, deps({ menuItems })));
    expect(t.indexOf("Download (yt-dlp)")).toBeLessThan(t.lastIndexOf("---"));
    expect(t.indexOf("FFmpeg Tools: Media Info")).toBeGreaterThan(t.lastIndexOf("---"));
  });
});
