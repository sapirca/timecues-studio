import { DEFAULT_OPTIONAL_WEIGHT, DEFAULT_USE_SECONDARY } from '../../utils/evaluation';

export interface CustomEvalSettings {
  optionalWeight: number;
  useSecondary: boolean;
}

export const DEFAULT_CUSTOM_EVAL_SETTINGS: CustomEvalSettings = {
  optionalWeight: DEFAULT_OPTIONAL_WEIGHT,
  useSecondary: DEFAULT_USE_SECONDARY,
};

export function CustomEvalControls({
  settings,
  onChange,
  compact = false,
}: {
  settings: CustomEvalSettings;
  onChange: (next: CustomEvalSettings) => void;
  compact?: boolean;
}) {
  const labelCls = compact ? 'text-[10px]' : 'text-[11px]';
  return (
    <div className={`flex items-center flex-wrap gap-x-3 gap-y-1 ${labelCls} text-gray-500`}>
      <div
        className="flex items-center gap-1.5"
        title="Weight applied to manual sections marked 'optional' (☆). Affects recall and MNBD on the custom evaluator. 1.0 = optional counts the same as critical; 0 = optional is ignored."
      >
        <span>Opt. weight</span>
        <input
          type="range" min="0" max="1" step="0.05"
          value={settings.optionalWeight}
          onChange={(e) => onChange({ ...settings, optionalWeight: Number(e.target.value) })}
          className="w-20 accent-amber-500"
        />
        <span className="font-mono text-amber-300 w-10 text-right">{settings.optionalWeight.toFixed(2)}</span>
      </div>

      <label
        className="flex items-center gap-1.5 cursor-pointer select-none"
        title="Applies to BOTH mir_eval and custom evaluators. When ON, alternative candidate times on a manual section count as valid hits. When OFF, only the primary g.time is used."
      >
        <input
          type="checkbox"
          checked={settings.useSecondary}
          onChange={(e) => onChange({ ...settings, useSecondary: e.target.checked })}
          className="accent-amber-500 w-3 h-3"
        />
        <span>Use candidates</span>
      </label>
    </div>
  );
}
