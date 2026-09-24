import { useState, type ReactNode } from 'react';
import type { SectionBlock } from '../../types/sectionBlock';
import { sectionEnd } from './sectionConstants';
import { InfoDot } from './InfoDot';
import { getIsMobile } from '../../mobile/mobileMode';

// Row names down the left. Desktop: a 64px right-aligned column. Phone: the
// same 20px vertical strip the timeline's rows use (first five letters,
// written bottom-to-top), so the preview's lanes start where the timeline's
// do and keep nearly the whole width.
// Read at render, never at module load: modules evaluate before main.tsx
// decides the shell, so a top-level read would always say desktop.
const tagWidth = () => (getIsMobile() ? 'w-5 shrink-0' : 'w-16 shrink-0');
// Clipped to its own row: a 24px lane holds about four letters, and the rest
// ends in an ellipsis rather than running into the next row's tag.
const VERTICAL = 'block text-[8px] font-mono uppercase text-slate-500 whitespace-nowrap overflow-hidden text-ellipsis leading-none [writing-mode:vertical-rl] rotate-180 max-h-full';

function LaneTag({ name }: { name: string }) {
  if (!getIsMobile()) {
    return <span className="w-16 shrink-0 text-right text-[9px] font-mono uppercase tracking-wider text-slate-600">{name}</span>;
  }
  return (
    <span className={`${tagWidth()} self-stretch flex items-center justify-center overflow-hidden`} title={name}>
      <span className={VERTICAL}>{name.replace(/\s+/g, ' ').trim().slice(0, 5).trim()}</span>
    </span>
  );
}

/** One cluster as the consensus panel knows it before the agreement filter
 *  runs: where it landed, and how many distinct detectors put a boundary
 *  there. The ones below the threshold are drawn too — greyed — because the
 *  discard is exactly what the Agreement slider is choosing, and a count that
 *  silently drops is not something you can tune against. */
export interface PreviewCluster {
  time: number;
  agree: number;
  /** Display names of the detectors that proposed it, sorted. */
  detectors: string[];
}

export interface ConsensusPreviewLaneProps {
  duration: number;
  /** The consensus tiling — blocks run to the next boundary, typed
   *  'hit' / 'miss' / 'consensus' (no reference loaded). */
  blocks: { time: number; endTime: number; type: string }[];
  /** Every cluster, including those under `minAgreement`. */
  clusters: PreviewCluster[];
  minAgreement: number;
  totalDetectors: number;
  /** How far apart two detector boundaries may sit and still be treated as
   *  the same one. Named in the header so the row of stubs is readable
   *  without hunting for the slider that produced it. */
  clusterWindow: number;
  /** The reference layer, drawn as the tiling it is. */
  referenceSections: SectionBlock[];
  referenceLabel: string;
  /** Reference times whose nearest consensus boundary is within tolerance. */
  matchedRefTimes: Set<number>;
  /** Half-width of the window a match has to land in, in seconds. */
  tolerance: number;
}

const HIT = '#22c55e';
const MISS = '#ef4444';
const AGREE_ROW_H = 34;

const pct = (t: number, duration: number) => `${Math.max(0, Math.min(100, (t / duration) * 100))}%`;

function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The tuning view of the consensus: both tilings on one axis, scaled to the
 *  whole track.
 *
 *  It deliberately does NOT replace the Consensus row on the shared timeline —
 *  that row stays the aligned one, readable against the detector lanes it was
 *  blended from. This is the picture the sliders move: a boundary is the *edge*
 *  between two blocks, so the edge is what carries the verdict colour, and the
 *  ±tolerance window each reference edge is judged in is drawn at its real
 *  width instead of being described in a caption. */
