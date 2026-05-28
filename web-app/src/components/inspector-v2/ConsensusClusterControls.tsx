import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface ClusterAlgoRow {
  id: string;
  displayLabel: string;
  count: number;
}

export interface CentroidOption<T extends string = string> {
  id: T;
  short: string;
  description?: string;
  example?: string;
}

export interface ConsensusClusterControlsProps<TCentroid extends string = string> {
  algoRows: ClusterAlgoRow[];
  selectedAlgoIds: Set<string>;
  onSelectedAlgoIdsChange: (s: Set<string>) => void;
  showMsafShortcut?: boolean;

  clusterWindow: number;
  onClusterWindowChange: (n: number) => void;

  centroidMethod: TCentroid;
  onCentroidMethodChange: (m: TCentroid) => void;
  centroidOptions: CentroidOption<TCentroid>[];

  minConsensus: number;
  onMinConsensusChange: (n: number) => void;
  minConsensusLabel?: string;

  extraPopoverSection?: ReactNode;
  popoverAlign?: 'left' | 'right';
}

export function ConsensusClusterControls<TCentroid extends string = string>({
  algoRows,
  selectedAlgoIds,
  onSelectedAlgoIdsChange,
  showMsafShortcut = false,
  clusterWindow,
  onClusterWindowChange,
  centroidMethod,
  onCentroidMethodChange,
  centroidOptions,
  minConsensus,
  onMinConsensusChange,
  minConsensusLabel = 'Min consensus',
  extraPopoverSection,
  popoverAlign = 'left',
}: ConsensusClusterControlsProps<TCentroid>) {
  const [open, setOpen] = useState(false);
  const [hoveredCentroidId, setHoveredCentroidId] = useState<TCentroid | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const totalAlgos = algoRows.length;
  const selectableMin = Math.max(1, selectedAlgoIds.size);
  const activeCentroid = centroidOptions.find((m) => m.id === (hoveredCentroidId ?? centroidMethod));

  return (
    <>
      <div className="relative" ref={wrapperRef}>
        <button
          onClick={() => setOpen((v) => !v)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] uppercase tracking-wider border transition-colors ${
            open
              ? 'bg-violet-500/15 border-violet-400/40 text-violet-200'
              : 'bg-white/[0.04] border-white/[0.06] text-slate-300 hover:border-white/[0.12]'
          }`}
          title="Cluster settings — algorithms, centroid, consensus"
        >
          <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
          </svg>
          Settings
          <span className="text-slate-500 font-mono normal-case tracking-normal">
            {selectedAlgoIds.size}/{totalAlgos} · {clusterWindow}s · {centroidOptions.find((m) => m.id === centroidMethod)?.short}
            {minConsensus > 1 && ` · ≥${minConsensus}`}
          </span>
          <svg className={`w-3 h-3 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>

        {open && (
          <div className={`absolute z-50 top-full mt-1 ${popoverAlign === 'right' ? 'right-0' : 'left-0'} bg-[#14171d] border border-white/[0.08] rounded-md shadow-2xl shadow-black/60 p-3 w-[28rem] max-h-[34rem] overflow-y-auto space-y-4`}>
            {/* Algorithms */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wider text-slate-500">Algorithms</span>
                <span className="text-[10px] font-mono text-slate-600">{selectedAlgoIds.size}/{totalAlgos}</span>
                <span className="ml-auto flex items-center gap-1.5">
                  <button onClick={() => onSelectedAlgoIdsChange(new Set(algoRows.map((r) => r.id)))} className="text-[10px] uppercase tracking-wider text-violet-400 hover:text-violet-200 transition-colors">all</button>
                  <span className="text-[10px] text-slate-700">·</span>
                  <button onClick={() => onSelectedAlgoIdsChange(new Set())} className="text-[10px] uppercase tracking-wider text-slate-500 hover:text-slate-300 transition-colors">none</button>
                  {showMsafShortcut && algoRows.some((r) => r.id.startsWith('msaf-')) && (
                    <>
                      <span className="text-[10px] text-slate-700">·</span>
                      <button onClick={() => onSelectedAlgoIdsChange(new Set(algoRows.filter((r) => r.id.startsWith('msaf-')).map((r) => r.id)))} className="text-[10px] uppercase tracking-wider text-cyan-400 hover:text-cyan-200 transition-colors">MSAF</button>
                    </>
                  )}
                </span>
              </div>
              <div className="border border-white/[0.06] rounded p-1 max-h-40 overflow-y-auto bg-black/30">
                {algoRows.map((row) => {
                  const checked = selectedAlgoIds.has(row.id);
                  return (
                    <label key={row.id} className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-white/[0.04] text-[11px] transition-colors">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = new Set(selectedAlgoIds);
                          if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
                          onSelectedAlgoIdsChange(next);
                        }}
                        className="accent-violet-500 w-3 h-3"
                      />
                      <span className={`font-mono ${checked ? 'text-slate-200' : 'text-slate-500'}`}>{row.displayLabel}</span>
                      <span className="text-slate-600 text-[10px] font-mono ml-auto">({row.count})</span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Centroid */}
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <label className="text-[10px] uppercase tracking-wider text-slate-500 w-28 shrink-0">Centroid</label>
                <div className="flex gap-px flex-wrap">
                  {centroidOptions.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => onCentroidMethodChange(m.id)}
                      onMouseEnter={() => setHoveredCentroidId(m.id)}
                      onMouseLeave={() => setHoveredCentroidId(null)}
                      className={`px-2 py-0.5 text-[10px] font-mono border transition-colors first:rounded-l last:rounded-r ${
                        centroidMethod === m.id
                          ? 'bg-violet-500/20 border-violet-400/40 text-violet-200'
                          : 'bg-white/[0.02] border-white/[0.06] text-slate-500 hover:bg-white/[0.06] hover:text-slate-200'
                      }`}
                    >
                      {m.short}
                    </button>
                  ))}
                </div>
              </div>
              {activeCentroid && (
                <div className="ml-[7.5rem] text-[10px] text-slate-500 leading-snug space-y-0.5">
                  {activeCentroid.description && (
                    <div><span className="text-violet-400 font-mono mr-1">{activeCentroid.short}:</span>{activeCentroid.description}</div>
                  )}
                  {activeCentroid.example && <div className="font-mono text-slate-600">{activeCentroid.example}</div>}
                </div>
              )}
            </div>

            {/* Min consensus / agreement */}
            {totalAlgos > 0 && (
              <div className="flex items-center gap-2" title="Show only clusters where at least this many distinct algorithms agree.">
                <label className="text-[10px] uppercase tracking-wider text-slate-500 w-28 shrink-0">{minConsensusLabel}</label>
                <input
                  type="range"
                  min={1}
                  max={selectableMin}
                  step={1}
                  value={Math.min(minConsensus, selectableMin)}
                  onChange={(e) => onMinConsensusChange(Number(e.target.value))}
                  className="flex-1 accent-violet-500"
                />
                <span className="text-[11px] font-mono text-cyan-300 w-20 tabular-nums text-right">
                  {minConsensus === 1 ? 'All' : `≥${minConsensus}/${selectableMin}`}
                </span>
              </div>
            )}

            {extraPopoverSection}
          </div>
        )}
      </div>

      {/* Inline cluster window slider — pulled out so the time tolerance is always visible */}
      <div className="flex items-center gap-1.5 text-[11px] text-slate-500" title="Time tolerance for grouping algorithm boundaries into a cluster">
        <span className="uppercase tracking-wider text-[10px]">Cluster window</span>
        <input
          type="range"
          min={0.5}
          max={10}
          step={0.5}
          value={clusterWindow}
          onChange={(e) => onClusterWindowChange(Number(e.target.value))}
          className="w-24 accent-violet-500"
        />
        <span className="font-mono text-violet-300 w-10 tabular-nums text-right">{clusterWindow}s</span>
      </div>
    </>
  );
}
