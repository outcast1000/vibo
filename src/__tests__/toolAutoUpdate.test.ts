import { describe, expect, it } from "vitest";
import {
  AUTO_UPDATE_OFFER_WINDOW_MS,
  announcedToolUpdates,
  autoAttemptDownloaded,
  autoUpdateStatusLine,
  autoUpdates,
  coerceToolSightings,
  pickAutoUpdateOffer,
  recordToolSightings,
  type ToolAutoUpdateState,
} from "../utils/toolAutoUpdate";

const state = (over: Partial<ToolAutoUpdateState> = {}): ToolAutoUpdateState => ({
  name: "yt-dlp",
  enabled: false,
  offerDeclined: false,
  consecutiveFailures: 0,
  disabledByFailures: false,
  ...over,
});

const DAY = 24 * 60 * 60 * 1000;

describe("autoUpdates", () => {
  it("is true only when switched on and allowed", () => {
    expect(autoUpdates(undefined)).toBe(false);
    expect(autoUpdates(state())).toBe(false);
    expect(autoUpdates(state({ enabled: true }))).toBe(true);
    // A tool that became a background program since: back to the notice.
    expect(autoUpdates(state({ enabled: true, ineligible: "service" }))).toBe(false);
  });
});

describe("announcedToolUpdates", () => {
  const outdated = { name: "yt-dlp", installed: "1", latest: "2", outdated: true, origin: "managed" };

  it("announces an outdated managed copy", () => {
    expect(announcedToolUpdates([outdated], {}, () => false)).toEqual([
      { name: "yt-dlp", installed: "1", latest: "2", running: false },
    ]);
  });

  it("leaves out a tool that updates itself", () => {
    expect(announcedToolUpdates([outdated], { "yt-dlp": state({ enabled: true }) }, () => false)).toEqual([]);
  });

  it("announces it again once Rust stops allowing it", () => {
    const refused = { "yt-dlp": state({ enabled: true, ineligible: "source-mismatch" as const }) };
    expect(announcedToolUpdates([outdated], refused, () => false)).toHaveLength(1);
    // Switched off by failures: enabled is false, so it is announced.
    const failed = { "yt-dlp": state({ disabledByFailures: true }) };
    expect(announcedToolUpdates([outdated], failed, () => false)).toHaveLength(1);
  });

  it("never announces a system copy, a moved source or an up-to-date one", () => {
    expect(announcedToolUpdates([{ ...outdated, origin: "system" }], {}, () => false)).toEqual([]);
    expect(announcedToolUpdates([{ ...outdated, sourceMismatch: true }], {}, () => false)).toEqual([]);
    expect(announcedToolUpdates([{ ...outdated, outdated: false }], {}, () => false)).toEqual([]);
  });
});

describe("autoAttemptDownloaded", () => {
  it("is true only for attempts that drew a progress row", () => {
    expect(autoAttemptDownloaded({ status: "installed", to: "2", restartErrors: [] })).toBe(true);
    expect(autoAttemptDownloaded({ status: "failed", error: "x", switchedOff: false })).toBe(true);
    // Verified, then thrown away because the tool was running at swap time.
    expect(autoAttemptDownloaded({ status: "skipped", reason: "in-use", retryLater: true })).toBe(true);
    // The user's own install holds the row.
    expect(autoAttemptDownloaded({ status: "skipped", reason: "busy", retryLater: true })).toBe(false);
    expect(autoAttemptDownloaded({ status: "skipped", reason: "too-soon", retryLater: false })).toBe(false);
  });
});

describe("coerceToolSightings", () => {
  it("keeps only well-formed entries", () => {
    expect(coerceToolSightings(null)).toEqual({});
    expect(coerceToolSightings([])).toEqual({});
    expect(
      coerceToolSightings({ "yt-dlp": [{ version: "1", at: 2 }, { version: 3 }, null], bad: "x" }),
    ).toEqual({ "yt-dlp": [{ version: "1", at: 2 }] });
  });
});

