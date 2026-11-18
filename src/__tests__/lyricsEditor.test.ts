import { describe, it, expect } from "vitest";
import {
  parseEditorLines,
  serializeEditorLines,
  formatLrcTime,
  formatClock,
  stampInText,
  nudgeInText,
  clearAllTimes,
  lyricsStats,
  detectLyricsKind,
  firstUntimedIndex,
  nextSyncable,
  prevSyncable,
  syncableIndices,
  checkLyricsForSave,
} from "../utils/lyricsEditor";

const PLAIN = "First line\nSecond line\n\nThird line";

describe("parse / serialize", () => {
  it("round-trips any text byte for byte", () => {
    const lrc = "[ar:Someone]\n[00:01.500]First\n[00:05.20]Second\n\n[01:00.00]\nThird";
    expect(serializeEditorLines(parseEditorLines(lrc))).toBe(lrc);
    expect(serializeEditorLines(parseEditorLines(PLAIN))).toBe(PLAIN);
  });

  it("reads times, header tags and blank lines", () => {
    const lines = parseEditorLines("[ar:X]\n[00:01.50]A\n[02:03]B\nC\n");
    expect(lines[0]).toMatchObject({ meta: true, time: null });
    expect(lines[1]).toMatchObject({ time: 1.5, text: "A", meta: false });
    expect(lines[2]).toMatchObject({ time: 123, text: "B" });
    expect(lines[3]).toMatchObject({ time: null, text: "C" });
    expect(lines[4]).toMatchObject({ time: null, text: "" });
  });

  it("offers only sung lines for syncing", () => {
    const lines = parseEditorLines("[ar:X]\nA\n\n[00:10.00]\nB");
    expect(syncableIndices(lines)).toEqual([1, 4]);
  });
});

describe("time formatting", () => {
  it("spells LRC times as mm:ss.cc", () => {
    expect(formatLrcTime(0)).toBe("00:00.00");
    expect(formatLrcTime(83.456)).toBe("01:23.46");
    expect(formatLrcTime(59.999)).toBe("01:00.00");
    expect(formatLrcTime(-3)).toBe("00:00.00");
  });

  it("spells clock readouts as m:ss.d", () => {
    expect(formatClock(83.46)).toBe("1:23.5");
    expect(formatClock(5)).toBe("0:05.0");
  });
});

describe("stamping", () => {
  it("stamps one line and leaves the others untouched", () => {
    const text = "[00:01.500]Kept as typed\nNew line";
    expect(stampInText(text, 1, 4.2)).toBe("[00:01.500]Kept as typed\n[00:04.20]New line");
  });

  it("re-stamps and clears a timed line", () => {
    expect(stampInText("[00:01.00]A", 0, 2)).toBe("[00:02.00]A");
    expect(stampInText("[00:01.00]A", 0, null)).toBe("A");
  });

  it("nudges a timed line and never below zero", () => {
    expect(nudgeInText("[00:01.00]A", 0, 0.1)).toBe("[00:01.10]A");
    expect(nudgeInText("[00:00.05]A", 0, -1)).toBe("[00:00.00]A");
    expect(nudgeInText("A", 0, 1)).toBe("A");
  });

  it("start over removes every time and header", () => {
    expect(clearAllTimes("[ar:X]\n[00:01.00]A\n\n[00:02.00]B")).toBe("A\n\nB");
  });
});

describe("stats and kind", () => {
  it("counts timed and out-of-order lines", () => {
    const lines = parseEditorLines("[00:05.00]A\n[00:03.00]B\nC\n[00:09.00]D");
    expect(lyricsStats(lines)).toEqual({ lines: 4, timed: 3, outOfOrder: 1, firstOutOfOrder: 1 });
  });

  it("detects the kind from the text", () => {
    expect(detectLyricsKind(PLAIN)).toBe("plain");
    expect(detectLyricsKind("A\n[00:01.00]B")).toBe("synced");
    expect(detectLyricsKind("[ar:X]\nA")).toBe("plain");
    // A timed blank stanza break alone is not a synced lyric.
    expect(detectLyricsKind("[00:30.00]\nA\nB")).toBe("plain");
  });
});

describe("cursor", () => {
  const lines = parseEditorLines("[00:01.00]A\nB\n\nC");

  it("starts on the first untimed sung line", () => {
    expect(firstUntimedIndex(lines)).toBe(1);
    expect(firstUntimedIndex(parseEditorLines("[00:01.00]A"))).toBe(0);
    expect(firstUntimedIndex(parseEditorLines("\n"))).toBe(-1);
  });

  it("steps over blank lines", () => {
    expect(nextSyncable(lines, 1)).toBe(3);
    expect(nextSyncable(lines, 3)).toBe(-1);
    expect(prevSyncable(lines, 3)).toBe(1);
    expect(prevSyncable(lines, 0)).toBe(-1);
  });
});

describe("checkLyricsForSave", () => {
  it("reads the kind off the text", () => {
    expect(checkLyricsForSave("one\ntwo").kind).toBe("plain");
    const synced = checkLyricsForSave("[ar:X]\n[00:01.00]one\n\n[00:05.50]two");
    expect(synced.kind).toBe("synced");
    expect(synced.stats).toMatchObject({ lines: 2, timed: 2 });
    expect(synced.warnings).toEqual([]);
  });

  it("warns about untimed lines in a synced text but saves", () => {
    const r = checkLyricsForSave("[00:01.00]one\ntwo");
    expect(r.kind).toBe("synced");
    expect(r.warnings[0]).toMatch(/1 of 2 lines have no timestamp/);
  });

  it("refuses empty text and lines out of order, naming the first", () => {
    expect(() => checkLyricsForSave("  \n ")).toThrow(/empty/);
    expect(() => checkLyricsForSave("a".repeat(200_001))).toThrow(/longer than/);
    expect(() => checkLyricsForSave("[00:01.00]\n[ar:X]")).toThrow(/no lyric lines/);
    expect(() => checkLyricsForSave("[00:05.00]a\n[00:09.00]b\n[00:07.00]c")).toThrow(/line 3 "\[00:07.00\]c"/);
  });
});
