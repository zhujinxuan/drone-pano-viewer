import { describe, expect, it } from "vitest";
import { applyPlaylist, parsePlaylist } from "./playlist.ts";
import type { PhotoEntry } from "./types.ts";

function photo(id: string, relPath = `${id}.jpg`): PhotoEntry {
  return {
    id,
    name: `${id}.jpg`,
    relPath,
    url: `/photos/${id}.jpg`,
    lon: null,
    lat: null,
  };
}

describe("parsePlaylist", () => {
  it("parses an array of {id, title?} entries", () => {
    const out = parsePlaylist(
      JSON.stringify([
        { id: "wx4g0e6z", title: "机位1" },
        { id: "wx4g0e6y" },
      ]),
    );
    expect(out).toEqual([
      { id: "wx4g0e6z", title: "机位1" },
      { id: "wx4g0e6y" },
    ]);
  });

  it("rejects non-array JSON with a clear message", () => {
    expect(() => parsePlaylist('{"id": "x"}')).toThrow(/playlist must be a JSON array/i);
    expect(() => parsePlaylist("42")).toThrow(/playlist must be a JSON array/i);
  });

  it("rejects invalid JSON with a clear message", () => {
    expect(() => parsePlaylist("[{id:}]")).toThrow(/invalid JSON/i);
  });

  it("rejects entries without an id string", () => {
    expect(() => parsePlaylist('[{"title": "a"}]')).toThrow(/entry 0.*id/s);
    expect(() => parsePlaylist('[{"id": 7}]')).toThrow(/entry 0.*id/s);
  });

  it("rejects entries with a non-string title", () => {
    expect(() => parsePlaylist('[{"id": "a", "title": 5}]')).toThrow(/entry 0.*title/s);
  });

  it("rejects entries with extra unknown keys", () => {
    expect(() => parsePlaylist('[{"id": "a", "bogus": true}]')).toThrow(/entry 0.*unknown key/s);
  });

  it("accepts an empty array", () => {
    expect(parsePlaylist("[]")).toEqual([]);
  });
});

describe("applyPlaylist", () => {
  const photos = [photo("aaa", "d1/aaa.jpg"), photo("bbb", "d1/bbb.jpg"), photo("ccc", "d2/ccc.jpg")];

  it("returns the ordered subset with titles attached", () => {
    const out = applyPlaylist(photos, [
      { id: "ccc", title: "C" },
      { id: "aaa", title: "A" },
    ]);
    expect(out.map((p) => p.id)).toEqual(["ccc", "aaa"]);
    expect(out[0].title).toBe("C");
    expect(out[1].title).toBe("A");
    expect(out[0].relPath).toBe("d2/ccc.jpg"); // entry data preserved
  });

  it("throws listing unknown ids when an id is missing from the scan", () => {
    expect(() =>
      applyPlaylist(photos, [
        { id: "aaa" },
        { id: "nope1" },
        { id: "nope2" },
      ]),
    ).toThrow(/nope1[\s\S]*nope2/);
    expect(() => applyPlaylist(photos, [{ id: "nope1" }])).toThrow(/nope1/);
  });

  it("errors name the count when several ids are unknown", () => {
    expect(() =>
      applyPlaylist(photos, [{ id: "x1" }, { id: "x2" }, { id: "x3" }]),
    ).toThrow(/3 playlist id/i);
  });

  it("leaves title undefined for entries without one", () => {
    const out = applyPlaylist(photos, [{ id: "bbb" }]);
    expect(out.length).toBe(1);
    expect(out[0].title).toBeUndefined();
    expect("title" in out[0]).toBe(false);
  });

  it("returns an empty list for an empty playlist", () => {
    expect(applyPlaylist(photos, [])).toEqual([]);
  });
});
