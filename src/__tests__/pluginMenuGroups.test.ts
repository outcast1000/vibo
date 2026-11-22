import { describe, it, expect, vi } from "vitest";
import { buildPluginMenuSpecs, HOST_PROVIDER_LABEL, layoutPluginMenu, mergeHostAction, withPluginName, type PluginMenuNode } from "../contextMenu/pluginMenuGroups";
import type { MenuItemSpec } from "../nativeMenu";
import type { PluginMenuItem, PluginContextMenuTarget } from "../types/plugin";

const target: PluginContextMenuTarget = { kind: "artist", artistName: "Artist" };

const item = (pluginId: string, pluginName: string, id: string, label: string, extra: Partial<PluginMenuItem> = {}): PluginMenuItem =>
  ({ pluginId, pluginName, id, label, targets: ["track"], ...extra });

/** Render a node tree as nested labels: "Leaf" or { "Submenu": [...] }. */
type Shape = string | { [submenu: string]: Shape[] };
const shape = (nodes: PluginMenuNode[]): Shape[] =>
  nodes.map((n) => (n.kind === "leaf" ? n.text : { [n.text]: shape(n.children) }));

describe("layoutPluginMenu", () => {
  it("collapses the crowded track menu to one row per plugin", () => {
    // The track menu from the issue screenshot: 7 plugins, 10 top-level rows.
    const items: PluginMenuItem[] = [
      item("llm", "AI Assistant", "ask", "Ask AI about this…"),
      item("llm", "AI Assistant", "titles", "Clean up titles…"),
      item("ytdlp", "yt-dlp", "dl", "Download…"),
      item("llm", "AI Assistant", "better", "Find better copies…"),
      item("lastfm", "Last.fm", "full", "Play the Full Album", { action: "play-full-album" }),
      item("ytdlp", "yt-dlp", "watch", "Watch YouTube video"),
      item("ffmpeg", "FFmpeg Tools", "info", "Media Info (FFmpeg)"),
      item("spotify", "Spotify", "radio", "Start radio", { action: "radio" }),
      item("spotify", "Spotify", "full", "Play the Full Album", { action: "play-full-album" }),
      item("ffmpeg", "FFmpeg Tools", "mp3", "MP3", { submenuLabel: "Convert to…", order: 1 }),
      item("ffmpeg", "FFmpeg Tools", "flac", "FLAC", { submenuLabel: "Convert to…", order: 0 }),
    ];
    expect(shape(layoutPluginMenu(items))).toEqual([
      { "AI Assistant": ["Ask AI about this…", "Clean up titles…", "Find better copies…"] },
      { "FFmpeg Tools": ["Media Info (FFmpeg)", { "Convert to…": ["FLAC", "MP3"] }] },
      { "Play the Full Album": ["Last.fm", "Spotify"] },
      "Start radio (Spotify)",
      { "yt-dlp": ["Download…", "Watch YouTube video"] },
    ]);
  });

  it("groups a shared action under the host's title, whatever the plugins call it", () => {
    const items: PluginMenuItem[] = [
      item("b", "Beta", "x", "Beta Radio", { action: "radio" }),
      item("a", "Alpha", "y", "Start radio…", { action: "radio" }),
    ];
    expect(shape(layoutPluginMenu(items))).toEqual([{ "Start radio": ["Alpha", "Beta"] }]);
  });

  it("names a lone provider of a shared action by the action, so the row keeps its place", () => {
    const items: PluginMenuItem[] = [
      item("lastfm", "Last.fm", "radio", "Start radio", { action: "radio" }),
      item("lastfm", "Last.fm", "love", "Love"),
    ];
    // The radio leaves Last.fm's own row; what's left of Last.fm stays flat.
    expect(shape(layoutPluginMenu(items))).toEqual(["Last.fm: Love", "Start radio (Last.fm)"]);
  });

  it("does not merge same-label items that declare no action", () => {
    const items: PluginMenuItem[] = [
      item("b", "Beta", "x", "Play the Full Album"),
      item("a", "Alpha", "y", "Play the Full Album"),
    ];
    expect(shape(layoutPluginMenu(items))).toEqual(["Alpha: Play the Full Album", "Beta: Play the Full Album"]);
  });

  it("ignores an unknown action rather than starting a group of one", () => {
    const items = [
      item("a", "Alpha", "x", "Do it", { action: "typo" as never }),
      item("b", "Beta", "y", "Do it", { action: "typo" as never }),
    ];
    expect(shape(layoutPluginMenu(items))).toEqual(["Alpha: Do it", "Beta: Do it"]);
  });

  it("nests a plugin that offers one action more than once under its own name", () => {
    const items: PluginMenuItem[] = [
      item("a", "Alpha", "song", "Song radio", { action: "radio" }),
      item("a", "Alpha", "artist", "Artist radio", { action: "radio" }),
      item("b", "Beta", "r", "Start radio", { action: "radio" }),
    ];
    expect(shape(layoutPluginMenu(items))).toEqual([
      { "Start radio": [{ Alpha: ["Artist radio", "Song radio"] }, "Beta"] },
    ]);
  });

  it("groups the download plugins' items under Download and Find downloads", () => {
    // The live track menu with the download plugins (2026-11-22).
    const items: PluginMenuItem[] = [
      item("ytdlp", "yt-dlp", "ytdlp-watch-video", "Watch YouTube video"),
      item("ytdlp", "yt-dlp", "ytdlp-download-track", "Download…", { action: "download" }),
      item("rqbit", "rqbit", "rqbit-find-torrents", "Find torrents…", { action: "find-source" }),
      item("rqbit", "rqbit", "rqbit-download", "Download…", { action: "download" }),
      item("slskd", "Soulseek", "slskd-download", "Download", { action: "download", order: 0 }),
      item("slskd", "Soulseek", "slskd-download-choose", "Download and let me choose…", { action: "download", order: 1 }),
      item("qbittorrent", "qBittorrent", "qbt-find-torrents", "Find torrents…", { action: "find-source" }),
      item("qbittorrent", "qBittorrent", "qbt-upgrade", "Upgrade…", { action: "download" }),
    ];
    expect(shape(layoutPluginMenu(items))).toEqual([
      { Download: ["qBittorrent", "rqbit", { Soulseek: ["Download", "Download and let me choose…"] }, "yt-dlp"] },
      { "Find downloads": ["qBittorrent", "rqbit"] },
      "yt-dlp: Watch YouTube video",
    ]);
  });

  it("keeps a single-entry plugin flat and names it, including a lone submenu group", () => {
    const items: PluginMenuItem[] = [
      item("lastfm", "Last.fm", "full", "Play the Full Album"),
      item("ytdlp", "yt-dlp", "mp3", "MP3", { submenuLabel: "Download as" }),
      item("ytdlp", "yt-dlp", "flac", "FLAC", { submenuLabel: "Download as" }),
    ];
    expect(shape(layoutPluginMenu(items))).toEqual([
      "Last.fm: Play the Full Album",
      { "yt-dlp: Download as": ["FLAC", "MP3"] },
    ]);
  });

  it("does not merge two same-label items from one plugin", () => {
    const items: PluginMenuItem[] = [
      item("a", "Alpha", "x", "Do it"),
      item("a", "Alpha", "y", "Do it"),
    ];
    expect(shape(layoutPluginMenu(items))).toEqual([{ Alpha: ["Do it", "Do it"] }]);
  });

  it("keeps a submenuLabel group shared by several plugins at top level, leaves named", () => {
    const items: PluginMenuItem[] = [
      item("a", "Alpha", "s1", "Google", { submenuLabel: "Search" }),
      item("b", "Beta", "s2", "Bing", { submenuLabel: "Search" }),
    ];
    expect(shape(layoutPluginMenu(items))).toEqual([{ Search: ["Beta: Bing", "Alpha: Google"] }]);
  });

  it("falls back to the plugin id when no name was stamped", () => {
    const items: PluginMenuItem[] = [
      { pluginId: "p", id: "1", label: "One", targets: ["track"] },
      { pluginId: "p", id: "2", label: "Two", targets: ["track"] },
    ];
    expect(shape(layoutPluginMenu(items))).toEqual([{ p: ["One", "Two"] }]);
  });

  it("returns [] for no items", () => {
    expect(layoutPluginMenu([])).toEqual([]);
  });
});

