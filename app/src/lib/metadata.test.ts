import { afterEach, describe, expect, it, vi } from "vitest";
import exifr from "exifr";
import { parseImageMeta } from "./metadata.ts";

// Contract (.scratch/metadata-panel/issues/01): parseImageMeta NEVER throws —
// every exifr failure mode (sync throw, undefined resolution, rejection)
// settles to null after the XMP-regex fallback, so the panel cannot hang.
// exifr and fetch are mocked; no real files involved.

vi.mock("exifr", () => ({ default: { parse: vi.fn() } }));

const parseMock = vi.mocked(exifr.parse);

/** Stub fetch to serve `body` (latin1-decoded by extractDjiXmp). */
function stubFetch(body: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    })),
  );
}

const XMP_PACKET =
  '<x:xmpmeta xmlns:drone-dji="u"><drone-dji:RelativeAltitude>80.5</drone-dji:RelativeAltitude></x:xmpmeta>';

afterEach(() => {
  vi.unstubAllGlobals();
  parseMock.mockReset();
});

describe("parseImageMeta — exifr failure modes settle to the fallback, never throw", () => {
  it("sync throw (before any promise exists) → null", async () => {
    parseMock.mockImplementation(() => {
      throw new Error("corrupt jpeg");
    });
    stubFetch("");
    await expect(parseImageMeta("x.jpg")).resolves.toBeNull();
  });

  it("undefined resolution → null", async () => {
    parseMock.mockResolvedValue(undefined);
    stubFetch("");
    await expect(parseImageMeta("x.jpg")).resolves.toBeNull();
  });

  it("rejection → null", async () => {
    parseMock.mockRejectedValue(new Error("async failure"));
    stubFetch("");
    await expect(parseImageMeta("x.jpg")).resolves.toBeNull();
  });

  it("sync throw + XMP fallback still recovers metadata", async () => {
    parseMock.mockImplementation(() => {
      throw new Error("corrupt jpeg");
    });
    stubFetch(XMP_PACKET);
    await expect(parseImageMeta("x.jpg")).resolves.toEqual({ RelativeAltitude: 80.5 });
  });

  it("fallback fetch failure also settles to null", async () => {
    parseMock.mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 })),
    );
    await expect(parseImageMeta("x.jpg")).resolves.toBeNull();
  });
});

describe("parseImageMeta — healthy paths", () => {
  it("exifr surfacing a DJI key wins; fallback not consulted", async () => {
    parseMock.mockResolvedValue({
      RelativeAltitude: 112.5,
      GpsStatus: "Normal",
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(parseImageMeta("x.jpg")).resolves.toEqual({
      RelativeAltitude: 112.5,
      GpsStatus: "Normal",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("exifr without DJI keys → fallback merges, exifr fields win", async () => {
    parseMock.mockResolvedValue({
      DateTimeOriginal: "2026:07:23 10:00:00",
    });
    stubFetch(XMP_PACKET);
    await expect(parseImageMeta("x.jpg")).resolves.toEqual({
      RelativeAltitude: 80.5,
      DateTimeOriginal: "2026:07:23 10:00:00",
    });
  });
});
