interface NavStripProps {
  /** 0-based index of the current panorama. */
  pos: number;
  /** Total panoramas in the manifest. */
  total: number;
  /** Title of the NEXT panorama (playlist title or id) — ghost text. */
  nextTitle: string | null;
  onPrev: () => void;
  onNext: () => void;
}

/**
 * Bottom-center playlist navigation strip: `‹ 3/20 ›` plus a ghost preview of
 * the next panorama's title. The arrows wrap around; hidden for single-photo
 * manifests. Clicks and `[`/`]`/`p`/`n` keys drive the same handlers.
 */
export default function NavStrip({ pos, total, nextTitle, onPrev, onNext }: NavStripProps) {
  if (total <= 1) return null;
  return (
    <div className="nav-strip" role="navigation" aria-label="Playlist">
      <button
        type="button"
        className="nav-btn"
        onClick={onPrev}
        aria-label="Previous panorama"
        title="Previous ( [ )"
      >
        ‹
      </button>
      <span className="nav-count">
        {pos + 1}/{total}
      </span>
      <button
        type="button"
        className="nav-btn"
        onClick={onNext}
        aria-label="Next panorama"
        title="Next ( ] )"
      >
        ›
      </button>
      {nextTitle !== null && <span className="nav-ghost">{nextTitle}</span>}
    </div>
  );
}