describe("buildPluginMenuSpecs", () => {
  it("renders the layout as native specs and dispatches leaves to their plugin", () => {
    const dispatch = vi.fn();
    const items: PluginMenuItem[] = [
      item("lastfm", "Last.fm", "full", "Play the Full Album", { action: "play-full-album" }),
      item("spotify", "Spotify", "full-sp", "Play the Full Album", { action: "play-full-album" }),
      item("zz", "Zephyr", "scrobble", "Scrobble"),
    ];
    const specs = buildPluginMenuSpecs(items, target, dispatch);
    const text = (s: MenuItemSpec) => (s.kind === "item" || s.kind === "submenu" ? s.text : "");
    expect(specs.map(text)).toEqual(["Play the Full Album", "Zephyr: Scrobble"]);

    const shared = specs[0];
    if (shared.kind !== "submenu") throw new Error("expected a submenu");
    expect(shared.items.map(text)).toEqual(["Last.fm", "Spotify"]);
    const spotify = shared.items[1];
    if (spotify.kind === "item") spotify.action();
    expect(dispatch).toHaveBeenCalledWith("spotify", "full-sp", target);
  });

  it("returns [] for no matching items", () => {
    expect(buildPluginMenuSpecs([], target, vi.fn())).toEqual([]);
  });
});

