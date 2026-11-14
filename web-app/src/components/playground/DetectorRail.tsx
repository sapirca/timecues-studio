import { useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { CustomRegistryEntry, DetectorPackage } from '../../types/customScript';
import { clusterByDetectorGroup, groupByDetectorPackage } from '../../utils/detectorPackages';
import { PlaygroundContextMenu, PlaygroundMenu, type PlaygroundMenuItem } from './PlaygroundMenu';
import { useResizableHeight } from '../../hooks/useResizableHeight';
import { HeightResizeHandle } from '../SidebarChrome';

/** Mirrors NAME_RE in tools/python/custom_loader.py. */
const DETECTOR_NAME_RE = /^[a-z][a-z0-9_-]{0,30}$/;

const STATUS_DOT: Record<CustomRegistryEntry['status'], { color: string; label: string }> = {
  ok:               { color: '#10b981', label: 'OK — runnable' },
  validation_error: { color: '#f59e0b', label: 'Validation error' },
  load_error:       { color: '#ef4444', label: 'Load error' },
};

/** The drag payload: the name of the detector being moved. */
const DRAG_TYPE = 'application/x-timecues-detector';

/** The Playground's left rail: every detector, by package, and the one being
 *  edited. Selecting a detector opens it in the editor; right-clicking one
 *  opens the file actions an editor's file list has — Rename, Duplicate,
 *  Move to package, Archive, Copy, Delete. Dragging a detector onto another
 *  package moves it there. Archived detectors wait in their own folded
 *  section at the bottom. Each row's icons say what the detector is. */
export function DetectorRail({
  detectors,
  packages,
  selectedName,
  isNew,
  onSelect,
  onNew,
  onInstall,
  installing,
  onReload,
  packageBusy,
  onNewPackage,
  onEditPackage,
  onSharePackage,
  onRemovePackage,
  onMove,
  onArchive,
  everyDetectorActions,
  onRename,
  onDuplicate,
  rowMenuItems,
  onCollapse,
  loading = false,
  children,
}: {
  detectors: CustomRegistryEntry[];
  packages: Record<string, DetectorPackage>;
  /** The detector open in the editor — null while a new one is. */
  selectedName: string | null;
  isNew: boolean;
  onSelect: (name: string) => void;
  onNew: () => void;
  onInstall: (file: File) => void;
  installing: boolean;
  onReload: () => void;
  packageBusy: string | null;
  /** Make a package — and, given a detector, move it into the new one. */
  onNewPackage: (moveName?: string) => void;
  onEditPackage: (id: string) => void;
  onSharePackage: (id: string) => void;
  onRemovePackage: (id: string, title: string) => void;
  /** Move a detector into a package, or out of every package (null). */
  onMove: (name: string, packageId: string | null) => Promise<void>;
  /** Archive a detector, or restore it. */
  onArchive: (name: string, archived: boolean) => Promise<void>;
  /** The actions that sweep every detector at once. */
  everyDetectorActions: PlaygroundMenuItem[];
  /** Rename a detector; resolves once it is done (or refused, and said so). */
  onRename: (name: string, newName: string) => Promise<void>;
  /** Duplicate a detector; resolves to the copy's name, or null. */
  onDuplicate: (name: string) => Promise<string | null>;
  /** The rest of a row's right-click menu, after the rail's own file actions. */
  rowMenuItems: (d: CustomRegistryEntry) => PlaygroundMenuItem[];
  /** Fold the rail to a slim column (desktop only). */
  onCollapse?: () => void;
  /** The registry is being read — each read imports every detector file. */
  loading?: boolean;
  /** The open detector's details, pinned under the list. */
  children?: ReactNode;
}) {
  const installRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [rowMenu, setRowMenu] = useState<{ d: CustomRegistryEntry; x: number; y: number } | null>(null);
  /** The "Move to package" choices, opened from a row's menu where it was. */
  const [moveMenu, setMoveMenu] = useState<{ d: CustomRegistryEntry; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // The details under the list trade height with it: drag the seam between.
  const { setPane: setDetailsPane, ...details } = useResizableHeight({ storageKey: 'tc:playground-rail-details-h', minHeight: 64 });
  /** Folded unless asked for: archived detectors are out of the way. */
  const [archivedOpen, setArchivedOpen] = useState(false);
  /** The detector being dragged, and the section it hovers. */
  const [dragging, setDragging] = useState<CustomRegistryEntry | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const renameTip = (d: CustomRegistryEntry) => (d.is_default
    ? 'A shipped example can\'t be renamed — Duplicate it, and rename the copy.'
    : 'Rename the detector: its file and its name = "…" line. Its runs and reviewed outputs move with it.');
  const duplicate = async (name: string) => {
    const copy = await onDuplicate(name);
    if (copy) setRenaming(copy);
  };
  const q = filter.trim().toLowerCase();
  const { groups, archived } = useMemo(() => {
    const shown = q
      ? detectors.filter((d) => d.name.toLowerCase().includes(q) || d.label.toLowerCase().includes(q))
      : detectors;
    // While filtering, a package with no match has nothing to show.
    const empty = q ? [] : Object.values(packages);
    return {
      groups: groupByDetectorPackage(shown.filter((d) => !d.archived), empty),
      archived: shown.filter((d) => d.archived).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }, [detectors, packages, q]);
  const selectedArchived = detectors.some((d) => d.archived && d.name === selectedName);
  // Opening an archived detector (the one last open, say) unfolds its section
  // — once per detector, so folding it again sticks.
  const [unfoldedFor, setUnfoldedFor] = useState<string | null>(null);
  if (selectedArchived && unfoldedFor !== selectedName) {
    setUnfoldedFor(selectedName);
    setArchivedOpen(true);
  }
  const showArchived = archivedOpen || !!q;

  /** Where a dragged detector may land: another package, or — for one in a
   *  package — the loose files. A shipped example never moves. */
  const canDrop = (packageId: string | null) => !!dragging && !dragging.is_default
    && (dragging.package ?? null) !== packageId;
  const dropProps = (key: string, accepts: boolean, drop: (name: string) => void) => ({
    onDragOver: (e: DragEvent) => {
      if (!accepts) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dropKey !== key) setDropKey(key);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropKey((k) => (k === key ? null : k));
    },
    onDrop: (e: DragEvent) => {
      if (!accepts) return;
      e.preventDefault();
      const name = e.dataTransfer.getData(DRAG_TYPE);
      setDragging(null);
      setDropKey(null);
      if (name) drop(name);
    },
  });
  const hasLoose = groups.some((g) => g.packageId === null);

  const moveTargets = (d: CustomRegistryEntry): PlaygroundMenuItem[] => {
    const here = d.package ?? null;
    const pkgs = Object.values(packages)
      .filter((p) => p.id !== here)
      .sort((a, b) => a.title.localeCompare(b.title));
    return [
      ...pkgs.map((p) => ({
        label: p.title,
        title: `Move ${d.name}.py into tools/python/custom/${p.id}/.`,
        onSelect: () => { void onMove(d.name, p.id); },
      })),
      ...(here ? [{
        label: 'No package',
        title: `Move ${d.name}.py out of its package, to the top of tools/python/custom/.`,
        separated: pkgs.length > 0,
        onSelect: () => { void onMove(d.name, null); },
      }] : []),
      {
        label: 'New package…',
        title: 'Make a package and move this detector into it.',
        separated: true,
        onSelect: () => onNewPackage(d.name),
      },
    ];
  };

  const renderRow = (d: CustomRegistryEntry, opts: { showPackage?: boolean } = {}) => {
    const active = !isNew && d.name === selectedName;
    const where = d.package_title ?? d.package ?? (d.is_default ? 'Default' : 'Custom');
    return (
      <li key={d.file}>
        {renaming === d.name ? (
          <div className="flex items-center gap-2 pl-6 pr-3 py-1.5 bg-amber-500/[0.08]">
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: STATUS_DOT[d.status].color }} aria-hidden />
            <RenameField
              name={d.name}
              onDone={(next) => {
                setRenaming(null);
                if (next) void onRename(d.name, next);
              }}
            />
          </div>
        ) : (
        <button
          type="button"
          draggable={!d.is_default && !d.archived}
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPE, d.name);
            e.dataTransfer.effectAllowed = 'move';
            setDragging(d);
          }}
          onDragEnd={() => { setDragging(null); setDropKey(null); }}
          onClick={() => onSelect(d.name)}
          onContextMenu={(e) => {
            e.preventDefault();
            setRowMenu({ d, x: e.clientX, y: e.clientY });
          }}
          onKeyDown={(e) => {
            if (e.key === 'F2' && !d.is_default) { e.preventDefault(); setRenaming(d.name); }
            else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setRowMenu({ d, x: r.left + 24, y: r.bottom });
            }
          }}
          aria-current={active ? 'true' : undefined}
          title={`${d.description || d.label}\n${d.archived
            ? `Archived, from ${where}. Right-click to Restore it.`
            : d.is_default ? 'Right-click for Rename, Duplicate, Copy, Delete…'
            : 'Drag onto another package to move it. Right-click for Rename, Move, Archive, Delete…'}`}
          className={`w-full flex items-center gap-2 pl-6 pr-3 py-1.5 text-left transition ${
            active
              ? 'bg-amber-500/[0.08] shadow-[inset_2px_0_0_#fbbf24]'
              : rowMenu?.d.name === d.name || moveMenu?.d.name === d.name ? 'bg-white/[0.05]' : 'hover:bg-white/[0.03]'
          } ${dragging?.name === d.name ? 'opacity-50' : ''}`}
        >
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: STATUS_DOT[d.status].color }}
            title={STATUS_DOT[d.status].label}
            aria-label={STATUS_DOT[d.status].label}
          />
          <span className="min-w-0 flex-1">
            <span className={`block truncate font-mono text-[12px] ${active ? 'text-amber-100' : d.archived ? 'text-slate-400' : 'text-slate-200'}`}>{d.name}</span>
            {opts.showPackage
              ? <span className="block truncate text-[10px] text-slate-500">{where}</span>
              : d.label && <span className="block truncate text-[10px] text-slate-500">{d.label}</span>}
          </span>
          <DetectorBadges d={d} />
          <span className="min-w-[3.75rem] text-right whitespace-nowrap text-[9px] uppercase tracking-wider text-slate-600 shrink-0">{d.output_kind}</span>
        </button>
        )}
      </li>
    );
  };

  return (
    <aside className="flex flex-col flex-1 min-h-0 rounded-lg border border-white/[0.06] bg-[#14171d]/80 overflow-hidden" aria-label="Detectors">
      <div className="flex items-center gap-1.5 px-3 h-11 border-b border-white/[0.05] shrink-0">
        <h2 className="flex-1 min-w-0 truncate text-[13px] uppercase tracking-[0.18em] text-slate-100 font-bold">Detectors</h2>
        <button
          type="button"
          onClick={onNew}
          className={`h-7 px-2 rounded border text-[11px] whitespace-nowrap transition ${
            isNew ? 'border-amber-400/50 bg-amber-500/15 text-amber-200' : 'border-white/10 text-slate-300 hover:border-white/20 hover:text-slate-100'
          }`}
          title="Start a new detector from the starter template. Save writes it to tools/python/custom/<name>.py."
        >
          + New
        </button>
        <input
          ref={installRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) onInstall(file);
          }}
        />
        <button
          type="button"
          onClick={onReload}
          disabled={loading}
          aria-label="Reload"
          className="h-7 w-7 shrink-0 grid place-items-center rounded border border-white/10 text-slate-400 hover:border-white/20 hover:text-slate-100 disabled:cursor-wait"
          title="Re-scan tools/python/custom/ — pick up file changes without restarting the server"
        >
          <span className={loading ? 'inline-block animate-spin' : undefined}>↻</span>
        </button>
        <PlaygroundMenu
          label="Packages, and actions on every detector"
          align="left"
          items={[
            {
              label: 'New package…',
              title: 'Make an empty package — a folder in tools/python/custom/ — to move detectors into.',
              onSelect: () => onNewPackage(),
            },
            {
              label: installing ? 'Installing…' : 'Install package…',
              title: 'Install a package of detectors someone shared with you — the .zip of its folder. It unpacks into tools/python/custom/<package>/.',
              disabled: installing,
              onSelect: () => installRef.current?.click(),
            },
            ...everyDetectorActions.map((it, i) => (i === 0 ? { ...it, separated: true } : it)),
          ]}
        />
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            title="Hide detectors"
            aria-label="Hide detectors"
            className="hidden lg:block text-slate-500 hover:text-slate-200 transition-colors text-xl leading-none px-0.5"
          >
            ‹
          </button>
        )}
      </div>
      <div className="px-3 pt-2.5 pb-2">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter detectors"
          aria-label="Filter detectors"
          className="w-full bg-[#0a0b0d] border border-white/10 rounded px-2 py-1.5 text-[12px] text-slate-200 placeholder:text-slate-600"
        />
        <BadgeLegend />
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto pb-2" aria-label="Detector packages">
        {loading && detectors.length === 0 && (
          <p className="flex items-center gap-2 px-3 py-4 text-[12px] text-slate-400" role="status">
            <span className="inline-block w-3 h-3 rounded-full border-[1.5px] border-amber-300/30 border-t-amber-300 animate-spin" aria-hidden />
            Loading detectors…
          </p>
        )}
        {!loading && detectors.length === 0 && (
          <p className="px-3 py-4 text-[12px] text-slate-500">
            No detectors yet. <span className="text-slate-300">+ New</span> starts one from a template, or drop a
            file into <code className="text-slate-300">tools/python/custom/</code> and click ↻.
          </p>
        )}
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key) && !filter;
          const pkg = g.packageId ? packages[g.packageId] : undefined;
          const title = g.title ?? 'Detectors';
          const nArchived = pkg?.archived?.length ?? 0;
          const menu: PlaygroundMenuItem[] = g.packageId ? [
            ...(!pkg?.is_default ? [{
              label: 'Edit package…',
              title: 'Its title, description, author, version, and whether the demo may see it — the package.json.',
              disabled: packageBusy === g.packageId,
              onSelect: () => onEditPackage(g.packageId!),
            }] : []),
            {
              label: 'Share package',
              title: `Download this package as ${g.packageId}.zip to send to a colleague. They install it with Install — or just unzip it into tools/python/custom/.`
                + (nArchived ? ` Its ${nArchived} archived detector${nArchived === 1 ? ' stays' : 's stay'} out of the zip.` : ''),
              disabled: packageBusy === g.packageId,
              onSelect: () => onSharePackage(g.packageId!),
            },
            ...(!pkg?.is_default ? [{
              label: 'Remove package…',
              title: 'Remove this package and its detectors. The folder moves to tools/python/custom/.trash/ — nothing is erased.',
              danger: true,
              separated: true,
              disabled: packageBusy === g.packageId,
              onSelect: () => onRemovePackage(g.packageId!, title),
            }] : []),
          ] : [];
          const accepts = canDrop(g.packageId);
          const isDrop = accepts && dropKey === g.key;
          return (
            <section
              key={g.key}
              className={`mt-1 rounded transition ${isDrop ? 'bg-amber-500/[0.07] ring-1 ring-inset ring-amber-400/50' : ''}`}
              {...dropProps(g.key, accepts, (name) => { void onMove(name, g.packageId); })}
            >
              {g.title !== null && (
                <div className="group flex items-center gap-1 pl-2 pr-2 py-1">
                  <button
                    type="button"
                    onClick={() => setCollapsed((cur) => {
                      const next = new Set(cur);
                      if (next.has(g.key)) next.delete(g.key); else next.add(g.key);
                      return next;
                    })}
                    aria-expanded={!isCollapsed}
                    className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
                    title={[pkg?.description, pkg?.author && `by ${pkg.author}`, pkg?.version && `v${pkg.version}`,
                      nArchived ? `${nArchived} archived` : null, pkg?.manifest_error]
                      .filter(Boolean).join(' · ') || undefined}
                  >
                    <Disclosure open={!isCollapsed} />
                    <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-slate-300">{title}</span>
                    <span className="text-[10px] text-slate-600">{g.items.length}</span>
                    {pkg?.manifest_error && <span className="text-[10px] text-amber-300" aria-label="package.json problem">⚠</span>}
                  </button>
                  {isDrop && <span className="text-[10px] text-amber-200 whitespace-nowrap">Move here</span>}
                  {menu.length > 0 && <PlaygroundMenu label={`${title} package actions`} items={menu} />}
                </div>
              )}
              {!isCollapsed && g.items.length === 0 && (
                <p className="pl-6 pr-3 py-1.5 text-[11px] text-slate-600">
                  Empty — drag a detector here, or right-click one › Move to package.
                </p>
              )}
              {!isCollapsed && clusterByDetectorGroup(g.items).map((c) => (
                <ul key={c.title ?? ''} aria-label={c.title ?? undefined}>
                  {c.title !== null && (
                    <li className="pl-6 pr-3 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-500" aria-hidden>
                      {c.title}
                    </li>
                  )}
                  {c.items.map((d) => renderRow(d))}
                </ul>
              ))}
            </section>
          );
        })}

        {/* No loose files to drop onto: while a packaged detector is dragged,
            offer the way out of its package anyway. */}
        {!hasLoose && dragging?.package && canDrop(null) && (
          <div
            className={`mx-2 mt-2 rounded border border-dashed px-3 py-2 text-[11px] transition ${
              dropKey === 'loose' ? 'border-amber-400/60 bg-amber-500/[0.07] text-amber-200' : 'border-white/15 text-slate-500'
            }`}
            {...dropProps('loose', true, (name) => { void onMove(name, null); })}
          >
            Drop here to take it out of its package
          </div>
        )}

        {(archived.length > 0 || (dragging && !dragging.archived)) && (
          <section
            className={`mt-3 border-t border-white/[0.05] pt-1 rounded transition ${
              dragging && dropKey === 'archived' ? 'bg-amber-500/[0.07] ring-1 ring-inset ring-amber-400/50' : ''
            }`}
            aria-label="Archived detectors"
            {...dropProps('archived', !!dragging && !dragging.archived, (name) => { void onArchive(name, true); })}
          >
            <button
              type="button"
              onClick={() => setArchivedOpen((o) => !o)}
              aria-expanded={showArchived}
              className="w-full flex items-center gap-1.5 pl-2 pr-3 py-1 text-left"
              title="Archived detectors keep their code, their package and their outputs, but no other page lists them, no “every detector” run runs them, and Share package leaves them out. Right-click one to Restore it."
            >
              <Disclosure open={showArchived} />
              <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-slate-500">Archived</span>
              <span className="text-[10px] text-slate-600">{archived.length}</span>
              {dragging && dropKey === 'archived' && <span className="ml-auto text-[10px] text-amber-200">Archive it</span>}
            </button>
            {showArchived && archived.length > 0 && (
              <ul>{archived.map((d) => renderRow(d, { showPackage: true }))}</ul>
            )}
          </section>
        )}
      </nav>

      {rowMenu && (
        <PlaygroundContextMenu
          at={{ x: rowMenu.x, y: rowMenu.y }}
          label={`${rowMenu.d.name} actions`}
          onClose={() => setRowMenu(null)}
          items={[
            { label: 'Open', onSelect: () => onSelect(rowMenu.d.name) },
            { label: 'Rename…', hint: 'F2', title: renameTip(rowMenu.d), disabled: rowMenu.d.is_default, onSelect: () => setRenaming(rowMenu.d.name) },
            {
              label: 'Duplicate',
              title: 'Copy the detector\'s saved file to a new name beside it, then name the copy.',
              onSelect: () => { void duplicate(rowMenu.d.name); },
            },
            {
              label: 'Move to package…',
              title: rowMenu.d.is_default
                ? 'A shipped example can\'t be moved — Duplicate it, and move the copy.'
                : 'Move the file into another package, or out of its package. Its runs and outputs stay with it.',
              disabled: rowMenu.d.is_default,
              onSelect: () => { const { d, x, y } = rowMenu; setMoveMenu({ d, x, y }); },
            },
            rowMenu.d.archived ? {
              label: 'Restore',
              title: `Bring it back into ${rowMenu.d.package_title ?? 'its list'}: the Inspect tab lists it again, “every detector” runs include it, and Share package carries it.`,
              onSelect: () => { void onArchive(rowMenu.d.name, false); },
            } : {
              label: 'Archive',
              title: 'Keep the code, but take it out of the way: the Inspect tab stops listing it, “every detector” runs skip it, and Share package leaves it out. Restore it any time from Archived, at the bottom of this list.',
              onSelect: () => { void onArchive(rowMenu.d.name, true); },
            },
            ...rowMenuItems(rowMenu.d),
          ]}
        />
      )}
      {moveMenu && (
        <PlaygroundContextMenu
          at={{ x: moveMenu.x, y: moveMenu.y }}
          label={`Move ${moveMenu.d.name} to`}
          onClose={() => setMoveMenu(null)}
          items={moveTargets(moveMenu.d)}
        />
      )}

      {children && (
        <div
          ref={setDetailsPane}
          className={`relative flex flex-col bg-[#0b0d11] shadow-[0_-8px_16px_-8px_rgba(0,0,0,0.7)] ${details.height === null ? 'max-h-[45%]' : 'shrink-0'}`}
          style={details.height === null ? undefined : { height: details.height }}
        >
          <HeightResizeHandle pane={details} />
          <div className="flex-1 min-h-0 overflow-y-auto">
            {children}
          </div>
        </div>
      )}
    </aside>
  );
}

