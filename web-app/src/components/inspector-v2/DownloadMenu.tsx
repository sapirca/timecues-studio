/**
 * DownloadMenu — single "Export" button that opens the Advanced Export
 * Manager modal. The modal handles all scope/layer/format selection.
 */

import { useState } from 'react';
import type { ManualAnnotation, AutoGuessManualAnnotation } from '../../types/manualAnnotation';
import type { AnnotationLayersDocument } from '../../types/annotationLayer';
import { ExportManagerModal } from './ExportManagerModal';

interface DownloadMenuProps {
  songSlug: string | null;
  songName?: string | null;
  manualAnnotation: ManualAnnotation | null;
  eyeAnnotation: ManualAnnotation | null;
  autoGuessAnnotation: AutoGuessManualAnnotation | null;
  /** User-created cues/spans/loops/patterns layers for the current song.
   *  Already loaded by the parent — passed in to avoid a redundant fetch. */
  layersDocument?: AnnotationLayersDocument | null;
}

export function DownloadMenu({
  songSlug, songName,
  manualAnnotation, eyeAnnotation, autoGuessAnnotation,
  layersDocument,
}: DownloadMenuProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-2.5 py-1 rounded text-[11px] uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 transition-colors"
        title="Export all annotations for this track (boundaries, cues, spans, loops, …)"
      >
        Export
      </button>

      <ExportManagerModal
        open={open}
        onOpenChange={setOpen}
        currentSong={songSlug ? { id: songSlug, name: songName ?? songSlug } : null}
        allSongs={[]}
        manualAnnotation={manualAnnotation}
        eyeAnnotation={eyeAnnotation}
        autoGuessAnnotation={autoGuessAnnotation}
        layersDocument={layersDocument}
        presentation="single"
      />
    </>
  );
}
