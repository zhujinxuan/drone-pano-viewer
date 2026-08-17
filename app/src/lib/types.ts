/** Shared types between the node-side scan/CLI and the browser app. */

export interface PhotoEntry {
  /** Filename stem — the geohash8 id, or `nogps-*` prefix. */
  id: string;
  /** Filename including extension. */
  name: string;
  /** Path relative to the photos dir, POSIX separators. */
  relPath: string;
  /** URL under which the bytes are served. */
  url: string;
  /** Longitude decoded from the geohash stem, or null for `nogps-*`. */
  lon: number | null;
  /** Latitude decoded from the geohash stem, or null for `nogps-*`. */
  lat: number | null;
  /** Title from the active playlist, if any. */
  title?: string;
}

/** Envelope returned by GET /api/photos (both playlist and plain mode). */
export interface PhotosManifest {
  photos: PhotoEntry[];
  /** True when the viewer was started with `--playlist` (photos are the ordered, titled subset). */
  playlist: boolean;
}
