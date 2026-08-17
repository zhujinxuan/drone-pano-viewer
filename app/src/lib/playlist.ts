/**
 * Playlist = an explicit, ordered subset of the scanned photos with titles.
 *
 * Shape (JSON file passed to `pano view --playlist <file>`):
 *   [{ "id": "<geohash8 stem>", "title": "<free text>" }, …]
 *
 * `title` is optional; `id` must resolve against the recursive dir scan
 * (see scan.ts). Pure module — no fs, so it is trivially testable.
 */
import type { PhotoEntry } from "./types.ts";

export interface PlaylistEntry {
  /** Filename stem the entry refers to (geohash8 or `nogps-*`). */
  id: string;
  /** Free-text title shown in the viewer; optional. */
  title?: string;
}

/**
 * Parse and validate raw playlist JSON.
 * Throws a human-readable Error on any shape violation (the CLI dies with it).
 */
export function parsePlaylist(rawJson: string): PlaylistEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    throw new Error(`playlist: invalid JSON — ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`playlist must be a JSON array of { id, title? } entries, got ${typeof parsed}`);
  }
  return parsed.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`playlist entry ${i} must be an object, got ${JSON.stringify(entry)}`);
    }
    const rec = entry as Record<string, unknown>;
    if (typeof rec.id !== "string" || rec.id.length === 0) {
      throw new Error(`playlist entry ${i} is missing a non-empty string "id": ${JSON.stringify(entry)}`);
    }
    if (rec.title !== undefined && typeof rec.title !== "string") {
      throw new Error(`playlist entry ${i} (${rec.id}): "title" must be a string, got ${typeof rec.title}`);
    }
    const known = Object.keys(rec).filter((k) => k !== "id" && k !== "title");
    if (known.length > 0) {
      throw new Error(`playlist entry ${i} (${rec.id}): unknown key(s) ${known.join(", ")}`);
    }
    const out: PlaylistEntry = { id: rec.id };
    if (rec.title !== undefined) out.title = rec.title;
    return out;
  });
}

/**
 * Project a playlist onto a scan result: ordered subset of `photos`, each with
 * its playlist `title` attached. Throws listing every playlist id that has no
 * matching photo (e.g. typo, or a DVC object that is not pulled).
 */
export function applyPlaylist(photos: PhotoEntry[], playlist: PlaylistEntry[]): PhotoEntry[] {
  const byId = new Map(photos.map((p) => [p.id, p]));
  const unknown = playlist.filter((e) => !byId.has(e.id)).map((e) => e.id);
  if (unknown.length > 0) {
    throw new Error(
      `${unknown.length} playlist id(s) not found in the photos dir: ${unknown.join(", ")}`,
    );
  }
  return playlist.map((e) => {
    const p = byId.get(e.id)!;
    return e.title === undefined ? p : { ...p, title: e.title };
  });
}
