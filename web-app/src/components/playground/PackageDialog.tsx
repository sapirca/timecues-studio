import { useEffect, useRef, useState } from 'react';
import type { DetectorPackage } from '../../types/customScript';
import type { PackageFields } from '../../services/customScripts';

/** The package.json of a detector package, as a form: a new package (title
 *  and description) or an existing one (also author, version, and whether
 *  the demo may see it). Submitting resolves once saved; a refusal stays in
 *  the dialog, said under the fields. */
export function PackageDialog({
  pkg,
  onSubmit,
  onClose,
}: {
  /** The package being edited — absent for a new one. */
  pkg?: DetectorPackage;
  onSubmit: (fields: PackageFields) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(pkg?.title ?? '');
  const [description, setDescription] = useState(pkg?.description ?? '');
  const [author, setAuthor] = useState(pkg?.author ?? '');
  const [version, setVersion] = useState(pkg?.version ?? '');
  const [teamOnly, setTeamOnly] = useState(pkg ? !pkg.public : false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => { titleRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(pkg
        ? { title, description, author, version, public: !teamOnly }
        : { title, description });
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  const field = 'w-full bg-[#0a0b0d] border border-white/10 rounded px-2 py-1.5 text-[13px] text-slate-100 placeholder:text-slate-600 focus:border-amber-400/60 outline-none';
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={pkg ? `Edit package ${pkg.title}` : 'New package'}
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        className="w-full max-w-md rounded-lg border border-white/10 bg-[#161920] shadow-xl shadow-black/50 p-4 space-y-3"
      >
        <h2 className="text-[14px] font-semibold text-slate-100">{pkg ? 'Edit package' : 'New package'}</h2>
        <p className="text-[12px] text-slate-400">
          {pkg
            ? <>Saved in <code className="text-slate-300">tools/python/custom/{pkg.id}/package.json</code>. Every other field in it is kept.</>
            : <>A new folder in <code className="text-slate-300">tools/python/custom/</code>, named after the title. Move detectors into it from their right-click menu, or drag them onto it.</>}
        </p>
        <label className="block space-y-1">
          <span className="text-[11px] uppercase tracking-wider text-slate-500">Title</span>
          <input ref={titleRef} value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} className={field} placeholder="Light show" required />
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] uppercase tracking-wider text-slate-500">Description</span>
          <textarea value={description} maxLength={500} rows={3} onChange={(e) => setDescription(e.target.value)} className={field} placeholder="What these detectors are for" />
        </label>
        {pkg && (
          <>
            <div className="flex gap-3">
              <label className="block flex-1 space-y-1">
                <span className="text-[11px] uppercase tracking-wider text-slate-500">Author</span>
                <input value={author} maxLength={120} onChange={(e) => setAuthor(e.target.value)} className={field} />
              </label>
              <label className="block w-24 space-y-1">
                <span className="text-[11px] uppercase tracking-wider text-slate-500">Version</span>
                <input value={version} maxLength={40} onChange={(e) => setVersion(e.target.value)} className={field} placeholder="1.0" />
              </label>
            </div>
            <label className="flex items-start gap-2 text-[12px] text-slate-300">
              <input type="checkbox" checked={teamOnly} onChange={(e) => setTeamOnly(e.target.checked)} className="mt-0.5" />
              <span>
                Team only
                <span className="block text-slate-500">Only signed-in team members see these detectors and their outputs. The demo never lists them.</span>
              </span>
            </label>
          </>
        )}
        {error && <p className="text-[12px] text-rose-300" role="alert">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="h-8 px-3 rounded border border-white/10 text-[12px] text-slate-300 hover:border-white/20">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!title.trim() || saving}
            className="h-8 px-3 rounded border border-amber-400/50 bg-amber-500/15 text-[12px] text-amber-100 hover:bg-amber-500/25 disabled:opacity-40"
          >
            {saving ? 'Saving…' : pkg ? 'Save' : 'Create package'}
          </button>
        </div>
      </form>
    </div>
  );
}