/** The open/closed arrow of a foldable section: a solid triangle, turned
 *  down when open. */
function Disclosure({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 12 12" className={`w-3 h-3 shrink-0 text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>
      <path d="M4 2.5l5 3.5-5 3.5z" fill="currentColor" />
    </svg>
  );
}

const ROLE_TIP = {
  annotator: 'Annotator — a run also copies its output into the annotator\'s own annotation (is_annotation = True). It shows in the Inspect tab too.',
  algorithm: 'Algorithm — its lanes show in the Inspect tab only; nothing is copied into an annotation (is_annotation = False).',
  review: 'Review — every item it draws gets a ✓/✗ to accept or reject (review = True).',
};

/** A pencil: the output lands in an annotation. */
function AnnotatorIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.5 2.5l3 3L6 13H3v-3z" />
      <path d="M9 4l3 3" />
    </svg>
  );
}

/** A signal trace: the output is an algorithm lane. */
function AlgorithmIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M1.5 9h2.5l1.5-5 3 9 2-6 1 2h3" />
    </svg>
  );
}

/** A tick in a box: every item is reviewed ✓/✗. */
function ReviewIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="2" width="12" height="12" rx="2.5" />
      <path d="M5 8.2l2 2L11 6" />
    </svg>
  );
}

/** What a detector is, at a glance: annotator or algorithm, and whether its
 *  items are reviewed. The same two flags as the details' Flags switches. */