export function ConsensusPreviewLane({
  duration,
  blocks,
  clusters,
  minAgreement,
  totalDetectors,
  clusterWindow,
  referenceSections,
  referenceLabel,
  matchedRefTimes,
  tolerance,
}: ConsensusPreviewLaneProps) {
  // Which boundary the pointer is on, by cluster time. Stubs and consensus
  // edges share it, so hovering either lights both and opens one card.
  const [hovered, setHovered] = useState<number | null>(null);
  if (duration <= 0) return null;

  const maxAgree = Math.max(3, ...clusters.map((c) => c.agree));
  const stubHeight = (agree: number) => Math.max(3, (agree / maxAgree) * (AGREE_ROW_H - 11));
  const kept = clusters.filter((c) => c.agree >= minAgreement).length;

  // A bar height is a comparison, not a count — and "how many detectors put a
  // boundary here" is the question the Agreement slider is answering, so print
  // the number on each stub. Dropped only where neighbours would collide: two
  // overlapping digits are worse than none.
  const sortedTimes = clusters.map((c) => c.time).sort((a, b) => a - b);
  const minGapPct = 2.6;
  const hasRoom = (t: number) => {
    const i = sortedTimes.indexOf(t);
    const gap = (other?: number) => other === undefined ? Infinity : Math.abs(other - t) / duration * 100;
    return Math.min(gap(sortedTimes[i - 1]), gap(sortedTimes[i + 1])) >= minGapPct;
  };

  // The ± windows, drawn across both tilings so a near-miss reads as "landed
  // just outside the band" rather than as an unexplained red edge.
  const tauBands = referenceSections.map((s) => (
    <span
      key={`tau-${s.time}`}
      className="absolute top-0 bottom-0 pointer-events-none"
      style={{
        left: pct(s.time - tolerance, duration),
        width: `${Math.max(0.3, ((tolerance * 2) / duration) * 100)}%`,
        background: 'rgba(139,92,246,0.16)',
        borderLeft: '1px solid rgba(139,92,246,0.3)',
        borderRight: '1px solid rgba(139,92,246,0.3)',
      }}
    />
  ));

  const scored = blocks.some((b) => b.type === 'hit' || b.type === 'miss');
  const hits = blocks.filter((b) => b.type === 'hit').length;
  const misses = blocks.filter((b) => b.type === 'miss').length;
  const refTotal = referenceSections.length;
  const refFound = matchedRefTimes.size;

  const hoveredCluster = hovered === null ? null : clusters.find((c) => c.time === hovered) ?? null;
  const hoveredBlock = hovered === null ? null : blocks.find((b) => b.time === hovered) ?? null;

  /** An invisible strip, wider than the 2px edge it sits on, so a boundary
   *  can actually be pointed at. */
  const hoverTarget = (t: number) => (
    <span
      key={`hov-${t}`}
      className="absolute top-0 bottom-0 z-10 cursor-help"
      style={{ left: pct(t, duration), width: 10, transform: 'translateX(-4px)' }}
      onMouseEnter={() => setHovered(t)}
      onMouseLeave={() => setHovered((h) => (h === t ? null : h))}
    />
  );

  const firstBoundary = blocks.length ? blocks[0].time : duration;
  const firstSection = referenceSections.length ? referenceSections[0].time : duration;

  return (
    <div className="relative rounded-md border border-white/[0.06] bg-[#0b0d12] px-3 pt-2.5 pb-2">
      {/* Everything that used to be printed under the lanes — the swatch
          legend, what the stub numbers mean, where else the result is drawn —
          is true but not needed on every glance, so it lives one hover away. */}
      <span className="absolute right-2 top-2 z-10">
        <InfoDot label="How to read the consensus preview" align="right">
          <span className="block mb-1">
            {kept} consensus block{kept === 1 ? '' : 's'}, grouped within ±{clusterWindow}s. Each stub is one
            grouped boundary; the number is how many of the {totalDetectors} detectors proposed it. The dashed
            line is the ≥{minAgreement} threshold — grey stubs fall under it.
          </span>
          <span className="block mb-1">
            Both rows are tilings: a block runs to the next boundary, and the <b>edge</b> carries the
            verdict. Hatching is unannotated track. Point at any stub or edge to see which detectors
            proposed it and how far it sits from your nearest edge.
          </span>
          <span className="block text-slate-500">Also drawn on the Consensus row of the timeline above.</span>
        </InfoDot>
      </span>

      {/* ── Agreement: one stub per cluster, height = detectors agreeing ── */}
      <div className="flex items-center gap-2.5">
        {getIsMobile() ? (
          <span className={`${tagWidth()} self-stretch flex items-center justify-center gap-px overflow-hidden`} title={`Agreement ≥${minAgreement} of ${totalDetectors}`}>
            <span className={VERTICAL}>Agree</span>
            <span className={`${VERTICAL} normal-case text-violet-400`}>≥{minAgreement}/{totalDetectors}</span>
          </span>
        ) : (
          <span className="w-16 shrink-0 text-right text-[9px] font-mono uppercase tracking-wider text-slate-600 leading-tight">
            Agreement
            <span className="block normal-case tracking-normal text-violet-400">≥{minAgreement} of {totalDetectors}</span>
          </span>
        )}
        <div className="relative flex-1" style={{ height: AGREE_ROW_H }}>
          {clusters.map((c) => {
            const below = c.agree < minAgreement;
            return (
              <span
                key={`ag-${c.time}`}
                className="absolute bottom-0"
                style={{ left: pct(c.time, duration) }}
              >
                <span
                  className="absolute bottom-0 w-0.5 rounded-sm"
                  style={{
                    height: stubHeight(c.agree),
                    background: hovered === c.time ? '#e2e8f0' : below ? 'rgba(148,163,184,0.35)' : 'rgba(148,163,184,0.85)',
                  }}
                />
                {hasRoom(c.time) && (
                  <span
                    className="absolute text-[8.5px] font-mono leading-none -translate-x-1/2"
                    style={{
                      left: 1,
                      bottom: stubHeight(c.agree) + 2,
                      color: below ? 'rgba(148,163,184,0.45)' : '#cbd5e1',
                    }}
                  >{c.agree}</span>
                )}
              </span>
            );
          })}
          <div
            className="absolute left-0 right-0 pointer-events-none"
            style={{ top: AGREE_ROW_H - stubHeight(minAgreement), borderTop: '1px dashed rgba(167,139,250,0.55)' }}
          />
          {clusters.map((c) => hoverTarget(c.time))}
        </div>
      </div>

      {/* ── The consensus tiling ── */}
      <div className="flex items-center gap-2.5 mt-1">
        <LaneTag name="Consensus" />
        <div className="relative flex-1 h-6 rounded-sm overflow-hidden bg-white/[0.02]">
          {firstBoundary > 0.5 && <VoidBlock left={0} width={(firstBoundary / duration) * 100} />}
          {blocks.map((b) => (
            <span
              key={`c-${b.time}`}
              className="absolute top-0 bottom-0"
              style={{
                left: pct(b.time, duration),
                width: `${Math.max(0.15, ((b.endTime - b.time) / duration) * 100)}%`,
                background: b.type === 'hit' ? 'rgba(34,197,94,0.16)' : b.type === 'miss' ? 'rgba(239,68,68,0.13)' : 'rgba(139,92,246,0.14)',
                borderLeft: `${hovered === b.time ? 3 : 2}px solid ${b.type === 'hit' ? HIT : b.type === 'miss' ? MISS : '#8b5cf6'}`,
              }}
            />
          ))}
          {tauBands}
          {blocks.map((b) => hoverTarget(b.time))}
        </div>
      </div>

      {/* ── The reference tiling, with its edges scored ── */}
      <div className="flex items-center gap-2.5 mt-1">
        <LaneTag name={referenceLabel} />
        <div className="relative flex-1 h-6 rounded-sm overflow-hidden bg-white/[0.02]">
          {referenceSections.length === 0
            ? <VoidBlock left={0} width={100} label="nothing annotated" />
            : firstSection > 0.5 && <VoidBlock left={0} width={(firstSection / duration) * 100} />}
          {referenceSections.map((s, i) => {
            const end = sectionEnd(referenceSections, i, duration);
            const width = Math.max(0.15, ((end - s.time) / duration) * 100);
            const matched = matchedRefTimes.has(s.time);
            return (
              <span
                key={`r-${s.time}`}
                className="absolute top-0 bottom-0 flex items-center overflow-hidden pl-1.5"
                title={`${s.label || s.type} · ${mmss(s.time)} · edge ${matched ? 'matched' : 'missed'}`}
                style={{
                  left: pct(s.time, duration),
                  width: `${width}%`,
                  background: 'rgba(139,92,246,0.13)',
                  borderLeft: `2px solid ${matched ? HIT : MISS}`,
                }}
              >
                {width > 6 && (
                  <span className="text-[9px] text-white/60 whitespace-nowrap">{s.label || s.type}</span>
                )}
              </span>
            );
          })}
          {tauBands}
        </div>
      </div>

      {/* ── Shared time axis ── */}
      <div className="flex items-center gap-2.5 mt-1">
        <span className={tagWidth()} />
        <div className="relative flex-1 h-3.5 border-t border-white/[0.06]">
          {hoveredCluster && (
            <BoundaryCard
              cluster={hoveredCluster}
              block={hoveredBlock}
              duration={duration}
              minAgreement={minAgreement}
              totalDetectors={totalDetectors}
              referenceSections={referenceSections}
              referenceLabel={referenceLabel}
              tolerance={tolerance}
            />
          )}
          {[0, 1, 2, 3, 4, 5, 6].map((k) => (
            <span
              key={k}
              className="absolute top-0.5 text-[9px] font-mono text-slate-600"
              style={{
                left: `${(k / 6) * 100}%`,
                transform: k === 0 ? 'none' : k === 6 ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {mmss((k / 6) * duration)}
            </span>
          ))}
        </div>
      </div>

      {/* ── Legend + tally ── always shown: a red edge nobody can decode is
           the whole reason this row exists. */}
      <div className="flex items-start gap-2.5 mt-1.5">
        <span className={tagWidth()} />
        <div className="flex-1 min-w-0 space-y-1 text-[10px] leading-snug text-slate-400">
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
            {scored ? (
              <>
                <Swatch color={HIT}>within ±{tolerance}s of a {referenceLabel} edge</Swatch>
                <Swatch color={MISS}>no {referenceLabel} edge within ±{tolerance}s</Swatch>
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-2.5 h-2.5 rounded-[1px]" style={{ background: 'rgba(139,92,246,0.35)', border: '1px solid rgba(139,92,246,0.6)' }} />
                  ±{tolerance}s match window around each {referenceLabel} edge
                </span>
              </>
            ) : (
              <Swatch color="#8b5cf6">consensus boundary — no {referenceLabel} to score against</Swatch>
            )}
          </div>
          {scored && (
            <div className="text-slate-500">
              <span className="text-slate-300">{blocks.length}</span> consensus boundar{blocks.length === 1 ? 'y' : 'ies'} against{' '}
              <span className="text-slate-300">{refTotal}</span> {referenceLabel} edge{refTotal === 1 ? '' : 's'}:{' '}
              <span style={{ color: HIT }}>{hits} matched</span>,{' '}
              <span style={{ color: MISS }}>{misses} extra</span>; {refFound} of {refTotal} of your edges found.
              {misses > 2 * Math.max(1, refTotal) && (
                <span className="text-amber-300/80"> Most edges are extra — raise <b>Keep if</b> to drop weakly-agreed boundaries.</span>
              )}
              {misses <= 2 * Math.max(1, refTotal) && refFound < refTotal && (
                <span className="text-amber-300/80"> Near misses? Point at a red edge to see how far off it is, or widen <b>Match within</b>.</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Swatch({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block w-[3px] h-3 rounded-[1px]" style={{ background: color }} />
      {children}
    </span>
  );
}

function fmtGap(sec: number): string {
  return sec < 10 ? `${sec.toFixed(2)}s` : `${sec.toFixed(1)}s`;
}

/** What one boundary is made of: who proposed it, whether it made the cut,
 *  and — the question a red edge actually raises — how far it is from the
 *  edge it was supposed to match. Hangs below the axis so it never covers the
 *  lanes being read. */
function BoundaryCard({
  cluster, block, duration, minAgreement, totalDetectors, referenceSections, referenceLabel, tolerance,
}: {
  cluster: PreviewCluster;
  block: { type: string } | null;
  duration: number;
  minAgreement: number;
  totalDetectors: number;
  referenceSections: SectionBlock[];
  referenceLabel: string;
  tolerance: number;
}) {
  const frac = cluster.time / duration;
  const anchor = frac < 0.2 ? 'translateX(0)' : frac > 0.8 ? 'translateX(-100%)' : 'translateX(-50%)';
  const nearest = referenceSections.reduce<SectionBlock | null>(
    (best, s) => (best === null || Math.abs(s.time - cluster.time) < Math.abs(best.time - cluster.time) ? s : best),
    null,
  );
  const gap = nearest ? Math.abs(nearest.time - cluster.time) : null;
  // Unnamed sections carry a placeholder label ("—"); name those by time alone.
  const nearestLabel = nearest?.label?.trim().replace(/^[—–-]+$/, '') || '';
  const nearestName = !nearest ? '' : nearestLabel ? `“${nearestLabel}” at ${mmss(nearest.time)}` : `the edge at ${mmss(nearest.time)}`;

  let verdict: ReactNode;
  if (!block) {
    verdict = <span className="text-slate-400">Not in the consensus — {cluster.agree} of {totalDetectors} agree, under the ≥{minAgreement} cut.</span>;
  } else if (block.type === 'hit' && nearest && gap !== null) {
    verdict = <span style={{ color: HIT }}>Matched {nearestName}, {fmtGap(gap)} away (within ±{tolerance}s).</span>;
  } else if (block.type === 'miss') {
    verdict = nearest && gap !== null
      ? <span style={{ color: MISS }}>No match. Nearest {referenceLabel} edge is {nearestName}, {fmtGap(gap)} away — outside ±{tolerance}s.</span>
      : <span style={{ color: MISS }}>No match — {referenceLabel} is empty.</span>;
  } else {
    verdict = <span className="text-slate-400">Unscored — no {referenceLabel} to compare with.</span>;
  }

  return (
    <div
      className="pointer-events-none absolute z-50 top-full mt-1.5 w-72 max-w-[80vw] rounded-md border border-white/10 bg-[#1a1d24] px-3 py-2 text-[11px] leading-snug text-slate-300 shadow-lg"
      style={{ left: pct(cluster.time, duration), transform: anchor }}
    >
      <div className="font-mono text-slate-100 mb-0.5">
        {mmss(cluster.time)} · {cluster.agree} of {totalDetectors} detectors
      </div>
      <div className="mb-1.5">{verdict}</div>
      <div className="flex flex-wrap gap-1">
        {cluster.detectors.map((name) => (
          <span key={name} className="px-1.5 py-px rounded bg-white/[0.06] text-[10px] text-slate-300">{name}</span>
        ))}
      </div>
    </div>
  );
}

/** Track with nothing on it — before the first boundary, or an unannotated
 *  head. Hatched rather than blank so "no data here" cannot be read as "a
 *  section that happens to be dark". */
function VoidBlock({ left, width, label }: { left: number; width: number; label?: string }) {
  return (
    <span
      className="absolute top-0 bottom-0 flex items-center pl-1.5"
      style={{
        left: `${left}%`,
        width: `${width}%`,
        background: 'repeating-linear-gradient(135deg, rgba(255,255,255,0.045) 0 4px, transparent 4px 8px)',
      }}
    >
      {label && <span className="text-[9px] text-slate-600 whitespace-nowrap">{label}</span>}
    </span>
  );
}