describe("recordToolSightings", () => {
  it("records each distinct version once", () => {
    let s = recordToolSightings({}, [{ name: "yt-dlp", latest: "1" }], 0);
    const same = recordToolSightings(s, [{ name: "yt-dlp", latest: "1" }], 10);
    expect(same).toBe(s);
    s = recordToolSightings(s, [{ name: "yt-dlp", latest: "2" }], 20);
    expect(s["yt-dlp"].map((x) => x.version)).toEqual(["1", "2"]);
  });

  it("forgets sightings older than the window", () => {
    const s = recordToolSightings({}, [{ name: "yt-dlp", latest: "1" }], 0);
    const later = recordToolSightings(s, [{ name: "yt-dlp", latest: "2" }], AUTO_UPDATE_OFFER_WINDOW_MS + 1);
    expect(later["yt-dlp"].map((x) => x.version)).toEqual(["2"]);
  });
});

describe("pickAutoUpdateOffer", () => {
  const announced = [{ name: "yt-dlp" }];
  const threeNights = {
    "yt-dlp": [
      { version: "a", at: 0 },
      { version: "b", at: DAY },
      { version: "c", at: 2 * DAY },
    ],
  };

  it("offers a tool announced three times in two weeks", () => {
    expect(pickAutoUpdateOffer(announced, threeNights, { "yt-dlp": state() }, 3 * DAY)).toBe("yt-dlp");
  });

  it("doesn't offer a tool that updates rarely", () => {
    const two = { "yt-dlp": threeNights["yt-dlp"].slice(0, 2) };
    expect(pickAutoUpdateOffer(announced, two, { "yt-dlp": state() }, 3 * DAY)).toBeNull();
    // Three, but spread over more than the window.
    expect(pickAutoUpdateOffer(announced, threeNights, { "yt-dlp": state() }, 15 * DAY)).toBeNull();
  });

  it("never offers what is on, declined, refused, unknown or not announced now", () => {
    const now = 3 * DAY;
    expect(pickAutoUpdateOffer(announced, threeNights, { "yt-dlp": state({ enabled: true }) }, now)).toBeNull();
    expect(pickAutoUpdateOffer(announced, threeNights, { "yt-dlp": state({ offerDeclined: true }) }, now)).toBeNull();
    expect(pickAutoUpdateOffer(announced, threeNights, { "yt-dlp": state({ ineligible: "unverified" }) }, now)).toBeNull();
    expect(pickAutoUpdateOffer(announced, threeNights, {}, now)).toBeNull();
    expect(pickAutoUpdateOffer([], threeNights, { "yt-dlp": state() }, now)).toBeNull();
  });
});

describe("autoUpdateStatusLine", () => {
  const fmt = () => "today";

  it("says nothing for a tool that never updated itself", () => {
    expect(autoUpdateStatusLine(state(), fmt)).toBeNull();
    expect(autoUpdateStatusLine(undefined, fmt)).toBeNull();
  });

  it("reports the last automatic install", () => {
    const line = autoUpdateStatusLine(state({ enabled: true, lastInstall: { from: "1", to: "2", at: 5 } }), fmt);
    expect(line).toEqual({ tone: "info", text: "Updated automatically 1 → 2 · today" });
  });

  it("puts a failure ahead of the last success", () => {
    const line = autoUpdateStatusLine(
      state({ enabled: true, lastError: "network down", lastInstall: { to: "2", at: 5 } }),
      fmt,
    );
    expect(line?.tone).toBe("error");
    expect(line?.text).toContain("network down");
  });

  it("explains a switch-off by failures", () => {
    const line = autoUpdateStatusLine(state({ disabledByFailures: true, consecutiveFailures: 2, lastError: "x" }), fmt);
    expect(line?.tone).toBe("error");
    expect(line?.text).toContain("turned off after 2 failed attempts");
  });
});
