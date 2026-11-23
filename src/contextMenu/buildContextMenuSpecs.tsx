// Context-menu spec builder, extracted from App.tsx.
// Pure: given a context-menu target and the app dependencies it needs, returns
// the MenuItemSpec[] to display (or null when there's nothing to show). App.tsx
// keeps a thin useCallback wrapper that owns setContextMenu + showNativeMenu.
import type { MenuItemSpec } from "../nativeMenu";
import type { ContextMenuTarget } from "../types/contextMenu";
import type { PluginMenuItem } from "../types/plugin";
import { toPluginTarget } from "../types/contextMenu";
import { buildPluginMenuSpecs, mergeHostAction, splitSharedActions } from "./pluginMenuGroups";
import { buildGetFromProvidersSpec, type ProviderChoice } from "./providerMenus";
import { buildAddToPlaylistSubmenu } from "./addToPlaylistMenu";
import type { UserPlaylist } from "../hooks/useUserPlaylists";
import { isLocalTrack, librarySelection, queueTrackSelection } from "../queueEntry";
import type { useContextMenuActions } from "../hooks/useContextMenuActions";
import type { useLibrary } from "../hooks/useLibrary";
import type { usePlugins } from "../hooks/usePlugins";
import type { useQueue } from "../hooks/useQueue";
import type { useVideoLayout } from "../hooks/useVideoLayout";
import type { useImageCache } from "../hooks/useImageCache";

/** A track as Get lyrics needs it: its names, plus its file as a hint. */
export interface GetLyricsTrack {
  title: string;
  artistName?: string | null;
  albumTitle?: string | null;
  path?: string | null;
}

/** What the Get lyrics / Get image rows offer (switched-on providers, the
 *  user's order) and what they open — the Retrieve modal in "get" mode. */
export interface GetMenus {
  lyrics: ProviderChoice[];
  images: Record<"artist" | "album" | "tag", ProviderChoice[]>;
  openLyrics: (track: GetLyricsTrack, providerKey: string | null) => void;
  openImage: (kind: "artist" | "album" | "tag", name: string, artistName: string | null, providerKey: string | null) => void;
}

/** A track's album as Play Full Album needs it: its name and who it's by. */
export interface AlbumOfTrack {
  albumTitle: string;
  /** The album artist when known, else the track artist — albums are keyed by
   *  album artist, and `find_album_by_name` accepts either. */
  artistName: string | null;
}

function albumOf(albumTitle: string | null | undefined, artistName: string | null | undefined): AlbumOfTrack | null {
  return albumTitle ? { albumTitle, artistName: artistName ?? null } : null;
}

/**
 * The track menu's Play Full Album row: the library album, joined with any
 * plugin's "Play the Full Album" under one submenu (Library / Last.fm), the
 * same merge the now-playing bar's menu does. With no album named, no row and
 * the plugin items are returned untouched.
 */
function playFullAlbumSpec(
  d: ContextMenuDeps,
  album: AlbumOfTrack | null,
  pluginItems: PluginMenuItem[],
  pluginTarget: ReturnType<typeof toPluginTarget>,
): { spec: MenuItemSpec | null; rest: PluginMenuItem[] } {
  if (!album) return { spec: null, rest: pluginItems };
  return mergeHostAction(
    { action: "play-full-album", text: "Play Full Album", run: () => d.onPlayAlbumByName(album) },
    pluginItems, pluginTarget, d.plugins.dispatchContextMenuAction,
  );
}

/**
 * Push the plugins' shared-action rows that no host entry took (Download, Find
 * downloads, a plugin-only radio or full album) beside the host's own actions,
 * and return the plain items left for the plugin section at the bottom.
 */
function pushSharedActions(
  specs: MenuItemSpec[],
  pluginItems: PluginMenuItem[],
  pluginTarget: ReturnType<typeof toPluginTarget>,
  d: ContextMenuDeps,
): PluginMenuItem[] {
  const { shared, plain } = splitSharedActions(pluginItems);
  specs.push(...buildPluginMenuSpecs(shared, pluginTarget, d.plugins.dispatchContextMenuAction));
  return plain;
}

