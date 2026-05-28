// Shared play / loop / (×) control bar used by every preview-region surface:
//   • PlayerPanel — floating bar anchored to the playback cursor
//   • PreviewWindow — in-band bar at the top of the cyan highlight strip
//   • AlgoInspectStage — in-band bar on the consensus-inspector rows
//
// Keep visual styling consistent so the "highlight a region, hit play"
// affordance reads the same everywhere.
import type { ReactNode } from 'react';

function PlayIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M3.5 2.5v11l10-5.5z" />
    </svg>
  );
}

function PauseIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="3.75" y="2.5" width="3" height="11" rx="0.5" />
      <rect x="9.25" y="2.5" width="3" height="11" rx="0.5" />
    </svg>
  );
}

// Spotify-style repeat/loop glyph — rounded rect with return arrow at
// bottom-left. Fill = currentColor so the on/off tints work via text-*.
function SpotifyLoopIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M0 4.75A3.75 3.75 0 0 1 3.75 1h8.5A3.75 3.75 0 0 1 16 4.75v5a3.75 3.75 0 0 1-3.75 3.75H9.81l1.018 1.018a.75.75 0 1 1-1.06 1.06L6.939 12.75l2.829-2.828a.75.75 0 1 1 1.06 1.06L9.811 12h2.439a2.25 2.25 0 0 0 2.25-2.25v-5a2.25 2.25 0 0 0-2.25-2.25h-8.5A2.25 2.25 0 0 0 1.5 4.75v5A2.25 2.25 0 0 0 3.75 12H5v1.5H3.75A3.75 3.75 0 0 1 0 9.75z" />
    </svg>
  );
}

interface Props {
  isPlaying: boolean;
  loop: boolean;
  onPlay: () => void;
  onPause: () => void;
  onLoopToggle: () => void;
  /** Show a × dismiss button when provided. */
  onDismiss?: () => void;
  /** Optional read-only readout (e.g. "12.4s") rendered between loop and ×. */
  extra?: ReactNode;
}

export function PreviewControlsBar({ isPlaying, loop, onPlay, onPause, onLoopToggle, onDismiss, extra }: Props) {
  return (
    <div
      className="flex items-center gap-0.5 px-1 py-0.5 rounded bg-gray-900/95 border border-teal-700/60 shadow-lg whitespace-nowrap pointer-events-auto"
      style={{ cursor: 'default' }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => (isPlaying ? onPause() : onPlay())}
        className="w-5 h-5 flex items-center justify-center rounded text-teal-300 hover:text-teal-100 hover:bg-white/[0.06]"
        title={isPlaying ? 'Pause selection' : 'Play selection'}
      >
        {isPlaying ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
      </button>
      <button
        type="button"
        onClick={onLoopToggle}
        className={`w-5 h-5 flex items-center justify-center rounded hover:bg-white/[0.06] ${loop ? 'text-teal-300' : 'text-gray-500 hover:text-gray-300'}`}
        title={loop ? 'Loop on (click to disable)' : 'Loop off (click to enable)'}
      >
        <SpotifyLoopIcon size={12} />
      </button>
      {extra}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-200"
          title="Dismiss preview (Esc)"
        >
          ×
        </button>
      )}
    </div>
  );
}