function DetectorBadges({ d }: { d: Pick<CustomRegistryEntry, 'is_annotation' | 'review'> }) {
  return (
    <span className="flex items-center gap-1 shrink-0">
      <span className="w-3.5 h-3.5">
        {d.review && (
          <span title={ROLE_TIP.review} aria-label="Review" role="img"><ReviewIcon className="w-3.5 h-3.5 text-emerald-400" /></span>
        )}
      </span>
      {d.is_annotation ? (
        <span title={ROLE_TIP.annotator} aria-label="Annotator" role="img"><AnnotatorIcon className="w-3.5 h-3.5 text-amber-300" /></span>
      ) : (
        <span title={ROLE_TIP.algorithm} aria-label="Algorithm" role="img"><AlgorithmIcon className="w-3.5 h-3.5 text-sky-400" /></span>
      )}
    </span>
  );
}

/** The key to the row icons, under the filter. */
function BadgeLegend() {
  return (
    <div className="flex items-center gap-3 mt-2 text-[10px] text-slate-500">
      <span className="flex items-center gap-1" title={ROLE_TIP.annotator}><AnnotatorIcon className="w-3 h-3 text-amber-300" />Annotator</span>
      <span className="flex items-center gap-1" title={ROLE_TIP.algorithm}><AlgorithmIcon className="w-3 h-3 text-sky-400" />Algorithm</span>
      <span className="flex items-center gap-1" title={ROLE_TIP.review}><ReviewIcon className="w-3 h-3 text-emerald-400" />Review</span>
    </div>
  );
}

