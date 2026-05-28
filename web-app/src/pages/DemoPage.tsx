import { useNavigate } from 'react-router-dom';
import { useDemo } from '../context/DemoContext';
import { AppPageHeader } from '../components/AppPageHeader';

/**
 * Demo Mode introduction. One click and the visitor is in Dataset Prep on the
 * demo corpus with the demo guardrails enabled (no server writes, no upload,
 * no download, edits cached in this browser). They can switch to the Annotator
 * Tool or Algorithm Inspect from the workspace tab strip.
 *
 * This page is intentionally lightweight — most of the demo logic lives in
 * DemoContext / demoFlag / demoStorage / manualAnnotations branches.
 */
export function DemoPage() {
  const navigate = useNavigate();
  const { enterDemo } = useDemo();

  const startDemo = () => {
    enterDemo();
    navigate('/prep');
  };

  return (
    <div className="min-h-screen bg-[#0a0b0d] text-slate-200 flex flex-col">
      <AppPageHeader back={{ label: 'Back to main' }} />
      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-lg bg-[#14171d] border border-violet-500/20 rounded-md shadow-2xl shadow-black/60 p-6 space-y-5">
          <div className="flex items-center justify-center gap-2 text-[10px] font-semibold tracking-[0.2em] uppercase text-violet-300">
            <span className="tc-led tc-led-mute !bg-violet-400 !shadow-[0_0_6px_rgba(167,139,250,0.55)]" />
            Demo Mode
          </div>
          <h1 className="text-lg font-medium text-slate-100 text-center">Try the full annotator anonymously</h1>
          <p className="text-[12px] text-slate-400 leading-relaxed text-center">
            You'll land in <strong>Dataset Prep</strong> on the public sample songs.
            From there switch to the Annotator Tool or Algorithm Inspect via the
            workspace tab strip — see what the tool can do without signing up.
          </p>

          <ul className="text-[11px] text-slate-400 leading-relaxed space-y-1.5 bg-black/30 border border-white/[0.05] rounded p-3">
            <li><span className="text-emerald-300">✓</span> Your edits are saved to <strong>this browser only</strong> and never reach the server.</li>
            <li><span className="text-amber-300">✗</span> Uploading new songs is disabled.</li>
            <li><span className="text-amber-300">✗</span> Downloading or exporting the corpus is disabled.</li>
            <li><span className="text-slate-400">↻</span> Clearing your browser's site data (cache / cookies) wipes every demo edit.</li>
          </ul>

          <div className="flex flex-col gap-2 pt-1">
            <button
              onClick={startDemo}
              className="w-full px-4 py-2 rounded text-[11px] uppercase tracking-wider bg-violet-500/20 hover:bg-violet-500/30 border border-violet-400/40 text-violet-100 font-medium transition-colors"
            >
              Start Demo →
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
