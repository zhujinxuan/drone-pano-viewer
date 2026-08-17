/**
 * Recursive scan of a photos directory.
 *
 * Photos are 2:1 equirectangular JPGs named `{geohash8}.jpg` (or `nogps-*`
 * when the drone had no GPS fix), possibly nested by date:
 * `{dir}/{date}/{geohash8}.jpg`.
 *
 * Broken symlinks / unreadable files (e.g. DVC objects not pulled) are
 * skipped gracefully — they simply do not appear in the manifest.
 */
import fs from "node:fs";
import path from "node:path";
import { decodeGeohash, isGeohash8 } from "./geohash.ts";
import type { PhotoEntry } from "./types.ts";

export type { PhotoEntry };

const PHOTO_EXTENSIONS: Record<string, true> = { ".jpg": true, ".jpeg": true };

/** URL under which a photo's bytes are served (relPath is POSIX, segments percent-encoded). */
export function photoUrl(relPathPosix: string): string {
  return "/photos/" + relPathPosix.split("/").map(encodeURIComponent).join("/");
}

export function entryFor(relPathPosix: string): PhotoEntry {
  const name = path.posix.basename(relPathPosix);
  const id = path.posix.basename(relPathPosix, path.posix.extname(relPathPosix));
  let lon: number | null = null;
  let lat: number | null = null;
  if (!id.startsWith("nogps") && isGeohash8(id)) {
    const ll = decodeGeohash(id);
    if (ll) {
      lon = ll.lon;
      lat = ll.lat;
    }
  }
  return { id, name, relPath: relPathPosix, url: photoUrl(relPathPosix), lon, lat };
}

/** Recursively scan `dir` for panorama photos. Returns a deterministic list sorted by relPath. */
export function scanPhotos(dir: string): PhotoEntry[] {
  const out: PhotoEntry[] = [];

  const walk = (current: string, rel: string) => {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return; // unreadable subtree — skip
    }
    for (const d of dirents) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      const childAbs = path.join(current, d.name);
      if (d.isDirectory()) {
        walk(childAbs, childRel);
      } else if (PHOTO_EXTENSIONS[path.extname(d.name).toLowerCase()]) {
        try {
          // Broken symlink (unpulled DVC object) throws ENOENT here — skip it.
          if (fs.statSync(childAbs).isFile()) out.push(entryFor(childRel));
        } catch {
          // missing / permission denied — skip
        }
      }
    }
  };

  walk(path.resolve(dir), "");
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}