/** The track menu's Get lyrics row. */
export function getLyricsSpec(menus: GetMenus, track: GetLyricsTrack): MenuItemSpec {
  return buildGetFromProvidersSpec("Get lyrics", menus.lyrics, (key) => menus.openLyrics(track, key));
}

export interface ContextMenuDeps {
  contextMenuActions: ReturnType<typeof useContextMenuActions>;
  videoLayout: ReturnType<typeof useVideoLayout>;
  queueHook: ReturnType<typeof useQueue>;
  library: ReturnType<typeof useLibrary>;
  plugins: ReturnType<typeof usePlugins>;
  artistImageCache: ReturnType<typeof useImageCache>;
  albumImageCache: ReturnType<typeof useImageCache>;
  tagImageCache: ReturnType<typeof useImageCache>;
  /** Get lyrics / Get image: the providers to offer and the openers. */
  getMenus: GetMenus;
  setSearchInitialQuery: (q: string | null) => void;
  setSearchQueryKey: (fn: (k: number) => number) => void;
  setDeleteTagConfirm: (tags: { id: number; name: string }[] | null) => void;
  trashLabel: string;
  /** The user's own (mutable) playlists, for the "Add to Playlist ▸" submenu. */
  userPlaylists: UserPlaylist[];
  /** Append the target's tracks to an existing user playlist. */
  onAddToPlaylist: (playlistId: number, playlistName: string, target: ContextMenuTarget) => void;
  /** Create a new playlist from the target's tracks (opens the save modal). */
  onAddToNewPlaylist: (target: ContextMenuTarget) => void;
  /** Open the searchable playlist picker (the submenu caps its list). */
  onBrowsePlaylists: (target: ContextMenuTarget) => void;
  handleExportAsMixtapeRef: React.MutableRefObject<((trackIds: number[], defaultTitle?: string) => void) | null>;
  openPublishMusicSourceRef: React.MutableRefObject<((trackIds: number[]) => void) | null>;
  openEditTrackInfoRef: React.MutableRefObject<((queueIndex: number) => void) | null>;
  /** Play a track's album from the library, found by name (warns when absent). */
  onPlayAlbumByName: (album: AlbumOfTrack) => void;
}

// There are deliberately NO host download entries in any context menu: the
// host's only download is the now-playing button, which downloads the playing
// track from the source it is playing from. Nor are there per-provider entries
// ("Download from {X}…" / "Upgrade from {X}…") or batch entries
// ("Download N tracks" / "Download Album" rode the removed background download
// queue). Download flows differ too much between providers to share one host
// surface (a torrent hunt is nothing like a YouTube search), so a provider that
// wants a menu presence contributes its own context-menu item (plugin-first —
// e.g. qBittorrent's "qBittorrent: Upgrade…" opening its Music Search tab,
// yt-dlp's "yt-dlp: Download…").

