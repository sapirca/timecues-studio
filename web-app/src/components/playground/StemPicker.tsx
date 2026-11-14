import type { CustomDetectorStem } from '../../types/customScript';
import { DETECTOR_STEMS, type ParsedStems } from '../../utils/detectorStems';

const TIP =
  'Which stems this detector reads. Tick several and it runs once per stem — each its own ' +
  'lane under that stem, and detect() reads the stem it is running for in ctx.stem. ' +
  'Changing it rewrites the stem line in the code.';

/** The detector's `stem` line as chips, one per stem it may read. The code is
 *  the source of truth: a tick rewrites the line, and a line the chips can't
 *  rewrite safely is shown as it is written. The last ticked stem can't be
 *  unticked — a detector always reads something. */
export function StemPicker({
  parsed,
  onChange,
}: {
  parsed: ParsedStems;
  onChange: (stems: CustomDetectorStem[]) => void;
}) {
  if (parsed.kind === 'unparsed') {
    return (
      <span title="Set in a way these controls can't rewrite — change it in the code.">
        <code className="text-slate-300">{parsed.text}</code>
        <span className="ml-1 text-slate-600">(in code)</span>
      </span>
    );
  }
  const ticked: CustomDetectorStem[] = parsed.kind === 'stems' ? parsed.stems : ['mix'];
  const perStem = ticked.length > 1;
  return (
    <span className="flex flex-col gap-1" title={TIP}>
      <span className="flex flex-wrap gap-1" role="group" aria-label="Stems this detector reads">
        {DETECTOR_STEMS.map((s) => {
          const on = ticked.includes(s);
          const last = on && ticked.length === 1;
          return (
            <button
              key={s}
              type="button"
              aria-pressed={on}
              disabled={last}
              title={last ? 'A detector reads at least one stem — tick another first.' : undefined}
              onClick={() => onChange(on ? ticked.filter((t) => t !== s) : [...ticked, s])}
              className={`rounded border px-1.5 py-px text-[10px] leading-4 transition-colors ${
                on
                  ? 'border-emerald-500/50 bg-emerald-600/20 text-emerald-200'
                  : 'border-white/10 text-slate-400 hover:border-white/20 hover:text-slate-200'
              } ${last ? 'cursor-default' : ''}`}
            >
              {s}
            </button>
          );
        })}
      </span>
      {parsed.kind === 'absent' && <span className="text-slate-600">(default: mix)</span>}
      {perStem && <span className="text-slate-500">Runs once per stem — one lane each.</span>}
    </span>
  );
}
