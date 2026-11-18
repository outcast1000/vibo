import { describe, expect, it } from "vitest";
import { compactName } from "../utils/compactTitle";

describe("compactName", () => {
  it.each([
    ["Here Comes the Sun - Remastered 2009", "Here Comes the Sun"],
    ["Here Comes the Sun (Remastered 2009)", "Here Comes the Sun"],
    ["Bad Romance - 2011 Remaster - Single Version", "Bad Romance"],
    ["Could You Be Loved (with Stephen Marley)", "Could You Be Loved"],
    ["Stay (feat. Mikky Ekko)", "Stay"],
    ["Stay [ft. Mikky Ekko]", "Stay"],
    ["Stay feat. Mikky Ekko", "Stay"],
    ["Rihanna featuring Mikky Ekko", "Rihanna"],
    ["Abbey Road (Super Deluxe Edition)", "Abbey Road"],
    ["Rumours [2004 Remaster]", "Rumours"],
    ["Help! (2009)", "Help!"],
    ["Purple Rain - Single Version", "Purple Rain"],
    ["Song (Radio Edit) (feat. X)", "Song"],
  ])("%s → %s", (input, expected) => {
    expect(compactName(input)).toBe(expected);
  });

  it.each([
    "Hey Jude (Live)",
    "Blue Monday - 1988 Remix",
    "Layla (Acoustic)",
    "Hurt - Live at Wembley",
    "Artist - Song",
    "Love with a View",
    "Tom Petty and the Heartbreakers",
  ])("keeps %s", (input) => {
    expect(compactName(input)).toBe(input);
  });

  it("keeps a recording marker inside a remaster note", () => {
    expect(compactName("Song (Live, Remastered 2009)")).toBe("Song (Live, Remastered 2009)");
  });

  it("never returns an empty name", () => {
    expect(compactName("(Remastered)")).toBe("(Remastered)");
  });
});
