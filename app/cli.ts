#!/usr/bin/env node
/**
 * pano — drone panorama viewer CLI.
 *
 *   pano view <file-or-dir> [--id <geohash8>] [--near <lon,lat>] [--title <text>]
 *                         [--playlist <file.json>]
 *   pano list <dir> [--json]
 *
 * `view` starts the Vite dev server programmatically on an ephemeral port,
 * prints the viewer URL on stdout and opens the default browser.
 * Runs on Node's native TypeScript type stripping — no tsx needed.
 */
import fs from "node:fs";
import path from "node:path";
import open from "open";
import { haversineKm, type LonLat } from "./src/lib/geohash.ts";
import { applyPlaylist, parsePlaylist, type PlaylistEntry } from "./src/lib/playlist.ts";
import { scanPhotos, type PhotoEntry } from "./src/lib/scan.ts";

const HELP = `pano — drone panorama viewer

  pano view <file-or-dir> [--id <geohash8>] [--near <lon,lat>] [--title <text>]
                        [--playlist <file.json>]
      Serve the photos dir (a file argument serves its parent dir) and open
      the viewer in the default browser. Selection precedence:
        --id <geohash8>   exact photo by filename stem
        --near <lon,lat>  photo with min haversine distance from the point
        (file argument)  the stem of the given file
        (default)        first photo in the manifest
      --playlist <file.json>
                        JSON array [{ "id": "<stem>", "title": "<text>" }, …]
                        restricting the viewer to an ordered, titled subset of
                        the dir scan. Ids must exist in the scan. With a
                        playlist, --id/--near must resolve inside it and the
                        default selection is the first playlist entry.
  pano list <dir> [--json]
      Print the photo manifest without starting a server.
`;

interface Args {
  cmd: string;
  pos: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "";
      }
    } else {
      pos.push(a);
    }
  }
  return { cmd: pos[0] ?? "", pos: pos.slice(1), flags };
}

function die(msg: string): never {
  console.error(`pano: ${msg}`);
  process.exit(1);
}

interface PhotosDir {
  dir: string;
  /** Stem of the file argument, when the target was a single file. */
  fileStem: string | null;
}

function resolvePhotosDir(target: string): PhotosDir {
  const abs = path.resolve(target);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs); // follows symlinks; throws for broken ones
  } catch {
    die(`cannot access ${target}`);
  }
  if (st.isFile()) {
    return { dir: path.dirname(abs), fileStem: path.basename(abs, path.extname(abs)) };
  }
  if (!st.isDirectory()) die(`${target} is neither a file nor a directory`);
  return { dir: abs, fileStem: null };
}

function parseNear(raw: string): LonLat {
  const m = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) die(`--near expects <lon,lat>, got "${raw}"`);
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) die(`--near coordinates out of range: ${raw}`);
  return { lon, lat };
}

function selectPhoto(
  photos: PhotoEntry[],
  opts: { id?: string; near?: LonLat; fileStem?: string | null },
): PhotoEntry {
  if (opts.id !== undefined) {
    const hit = photos.find((p) => p.id === opts.id);
    if (!hit) {
      die(
        `no photo with id "${opts.id}" — available: ${photos
          .slice(0, 20)
          .map((p) => p.id)
          .join(", ")}${photos.length > 20 ? ", …" : ""}`,
      );
    }
    return hit;
  }
  if (opts.near) {
    const withCoords = photos.filter((p) => p.lon !== null && p.lat !== null);
    if (withCoords.length === 0) die("--near given but no photo has GPS coordinates");
    let best = withCoords[0];
    let bestDist = Infinity;
    for (const p of withCoords) {
      const d = haversineKm(opts.near, { lon: p.lon!, lat: p.lat! });
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best;
  }
  if (opts.fileStem) {
    const hit = photos.find((p) => p.id === opts.fileStem);
    if (hit) return hit;
  }
  return photos[0];
}

async function runView(args: Args): Promise<void> {
  const target = args.pos[0];
  if (!target) die("view: missing <file-or-dir> argument");
  const { dir, fileStem } = resolvePhotosDir(target);
  const photos = scanPhotos(dir);
  if (photos.length === 0) die(`no .jpg panoramas found under ${dir} (unpulled DVC objects are skipped)`);

  // Playlist: read + validate ids against the scan NOW (fail fast), hand the
  // raw JSON to the dev server via env, and restrict selection to the subset.
  let pool = photos;
  let playlistFile: string | null = null;
  let playlist: PlaylistEntry[] = [];
  if (args.flags.playlist !== undefined) {
    playlistFile = args.flags.playlist;
    if (!playlistFile) die("--playlist expects a <file.json> path");
    let raw: string;
    try {
      raw = fs.readFileSync(path.resolve(playlistFile), "utf8");
    } catch (e) {
      die(`cannot read playlist ${playlistFile} — ${(e as Error).message}`);
    }
    try {
      playlist = parsePlaylist(raw);
    } catch (e) {
      die(`${playlistFile}: ${(e as Error).message}`);
    }
    try {
      pool = applyPlaylist(photos, playlist); // dies listing unknown ids
    } catch (e) {
      die(`${playlistFile}: ${(e as Error).message}`);
    }
    if (pool.length === 0) die(`${playlistFile}: playlist is empty`);
    process.env.PANO_PLAYLIST = raw;
  }
  const selected = selectPhoto(pool, {
    id: args.flags.id,
    near: args.flags.near ? parseNear(args.flags.near) : undefined,
    fileStem,
  });

  process.env.PANO_PHOTOS_DIR = dir;

  const { createServer } = await import("vite");
  const server = await createServer({
    root: import.meta.dirname,
    clearScreen: false,
    server: { port: 0 }, // ephemeral port
  });
  await server.listen();
  const base = server.resolvedUrls?.local?.[0] ?? `http://localhost:${server.config.server.port}/`;
  console.log(`pano: serving ${pool.length} of ${photos.length} photo(s) from ${dir}` + (playlistFile ? ` (playlist ${playlistFile})` : ""));
  const qs = new URLSearchParams({ id: selected.id });
  if (args.flags.title) qs.set("title", args.flags.title);
  console.log(`pano: selected ${selected.relPath}` + (selected.title ? ` — ${selected.title}` : "") + (selected.lon !== null ? ` (${selected.lon.toFixed(6)}, ${selected.lat!.toFixed(6)})` : " (no gps)"));
  const url = `${base}?${qs}`;

  console.log(url);

  open(url, { wait: false }).catch(() =>
    console.error("pano: failed to open the browser — open the URL above manually"),
  );

  // Serve until Ctrl+C.
  await new Promise<never>(() => {});
}

function runList(args: Args): void {
  const target = args.pos[0];
  if (!target) die("list: missing <dir> argument");
  const { dir } = resolvePhotosDir(target);
  const photos = scanPhotos(dir);
  if (args.flags.json !== undefined) {
    console.log(JSON.stringify(photos, null, 2));
    return;
  }
  if (photos.length === 0) {
    console.log(`(no .jpg panoramas under ${dir})`);
    return;
  }
  for (const p of photos) {
    console.log(
      `${p.id}\t${p.relPath}\t${p.lon !== null ? p.lon.toFixed(6) : "-"}\t${p.lat !== null ? p.lat.toFixed(6) : "-"}`,
    );
  }
}

const args = parseArgs(process.argv.slice(2));
switch (args.cmd) {
  case "view":
    await runView(args);
    break;
  case "list":
    runList(args);
    break;
  default:
    console.log(HELP);
    process.exitCode = args.cmd ? 1 : 0;
}