/** The detector's name, editable in place — Enter or leaving the field saves,
 *  Escape keeps the old one. */
function RenameField({ name, onDone }: { name: string; onDone: (next: string | null) => void }) {
  const [value, setValue] = useState(name);
  const doneRef = useRef(false);
  const valid = DETECTOR_NAME_RE.test(value);
  const finish = (next: string | null) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(next && next !== name && DETECTOR_NAME_RE.test(next) ? next : null);
  };
  return (
    <input
      autoFocus
      value={value}
      aria-label={`New name for ${name}`}
      aria-invalid={!valid}
      title={valid ? 'Enter to rename · Esc to cancel' : 'Lowercase letters, digits, _ and - only; starts with a letter; at most 31 characters.'}
      spellCheck={false}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); if (valid) finish(value.trim()); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(null); }
        e.stopPropagation();
      }}
      onBlur={() => finish(valid ? value.trim() : null)}
      className={`w-full bg-[#0a0b0d] rounded px-1 py-0.5 font-mono text-[12px] text-slate-100 outline-none border ${
        valid ? 'border-amber-400/60' : 'border-rose-400/70'
      }`}
    />
  );
}

/** One heading + rows in the rail's details block. */
export function RailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="px-3 py-2.5 border-b border-white/[0.05] last:border-b-0">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 mb-1.5">{title}</h3>
      {children}
    </div>
  );
}

/** A label/value row in the rail's details block. */
export function RailFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-5">
      <span className="w-16 shrink-0 text-slate-500">{label}</span>
      <span className="min-w-0 flex-1 text-slate-200 break-words">{children}</span>
    </div>
  );
}