/** Build the native context-menu specs for a target. Returns null if empty. */
export function buildContextMenuSpecs(target: ContextMenuTarget, d: ContextMenuDeps): MenuItemSpec[] | null {
    const specs: MenuItemSpec[] = [];

    if (target.kind === "video") {
      (["contain", "fit-width", "fit-height", "fill"] as const).forEach(mode => {
        specs.push({ kind: "check", text: mode === "contain" ? "Contain" : mode === "fit-width" ? "Fit Width" : mode === "fit-height" ? "Fit Height" : "Fill", checked: target.fitMode === mode, action: () => d.videoLayout.setFitMode(mode) });
      });
      specs.push({ kind: "separator" });
      (["top", "bottom", "left", "right", "queue"] as const).forEach(side => {
        const text = side === "queue" ? "Bottom of Queue" : side[0].toUpperCase() + side.slice(1);
        specs.push({ kind: "check", text, checked: target.dockSide === side, action: () => d.videoLayout.setDockSide(side) });
      });

      // Track actions for the playing video — same set the queue context menu
      // offers for a single QueueTrack. Ids resolve on demand at action time
      // (handleShowInFolder / handleDeleteRequest read the target's key/path).
      const t = target.track;
      if (t) {
        specs.push({ kind: "separator" });
        if (t.isLocal) {
          specs.push({ kind: "item", text: "Open Containing Folder", action: d.contextMenuActions.handleShowInFolder });
        }
        // Plugin-registered track actions (Universal Track Actions convention);
        // a plugin radio joins the library one under one "Start radio".
        const pluginTarget = toPluginTarget(target);
        const radio = mergeHostAction(
          { action: "radio", text: "Start radio from this track", run: () => d.contextMenuActions.startRadio({ title: t.title, artistName: t.artistName, coverPath: null }) },
          d.plugins.menuItems.filter(item => item.targets.includes("track")),
          pluginTarget, d.plugins.dispatchContextMenuAction,
        );
        specs.push(radio.spec);
        const album = playFullAlbumSpec(d, albumOf(t.albumTitle, t.artistName), radio.rest, pluginTarget);
        if (album.spec) specs.push(album.spec);
        specs.push(getLyricsSpec(d.getMenus, { title: t.title, artistName: t.artistName, albumTitle: t.albumTitle, path: t.path }));
        const plain = pushSharedActions(specs, album.rest, pluginTarget, d);
        const libId = t.libraryId;
        if (libId != null) {
          specs.push({ kind: "item", text: "Track Details", action: () => d.library.handleTrackClick(librarySelection(libId)) });
        }
        if (t.isLocal && d.contextMenuActions.handleDeleteRequest) {
          specs.push({ kind: "separator" });
          specs.push({ kind: "item", text: `Move to ${d.trashLabel}`, action: d.contextMenuActions.handleDeleteRequest });
        }
        const pluginSpecs = buildPluginMenuSpecs(plain, pluginTarget, d.plugins.dispatchContextMenuAction);
        if (pluginSpecs.length > 0) {
          specs.push({ kind: "separator" });
          specs.push(...pluginSpecs);
        }
      }
    } else if (target.kind === "queue-multi") {
      const count = target.indices.length;
      const selectedTracks = target.indices.map(i => d.queueHook.queue[i]).filter(Boolean);
      const pluginTargetKind = count === 1 ? "track" : "multi-track";
      const pluginTarget = toPluginTarget(target);
      // Plugin items still to lay out; a single track's radio takes its share.
      let pluginItems: PluginMenuItem[] = d.plugins.menuItems.filter(item => item.targets.includes(pluginTargetKind));

      // Queue operations — always available
      if (d.contextMenuActions.handleQueueRemove) {
        specs.push({ kind: "item", text: count > 1 ? `Remove ${count} tracks` : "Remove", action: d.contextMenuActions.handleQueueRemove });
      }
      if (d.contextMenuActions.handleQueueKeepOnly) {
        specs.push({ kind: "item", text: count > 1 ? `Keep only ${count} tracks` : "Keep only", action: d.contextMenuActions.handleQueueKeepOnly });
      }
      if (d.contextMenuActions.handleQueueMoveToTop) {
        specs.push({ kind: "item", text: "Move to top", action: d.contextMenuActions.handleQueueMoveToTop });
      }
      if (d.contextMenuActions.handleQueueMoveToBottom) {
        specs.push({ kind: "item", text: "Move to bottom", action: d.contextMenuActions.handleQueueMoveToBottom });
      }

      // Add to Playlist — queue entries are QueueTracks resolved in place, so
      // this works for id-less external entries too, not just library rows.
      specs.push({ kind: "separator" });
      specs.push(buildAddToPlaylistSubmenu(d.userPlaylists, {
        onPick: (id, name) => d.onAddToPlaylist(id, name, target),
        onNew: () => d.onAddToNewPlaylist(target),
        onBrowse: () => d.onBrowsePlaylists(target),
      }));

      // `trackIds` are the selected entries that are library tracks (their
      // cached row, or found by path when the menu opened), so a single entry
      // is a library track exactly when it has one.
      const libraryId = count === 1 ? target.trackIds[0] ?? null : null;

      // Single-track actions
      const queued = count === 1 ? d.queueHook.queue[target.indices[0]] : undefined;
      if (queued) {
        // Track Details — the track's own page; an entry outside the library
        // gets the id-less page (queueTrackSelection), like the queue row's ⓘ.
        specs.push({ kind: "item", text: "Track Details", action: () => {
          d.library.handleTrackClick(libraryId != null ? librarySelection(libraryId) : queueTrackSelection(queued));
        } });
        // Go to Album / Artist — the library page the song belongs to; a song
        // the library has neither for is searched for instead.
        const locate = d.library.locateTrackTarget(queued.artist_name, queued.album_title ?? null);
        specs.push({ kind: "item", text: locate === "album" ? "Go to Album" : locate === "artist" ? "Go to Artist" : "Find in Library", action: () => {
          d.library.handleLocateTrack(queued.title, queued.artist_name, queued.album_title ?? null, () => {
            d.setSearchInitialQuery(queued.title);
            d.setSearchQueryKey(k => k + 1);
            d.library.setView("search");
            d.library.setSelectedArtist(null);
            d.library.setSelectedAlbum(null);
            d.library.setSelectedTag(null);
          });
        } });
      }

      // Edit Properties writes the library track's file tags; an entry outside
      // the library has no file to write, so it gets Edit info instead — a fix
      // to this queue entry's names only (e.g. a yt-dlp title), which never
      // touches library rows or files. The two are never offered together.
      if (target.trackIds.length > 0 && d.contextMenuActions.handleBulkEdit) {
        specs.push({ kind: "item", text: count > 1 ? `Edit Properties (${target.trackIds.length} tracks)…` : "Edit Properties…", action: d.contextMenuActions.handleBulkEdit });
      } else if (queued && d.openEditTrackInfoRef.current) {
        specs.push({ kind: "item", text: "Edit info…", action: () => d.openEditTrackInfoRef.current?.(target.indices[0]) });
      }

      if (queued) {
        if (target.firstTrack.isLocal) {
          specs.push({ kind: "item", text: "Open Containing Folder", action: d.contextMenuActions.handleShowInFolder });
        }
        // Start radio from this track (single track only), joined by any
        // plugin radio.
        const radio = mergeHostAction({ action: "radio", text: "Start radio from this track", run: () => {
          d.contextMenuActions.startRadio({
            title: queued.title,
            artistName: queued.artist_name,
            coverPath: queued.image_url ?? null,
          });
        }}, pluginItems, pluginTarget, d.plugins.dispatchContextMenuAction);
        specs.push(radio.spec);
        pluginItems = radio.rest;
        const album = playFullAlbumSpec(d, albumOf(queued.album_title, queued.album_artist_name ?? queued.artist_name), pluginItems, pluginTarget);
        if (album.spec) specs.push(album.spec);
        pluginItems = album.rest;
        specs.push(getLyricsSpec(d.getMenus, { title: queued.title, artistName: queued.artist_name, albumTitle: queued.album_title, path: queued.path }));
      }
      pluginItems = pushSharedActions(specs, pluginItems, pluginTarget, d);

      // Move to Trash — local tracks only
      if (d.contextMenuActions.handleDeleteRequest) {
        // Any local (file://) track is deletable: the library id is resolved
        // from the path at action time (handleDeleteRequest), so id-less
        // entries — restored, m3u-loaded, home-shelf — work too, and a file in
        // no collection (dropped in from Finder) is trashed by its path.
        const localDeletable = selectedTracks.filter(t => isLocalTrack(t));
        if (localDeletable.length > 0) {
          specs.push({ kind: "separator" });
          const deleteLabel = localDeletable.length === 1 ? `Move to ${d.trashLabel}` : `Move ${localDeletable.length} local tracks to ${d.trashLabel}`;
          specs.push({ kind: "item", text: deleteLabel, action: d.contextMenuActions.handleDeleteRequest });
        }
      }

      // Plugin actions
      const pluginSpecs = buildPluginMenuSpecs(pluginItems, pluginTarget, d.plugins.dispatchContextMenuAction);
      if (pluginSpecs.length > 0) {
        specs.push({ kind: "separator" });
        specs.push(...pluginSpecs);
      }
    } else if (target.kind === "multi-album" || target.kind === "multi-artist" || target.kind === "multi-tag") {
      const count = target.kind === "multi-album" ? target.albumIds.length
                  : target.kind === "multi-artist" ? target.artistIds.length
                  : target.tagIds.length;
      const label = target.kind === "multi-album" ? "albums" : target.kind === "multi-artist" ? "artists" : "tags";
      specs.push({ kind: "item", text: `Play ${count} ${label}`, action: d.contextMenuActions.handleContextPlay });
      specs.push({ kind: "item", text: `Enqueue ${count} ${label}`, action: d.contextMenuActions.handleContextEnqueue });
      if (target.kind === "multi-tag") {
        const tagsToDelete = target.tagIds.map(id => {
          const tag = d.library.tags.find(t => t.id === id);
          return { id, name: tag?.name ?? "Unknown" };
        });
        specs.push({ kind: "separator" });
        specs.push({ kind: "item", text: `Delete ${count} tags`, action: () => {
          d.setDeleteTagConfirm(tagsToDelete);
        }});
      }
    } else {
      const isMulti = target.kind === "multi-track";
      const pluginTarget = toPluginTarget(target);
      // Plugin items still to lay out; the track radio takes its share.
      let pluginItems: PluginMenuItem[] = d.plugins.menuItems.filter(item => item.targets.includes(target.kind as "track" | "album" | "artist" | "multi-track"));
      const hasId = target.kind === "artist" ? !!target.artistId
                  : target.kind === "album" ? !!target.albumId
                  : target.kind === "track" ? !!target.trackId
                  : target.kind === "tag" ? !!target.tagId
                  : true;

      if (hasId) {
        specs.push({ kind: "item", text: isMulti ? `Play ${target.trackIds.length} tracks` : "Play", action: d.contextMenuActions.handleContextPlay });
        specs.push({ kind: "item", text: isMulti ? `Enqueue ${target.trackIds.length} tracks` : "Enqueue", action: d.contextMenuActions.handleContextEnqueue });
      }
      // Add to Playlist — track/multi-track/album selections append to a user
      // playlist (duplicates skipped backend-side) or seed a new one. Gated on
      // hasId like Play/Enqueue: a metadata-only row can't resolve to sources.
      if (hasId && (target.kind === "track" || target.kind === "multi-track" || target.kind === "album")) {
        specs.push(buildAddToPlaylistSubmenu(d.userPlaylists, {
          onPick: (id, name) => d.onAddToPlaylist(id, name, target),
          onNew: () => d.onAddToNewPlaylist(target),
          onBrowse: () => d.onBrowsePlaylists(target),
        }));
      }
      // Get image: from any switched-on image provider, confirmed before it's
      // saved. Entity images are keyed by name, so no library id is needed.
      if (target.kind === "artist" || target.kind === "album" || target.kind === "tag") {
        const kind = target.kind;
        const name = target.kind === "album" ? target.title : target.name;
        const artistName = target.kind === "album" ? target.artistName ?? null : null;
        if (name) {
          specs.push(buildGetFromProvidersSpec("Get image", d.getMenus.images[kind], (key) => d.getMenus.openImage(kind, name, artistName, key)));
        }
      }
      if (target.kind === "track" && target.title) {
        // Track Details — the library row's page, or, for a row with no id (a
        // "Not in library" row, a plugin's result), the page found by name.
        // Captured, not read off `target` inside the closure: the guard's
        // narrowing doesn't survive into a deferred callback.
        const { trackId, title, artistName, albumTitle } = target;
        specs.push({ kind: "item", text: "Track Details", action: () => {
          if (trackId) d.library.handleTrackClick(librarySelection(trackId));
          else d.library.navigateToTrackByName(title, artistName ?? undefined, albumTitle ?? undefined)
            .catch((e) => console.error("Failed to open track details:", e));
        } });
      }
      if (d.contextMenuActions.handleBulkEdit && (isMulti || (target.kind === "track" && target.trackId))) {
        specs.push({ kind: "item", text: "Edit Properties…", action: d.contextMenuActions.handleBulkEdit });
      }
      if (target.kind === "track" && target.isLocal) {
        specs.push({ kind: "item", text: "Open Containing Folder", action: d.contextMenuActions.handleShowInFolder });
      }
      if (target.kind === "track" && target.title) {
        const radio = mergeHostAction({ action: "radio", text: "Start radio from this track", run: () => {
          if (target.kind !== "track") return;
          d.contextMenuActions.startRadio({
            title: target.title,
            artistName: target.artistName,
            coverPath: null,
          });
        }}, pluginItems, pluginTarget, d.plugins.dispatchContextMenuAction);
        specs.push(radio.spec);
        pluginItems = radio.rest;
        const album = playFullAlbumSpec(d, albumOf(target.albumTitle, target.artistName), pluginItems, pluginTarget);
        if (album.spec) specs.push(album.spec);
        pluginItems = album.rest;
        specs.push(getLyricsSpec(d.getMenus, { title: target.title, artistName: target.artistName, albumTitle: target.albumTitle }));
      }
      pluginItems = pushSharedActions(specs, pluginItems, pluginTarget, d);
      // A `track` target carries no path, so it can only be deleted by id —
      // without one the item would do nothing (id-less queue entries are
      // deleted from the queue's own menu, which trashes them by path).
      if (d.contextMenuActions.handleDeleteRequest && (target.kind === "track" && target.isLocal && target.trackId || target.kind === "multi-track")) {
        if (target.kind === "track") {
          specs.push({ kind: "separator" });
          specs.push({ kind: "item", text: `Move to ${d.trashLabel}`, action: d.contextMenuActions.handleDeleteRequest });
        } else {
          // Prefer the paths carried on the target — `library.tracks` is empty
          // outside an active track search (and paginated even then), so gating
          // on it hid the delete item for multi-selections on detail pages.
          const localCount = target.tracks
            ? target.tracks.filter(isLocalTrack).length
            : d.library.tracks.filter(t => target.trackIds.includes(t.id!) && isLocalTrack(t)).length;
          if (localCount > 0) {
            specs.push({ kind: "separator" });
            specs.push({ kind: "item", text: `Move ${localCount} local track${localCount > 1 ? "s" : ""} to ${d.trashLabel}`, action: d.contextMenuActions.handleDeleteRequest });
          }
        }
      }
      const pluginSpecs = buildPluginMenuSpecs(pluginItems, pluginTarget, d.plugins.dispatchContextMenuAction);
      if (pluginSpecs.length > 0) {
        specs.push({ kind: "separator" });
        specs.push(...pluginSpecs);
      }
      if (isMulti && d.handleExportAsMixtapeRef.current) {
        specs.push({ kind: "separator" });
        specs.push({ kind: "item", text: "Export as Mixtape", action: () => d.handleExportAsMixtapeRef.current?.(target.trackIds) });
      }
      if (d.openPublishMusicSourceRef.current) {
        if (isMulti) {
          specs.push({ kind: "item", text: "Publish as music source…", action: () => d.openPublishMusicSourceRef.current?.(target.trackIds) });
        } else if (target.kind === "track" && target.isLocal && target.trackId != null) {
          const id = target.trackId;
          specs.push({ kind: "item", text: "Publish as music source…", action: () => d.openPublishMusicSourceRef.current?.([id]) });
        }
      }
      if (target.kind === "tag" && target.tagId) {
        specs.push({ kind: "separator" });
        specs.push({ kind: "item", text: "Delete Tag", action: () => {
          d.setDeleteTagConfirm([{ id: target.tagId, name: target.name }]);
        }});
      }
    }

  return specs.length === 0 ? null : specs;
}
