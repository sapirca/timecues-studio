import { BrowserRouter, Routes, Route, useLocation, Navigate } from 'react-router-dom';
import { AnnotatorProvider, useAnnotator } from './context/AnnotatorContext';
import { DemoProvider, useDemo } from './context/DemoContext';
import { SettingsProvider } from './context/SettingsContext';
import { InspectorPageV2 } from './pages/InspectorPageV2';
import { CustomScriptsPage } from './pages/CustomScriptsPage';
import { SettingsPage } from './pages/SettingsPage';
import { TeamPage } from './pages/TeamPage';
import { LandingPage } from './pages/LandingPage';
import { DemoPage } from './pages/DemoPage';
import { NewDatasetSetup } from './pages/NewDatasetSetup';
import { LoginScreen } from './components/LoginScreen';
import { AnnotatorBadge } from './components/AnnotatorBadge';
import { RequireAdmin } from './components/RequireAdmin';
import { WorkspaceTabHeader, isWorkspacePath } from './components/WorkspaceTabHeader';

/** Routes that need an identity. Anonymous users hitting these get bounced to
 *  /login?returnTo=<path> and resume after sign-in. Landing, Demo, Login, and
 *  the bootstrap setup page (/new-dataset, which has its own Google-only
 *  sign-in) render without auth. */
const AUTH_REQUIRED = new Set(['/prep', '/annotate', '/inspect', '/custom', '/team', '/settings']);

/** Routes that demo visitors are not allowed to reach. Playground (`/custom`)
 *  uploads + executes arbitrary Python on the server; Team (`/team`) is a
 *  privileged dashboard. Both are bounced back to the landing page when
 *  isDemo is true. The server enforces the same block independently — see
 *  the demo annotator gate in vite.config.ts and tools/python/custom_server.py
 *  — so a hand-crafted client that skips the UI still hits a 403. */
const DEMO_FORBIDDEN = new Set(['/custom', '/team']);

function AppShell() {
  const { annotator, isSigningOut } = useAnnotator();
  const { isDemo, isExitingDemo } = useDemo();
  const { pathname, search } = useLocation();

  if (isDemo && DEMO_FORBIDDEN.has(pathname)) {
    return <Navigate to="/" replace />;
  }

  // Demo Mode bypasses the auth gate entirely — the synthesized demo
  // annotator in AnnotatorContext keeps downstream code happy without an
  // actual sign-in. isSigningOut and isExitingDemo each suppress the gate for
  // the brief tick between (annotator/demo cleared) and the route change to
  // '/' landing, so a sign-out or demo-exit from a protected route doesn't
  // bounce through /login.
  if (AUTH_REQUIRED.has(pathname) && !annotator && !isDemo && !isSigningOut && !isExitingDemo) {
    const returnTo = encodeURIComponent(pathname + search);
    return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
  }

  // LandingPage renders its own inline AnnotatorBadge in its header; workspace
  // routes get the badge via the App-level WorkspaceTabHeader below. On the
  // rest, we drop a floating badge so the signed-in identity is always visible.
  const inlineBadgeRoutes = ['/'];
  const showFloatingBadge = !!annotator && !inlineBadgeRoutes.includes(pathname) && !isWorkspacePath(pathname);

  return (
    <>
      {showFloatingBadge && <AnnotatorBadge />}
      {/* The workspace tab header is mounted ONCE here, above every workspace
          route, so its width/padding/position is identical regardless of the
          page below. Pages no longer render their own copy. */}
      {isWorkspacePath(pathname) && (
        <div className="sticky top-0 z-40 px-3 py-2 bg-[#0a0b0d]">
          <WorkspaceTabHeader />
        </div>
      )}
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/demo" element={<DemoPage />} />
        <Route path="/new-dataset" element={<NewDatasetSetup />} />
        <Route path="/login" element={<LoginScreen />} />
        {/* Three inspector workspaces share a single mounted InspectorPageV2
            instance via this layout route. Switching tabs only updates the
            `feature` prop (read from pathname); nothing remounts, nothing
            re-fetches, so the new tab paints immediately.
            The empty fragments on each leaf are deliberate — InspectorRoute
            renders the page directly (no Outlet), but React Router warns if a
            matched leaf has no element, so we hand it a no-op. */}
        <Route element={<InspectorRoute />}>
          <Route path="/prep"     element={<></>} />
          <Route path="/annotate" element={<></>} />
          <Route path="/inspect"  element={<></>} />
        </Route>
        <Route path="/custom" element={<CustomScriptsPage />} />
        <Route path="/team" element={<RequireAdmin tier="researcher"><TeamPage /></RequireAdmin>} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

/** Renders a single InspectorPageV2 for all three inspector paths. The
 *  pathname → feature mapping lives here; switching between /prep, /annotate,
 *  and /inspect updates the prop without remounting the page. */
function InspectorRoute() {
  const { pathname } = useLocation();
  const feature =
    pathname === '/prep' ? 'prep' :
    pathname === '/inspect' ? 'inspect-song' :
    'annotate';
  return <InspectorPageV2 onBack={() => {}} feature={feature} />;
}

function App() {
  return (
    <BrowserRouter>
      <DemoProvider>
        <AnnotatorProvider>
          <SettingsProvider>
            <AppShell />
          </SettingsProvider>
        </AnnotatorProvider>
      </DemoProvider>
    </BrowserRouter>
  );
}

export default App;