describe("mergeHostAction", () => {
  const text = (s: MenuItemSpec) => (s.kind === "item" || s.kind === "submenu" ? s.text : "");

  it("keeps the host entry as it was when no plugin offers the action", () => {
    const run = vi.fn();
    const items = [item("lastfm", "Last.fm", "full", "Play the Full Album", { action: "play-full-album" })];
    const { spec, rest } = mergeHostAction({ action: "radio", text: "Start radio from this track", run }, items, target, vi.fn());
    expect(spec.kind === "item" && spec.text).toBe("Start radio from this track");
    if (spec.kind === "item") spec.action();
    expect(run).toHaveBeenCalled();
    expect(rest).toBe(items);
  });

  it("joins the plugins' items under the action's title, Library first, and takes them out of the rest", () => {
    const run = vi.fn();
    const dispatch = vi.fn();
    const items: PluginMenuItem[] = [
      item("spotify", "Spotify", "sp-radio", "Start radio", { action: "radio" }),
      item("lastfm", "Last.fm", "lfm-radio", "Start radio", { action: "radio" }),
      item("lastfm", "Last.fm", "full", "Play the Full Album", { action: "play-full-album" }),
      item("zz", "Zephyr", "radio-ish", "Start radio"), // no action: not joined
    ];
    const { spec, rest } = mergeHostAction({ action: "radio", text: "Start radio from this track", run }, items, target, dispatch);
    if (spec.kind !== "submenu") throw new Error("expected a submenu");
    expect(spec.text).toBe("Start radio");
    expect(spec.items.map(text)).toEqual([HOST_PROVIDER_LABEL, "Last.fm", "Spotify"]);
    const [library, lastfm] = spec.items;
    if (library.kind === "item") library.action();
    if (lastfm.kind === "item") lastfm.action();
    expect(run).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith("lastfm", "lfm-radio", target);
    expect(rest.map((it) => it.id)).toEqual(["full", "radio-ish"]);
  });

  it("joins a single plugin too, so a radio is always one row", () => {
    const items = [item("lastfm", "Last.fm", "lfm-radio", "Start radio", { action: "radio" })];
    const { spec, rest } = mergeHostAction({ action: "radio", text: "Start radio from this track", run: vi.fn() }, items, target, vi.fn());
    expect(spec.kind === "submenu" && spec.items.map(text)).toEqual([HOST_PROVIDER_LABEL, "Last.fm"]);
    expect(rest).toEqual([]);
  });
});

describe("withPluginName", () => {
  it("prefixes the owning plugin's name, unless the label already carries it", () => {
    expect(withPluginName("Play the Full Album", "Last.fm")).toBe("Last.fm: Play the Full Album");
    expect(withPluginName("Upgrade with qBittorrent…", "qBittorrent")).toBe("Upgrade with qBittorrent…");
    expect(withPluginName("Scrobble", undefined)).toBe("Scrobble");
    // A label the plugin name already contains collapses to the name ("Web Search: Search").
    expect(withPluginName("Search", "Web Search")).toBe("Web Search");
  });
});
