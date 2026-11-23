import { describe, expect, it } from "vitest";
import { lyricsFacts } from "../utils/lyricsFacts";

const song = { title: "Karma Police", artist: "Radiohead", album: "OK Computer", durationSecs: 264 };

describe("lyricsFacts", () => {
  it("lists the source's own names, length and timing", () => {
    const facts = lyricsFacts({
      text: "[00:12.00]Karma police\n[00:15.00]\n[04:10.50]For a minute there",
      kind: "synced",
      _meta: { providerName: "LRCLIB" },
      source: { title: "Karma Police", artist: "Radiohead", album: "OK Computer", durationSecs: 263.4 },
    }, song);
    expect(facts).toEqual([
      { label: "Source", value: "LRCLIB" },
      { label: "Title", value: "Karma Police", differs: false, hint: undefined },
      { label: "Artist", value: "Radiohead", differs: false, hint: undefined },
      { label: "Album", value: "OK Computer" },
      { label: "Length", value: "4:23 (−0:01)", differs: false, hint: undefined },
      { label: "Lines", value: "2 · last at 4:10", differs: false, hint: undefined },
    ]);
  });

  it("marks another title, artist or cut", () => {
    const facts = lyricsFacts({
      text: "[05:30.00]x", kind: "synced",
      source: { title: "Karma Police (Live)", artist: "Thom Yorke", durationSecs: 340 },
    }, song);
    const by = Object.fromEntries(facts.map((f) => [f.label, f]));
    expect(by.Title.differs).toBe(true);
    expect(by.Artist.differs).toBe(true);
    expect(by.Length).toMatchObject({ value: "5:40 (+1:16)", differs: true });
    expect(by.Lines.differs).toBe(true);
  });

  it("matches names case- and accent-insensitively", () => {
    const facts = lyricsFacts({ text: "a", kind: "plain", source: { title: "jóga", artist: "BJORK" } }, { title: "Jóga", artist: "Björk" });
    expect(facts.filter((f) => f.differs)).toEqual([]);
  });

  it("shows only what a plain copy without a source has", () => {
    expect(lyricsFacts({ text: "one\n\ntwo\n", kind: "plain", _meta: { providerName: "Lyrics.ovh" } }, song)).toEqual([
      { label: "Source", value: "Lyrics.ovh" },
      { label: "Lines", value: "2" },
    ]);
  });

  it("gives a length without a delta when the song's is unknown", () => {
    const facts = lyricsFacts({ kind: "plain", source: { durationSecs: 200 } }, { title: "x" });
    expect(facts).toEqual([{ label: "Length", value: "3:20", differs: false, hint: undefined }]);
  });
});
