'use client';
/**
 * The studio, assembled.
 *
 * One screen that never scrolls: a top bar, three columns over a dock, and a
 * status line. Everything in it reads the store and runs registered commands,
 * so this file is layout and wiring — the rules live in `reducer.ts`, the
 * operations in `actions.ts`, and the panels are the ones the engine ships.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ViewHandle } from '@/components/asset-viewport';
import { Outliner } from '@/components/outliner';
import { FindingsPanel } from '@/components/findings-panel';
import { SpecEditor } from '@/components/spec-editor';
import { Timeline } from '@/components/timeline';
import { auditModel, type Audit } from '@/lib/asset-audit';
import { buildSpec, parseSpec } from '@/lib/asset-spec';
import { fileName } from '@/lib/asset-recipe';
import {
  buildAsset,
  download,
  exportAsset,
  exportSpecAsset,
  objBundle,
} from '@/lib/asset-export';
import { readySurface } from '@/lib/asset-surface';
import { disposeScene } from '@/lib/three-world';
import { registerStudioTools } from '@/lib/studio-tools';
import { flatten, pathKey, type Path } from '@/lib/spec-edit';
import {
  runCommand,
  type ActionContext,
  type ExportFormat,
  type NewKind,
} from './actions';
import { handleKey } from './keymap';
import { BuildsPanel } from './builds-panel';
import { BlueprintDialog } from './blueprint-dialog';
import { CommandPalette } from './palette';
import { JsonPanel } from './json-panel';
import { LibraryPanel } from './library-panel';
import { ProjectsPanel } from './projects-panel';
import { RecipePanel } from './recipe-panel';
import { ShortcutsDialog } from './shortcuts-dialog';
import { Splitter } from './splitter';
import { TopBar } from './top-bar';
import { ViewportPanel } from './viewport-panel';
import { changedPaths, DEFAULT_LAYOUT, isDirty, MIN } from './reducer';
import { useStudio } from './store';
import { useDocument } from './use-document';
import { useFollow } from './use-follow';

/** A new document, so "New → Empty spec" lands on something you can edit. */
const EMPTY_SPEC = {
  version: 1 as const,
  name: 'Untitled',
  kind: 'prop' as const,
  parts: [{ name: 'body', shape: 'box' as const, size: [1, 1, 1] }],
};

/** One tab strip, used by all three panel areas. */
function Tabs<T extends string>({
  label,
  value,
  tabs,
  onChange,
  children,
}: {
  label: string;
  value: T;
  tabs: { id: T; label: string }[];
  onChange: (id: T) => void;
  children?: ReactNode;
}) {
  return (
    <div className="tab-strip" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
      {children}
    </div>
  );
}

export function StudioShell() {
  const { state, dispatch, ref } = useStudio();
  const docOps = useDocument();
  const { save, reattach, openSpec } = useFollow();
  const view = useRef<ViewHandle | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  /** True while a file is being dragged over the window, for the drop hint. */
  const [dropping, setDropping] = useState(false);

  const spec = state.doc.spec;

  // Loaded up front, and the audit re-runs once it lands, so the first surface
  // spec someone opens builds the same way every later one does.
  useEffect(() => {
    let live = true;
    void readySurface().then(() => live && dispatch({ type: 'surfaceReady' }));
    return () => {
      live = false;
    };
  }, [dispatch]);

  const ready = !spec?.surface || state.surfaceReady;

  /** Re-checked on every spec change, so the panel describes what is on screen. */
  const audit = useMemo<Audit | null>(() => {
    if (!spec || !ready) return null;
    try {
      const model = buildSpec(spec);
      const result = auditModel(model, {
        rigged: Boolean(spec.rig),
        scale: spec.scale,
        labels: new Map(
          flatten(spec).map((row) => [
            pathKey(row.path),
            row.part.name ?? row.part.shape,
          ]),
        ),
      });
      disposeScene(model);
      return result;
    } catch {
      return null;
    }
  }, [spec, ready]);

  const labels = useMemo(
    () =>
      spec
        ? new Map(
            flatten(spec).map((row) => [
              pathKey(row.path),
              row.part.name ?? row.part.shape,
            ]),
          )
        : undefined,
    [spec],
  );

  // The build log's pass/fail column, filled in once the checks have run.
  useEffect(() => {
    if (audit) dispatch({ type: 'buildStats', ok: audit.ok });
  }, [audit, dispatch]);

  // Keyed on what the answer actually depends on: a hover dispatch arrives
  // twenty times a second, and re-diffing two whole specs for each one is a
  // cost nothing on screen would have paid for.
  const changed = useMemo(
    () => changedPaths(ref.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.doc, state.builds],
  );

  const exportAs = useCallback(
    async (format: ExportFormat) => {
      const { recipe, spec: current } = ref.current.doc;
      const name = current?.name ?? recipe.name;
      dispatch({ type: 'busy', busy: true });
      try {
        if (format === 'json') {
          const source = current ?? recipe;
          download(
            new Blob([JSON.stringify(source, null, 2)], {
              type: 'application/json',
            }),
            `${fileName(name)}.${current ? 'spec' : 'recipe'}.json`,
          );
          dispatch({
            type: 'status',
            text: current ? 'Spec JSON downloaded.' : 'Recipe JSON downloaded.',
          });
        } else if (format === 'obj') {
          // Built here rather than in the exporters because `objBundle` takes a
          // model, and the viewport's copy is posed by whatever clip is running.
          const model = current ? buildSpec(current) : buildAsset(recipe);
          const bundle = objBundle(model, name, current?.color ?? recipe.color);
          disposeScene(model);
          download(new Blob([bundle.obj], { type: 'text/plain' }), `${bundle.base}.obj`);
          // A second click in the same tick is a popup to some browsers.
          setTimeout(
            () =>
              download(
                new Blob([bundle.mtl], { type: 'text/plain' }),
                `${bundle.base}.mtl`,
              ),
            300,
          );
          dispatch({ type: 'status', text: 'OBJ and MTL downloaded (static mesh).' });
        } else {
          if (current) await exportSpecAsset(current, format);
          else await exportAsset(recipe, format);
          dispatch({
            type: 'status',
            text:
              format === 'unity'
                ? 'Unity pack downloaded: GLB, OBJ + MTL, source, and notes.'
                : 'GLB downloaded.',
          });
        }
      } catch (error) {
        dispatch({
          type: 'status',
          text: `Export failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        });
      } finally {
        dispatch({ type: 'busy', busy: false });
      }
    },
    [dispatch, ref],
  );

  const create = useCallback(
    (kind: NewKind) => {
      if (kind === 'blueprint') return dispatch({ type: 'modal', modal: 'blueprint' });
      if (kind === 'url') return dispatch({ type: 'modal', modal: 'url' });
      if (kind === 'import') return picker.current?.click();
      docOps.load(parseSpec(EMPTY_SPEC), 'human', 'New empty spec: %s.');
    },
    [dispatch, docOps],
  );

  const focusFilter = useCallback(() => {
    // The outliner owns its filter box, and it is the one input in the studio
    // reachable by name rather than by ref without changing that component.
    const input = window.document.querySelector<HTMLInputElement>(
      '.outliner-filter input',
    );
    input?.focus();
    input?.select();
  }, []);

  const context = useMemo<ActionContext>(
    () => ({
      state,
      dispatch,
      view: () => view.current,
      canvas: () =>
        window.document.querySelector<HTMLCanvasElement>('.asset-viewport canvas'),
      save: () => void save(),
      exportAs: (format) => void exportAs(format),
      create,
      reattach,
      openSpec,
      focusFilter,
      removeSelected: docOps.removeSelected,
      duplicateSelected: docOps.duplicateSelected,
    }),
    [
      create,
      dispatch,
      docOps.duplicateSelected,
      docOps.removeSelected,
      exportAs,
      focusFilter,
      openSpec,
      reattach,
      save,
      state,
    ],
  );

  // Registered once; the handler reads the newest context through this ref so
  // it never runs a command against a state three renders old.
  const live = useRef(context);
  live.current = context;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => handleKey(event, live.current);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** The canvas changes its own gizmo mode on g/r/s; mirror it for the palette. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'g' || key === 'w') dispatch({ type: 'gizmo', mode: 'translate' });
      else if (key === 'r' || key === 'e') dispatch({ type: 'gizmo', mode: 'rotate' });
      else if (key === 's') dispatch({ type: 'gizmo', mode: 'scale' });
    };
    const canvas = window.document.querySelector('.asset-viewport canvas');
    canvas?.addEventListener('keydown', onKey as EventListener);
    return () => canvas?.removeEventListener('keydown', onKey as EventListener);
  }, [dispatch]);

  // The in-page agent tools edit the generator recipe, and predate the shell.
  useEffect(
    () =>
      registerStudioTools(
        () => ref.current.doc.recipe,
        (recipe) => docOps.editRecipe(recipe),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /** Whether closing the tab right now would lose something. */
  const unsaved = useMemo(() => isDirty(state), [state]);

  // The studio holds the only copy of an edit until Save writes it back, and a
  // reflex ⌘W is how that copy is lost. The listener is only registered while
  // there is something to lose, because a page that always asks is a page
  // people learn to click through.
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      // Two spellings for one prompt: Chrome honours the cancelled event,
      // Safari still wants the legacy return value set.
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  /** One door for every file that arrives: the picker, and a drop. */
  const openFile = useCallback(
    async (file: File) => {
      if (file.size > 4_000_000)
        return docOps.status('That file is too large to be a spec.');
      try {
        docOps.load(
          JSON.parse(await file.text()),
          'import',
          'Imported %s. This document is yours — Save writes it to a followed file.',
        );
      } catch (error) {
        docOps.status(
          error instanceof Error ? error.message : 'Could not read that file.',
        );
      }
    },
    [docOps],
  );

  const layout = state.layout;
  const frameFinding = (path: Path) => {
    dispatch({ type: 'select', selection: { kind: 'part', path } });
    view.current?.frame({ kind: 'part', path });
  };

  return (
    <main
      className="studio"
      data-dropping={dropping ? 'true' : undefined}
      style={
        {
          '--left': `${layout.leftOpen ? layout.left : 0}px`,
          '--right': `${layout.rightOpen ? layout.right : 0}px`,
          '--dock': `${layout.dockOpen ? layout.dock : 0}px`,
        } as React.CSSProperties
      }
      // A spec is a file, and dragging one onto the window is what everybody
      // tries first. `dragOver` has to be cancelled or the browser navigates to
      // the file instead, which loses the document that was on screen.
      onDragOver={(event) => {
        if (!event.dataTransfer?.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(event) => {
        // Only the drag actually leaving the window, not every crossing of an
        // inner element's edge on the way across it.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer?.files.length) return;
        event.preventDefault();
        setDropping(false);
        void openFile(event.dataTransfer.files[0]);
      }}
    >
      <TopBar context={context} />

      <div className="studio-body">
        {layout.leftOpen && (
          <aside className="column column-left" aria-label="Scene">
            <Tabs
              label="Left panel"
              value={state.leftTab}
              tabs={[
                { id: 'projects', label: 'Projects' },
                { id: 'outliner', label: 'Outliner' },
                { id: 'library', label: 'Library' },
              ]}
              onChange={(tab) => dispatch({ type: 'leftTab', tab })}
            >
              <button
                className="tab-collapse"
                aria-label="Collapse the left column"
                title="Collapse (⌘B)"
                onClick={() => runCommand('panel.left', context)}
              >
                <ChevronLeft size={13} />
              </button>
            </Tabs>
            <div className="panel-body">
              {state.leftTab === 'projects' ? (
                <ProjectsPanel context={context} />
              ) : state.leftTab === 'outliner' ? (
                spec ? (
                  <Outliner
                    spec={spec}
                    selected={state.selection}
                    hover={state.hover}
                    onSelect={(selection) => dispatch({ type: 'select', selection })}
                    onHover={(selection) => dispatch({ type: 'hover', selection })}
                    onDelete={() => docOps.removeSelected()}
                    onDuplicate={() => docOps.duplicateSelected()}
                    onRename={(path, name) => docOps.transformPart(path, { name })}
                    onFrame={frameFinding}
                    onIsolate={(path) =>
                      dispatch({ type: 'isolate', selection: { kind: 'part', path } })
                    }
                    changed={changed as Set<string>}
                    bones
                  />
                ) : (
                  <p className="panel-empty help">
                    The outliner lists the parts of an authored spec. This document
                    is a generator recipe — open one from Projects, follow a build,
                    or import a spec file.
                  </p>
                )
              ) : (
                <LibraryPanel capture={() => view.current?.capture() ?? ''} />
              )}
            </div>
          </aside>
        )}
        {layout.leftOpen && (
          <Splitter
            orientation="vertical"
            label="Resize the left column"
            value={layout.left}
            min={MIN.left}
            max={520}
            onResize={(left) => dispatch({ type: 'layout', patch: { left } })}
            onReset={() =>
              dispatch({ type: 'layout', patch: { left: DEFAULT_LAYOUT.left } })
            }
          />
        )}

        <ViewportPanel view={view} context={context} />

        {layout.rightOpen && (
          <Splitter
            orientation="vertical"
            label="Resize the right column"
            value={layout.right}
            min={MIN.right}
            max={560}
            invert
            onResize={(right) => dispatch({ type: 'layout', patch: { right } })}
            onReset={() =>
              dispatch({ type: 'layout', patch: { right: DEFAULT_LAYOUT.right } })
            }
          />
        )}
        {layout.rightOpen && (
          <aside className="column column-right" aria-label="Properties">
            <Tabs
              label="Right panel"
              value={state.rightTab}
              tabs={[
                { id: 'properties', label: 'Properties' },
                { id: 'checks', label: 'Checks' },
                { id: 'asset', label: 'Asset' },
                { id: 'json', label: 'JSON' },
              ]}
              onChange={(tab) => dispatch({ type: 'rightTab', tab })}
            >
              <button
                className="tab-collapse"
                aria-label="Collapse the right column"
                title="Collapse (⌘I)"
                onClick={() =>
                  dispatch({ type: 'layout', patch: { rightOpen: false } })
                }
              >
                <ChevronRight size={13} />
              </button>
            </Tabs>
            <div className="panel-body">
              {state.rightTab === 'json' ? (
                spec ? (
                  <JsonPanel
                    spec={spec}
                    onApply={(next) => docOps.editSpec(next)}
                    onStatus={docOps.status}
                  />
                ) : (
                  <p className="panel-empty help">
                    This document is a generator recipe, not an authored spec.
                    Open one from Projects to edit its JSON here.
                  </p>
                )
              ) : state.rightTab === 'checks' ? (
                <FindingsPanel
                  audit={audit}
                  labels={labels}
                  onSelectPart={(path) =>
                    dispatch({ type: 'select', selection: { kind: 'part', path } })
                  }
                  onFrame={frameFinding}
                />
              ) : spec ? (
                <SpecEditor
                  spec={spec}
                  audit={audit}
                  // The Asset tab is the same editor with nothing selected,
                  // which is exactly what it shows asset-level fields for.
                  selected={state.rightTab === 'asset' ? null : state.selection}
                  onSelect={(selection) => {
                    dispatch({ type: 'select', selection });
                    if (selection) dispatch({ type: 'rightTab', tab: 'properties' });
                  }}
                  onChange={docOps.editSpec}
                  onDelete={docOps.removeSelected}
                  onDuplicate={docOps.duplicateSelected}
                  onStatus={docOps.status}
                  showParts={false}
                />
              ) : (
                <RecipePanel section={state.rightTab === 'asset' ? 'asset' : 'shape'} />
              )}
            </div>
          </aside>
        )}
      </div>

      {layout.dockOpen && (
        <Splitter
          orientation="horizontal"
          label="Resize the bottom dock"
          value={layout.dock}
          min={MIN.dock}
          max={480}
          invert
          onResize={(dock) => dispatch({ type: 'layout', patch: { dock } })}
          onReset={() =>
            dispatch({ type: 'layout', patch: { dock: DEFAULT_LAYOUT.dock } })
          }
        />
      )}
      {layout.dockOpen && (
        <section className="dock" aria-label="Dock">
          <Tabs
            label="Dock"
            value={state.dockTab}
            tabs={[
              { id: 'timeline', label: 'Timeline' },
              { id: 'builds', label: 'Builds' },
            ]}
            onChange={(tab) => dispatch({ type: 'dockTab', tab })}
          />
          <div className="panel-body">
            {state.dockTab === 'timeline' ? (
              <Timeline
                clips={state.playback.clips}
                current={state.playback.clip}
                playing={state.playback.playing}
                time={state.playback.time}
                speed={state.playback.speed}
                onClip={(name) => dispatch({ type: 'clip', name })}
                onPlaying={(playing) => dispatch({ type: 'playing', playing })}
                onTime={(time) => dispatch({ type: 'time', time })}
                onSpeed={(speed) => dispatch({ type: 'speed', speed })}
              />
            ) : (
              <BuildsPanel />
            )}
          </div>
        </section>
      )}

      <footer className="status-bar">
        <output>{state.status}</output>
        <span className="status-meta">
          {state.doc.spec ? 'spec' : 'recipe'} · {state.doc.origin} · Y up · metres
        </span>
      </footer>

      <input
        ref={picker}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void openFile(file);
        }}
      />

      <Dialog
        open={state.modal === 'url'}
        onOpenChange={(open) => !open && dispatch({ type: 'modal', modal: null })}
      >
        <DialogContent className="studio-dialog">
          <DialogHeader>
            <DialogTitle className="dialog-title">Open a URL</DialogTitle>
          </DialogHeader>
          <label className="dialog-field">
            <span>Spec or recipe JSON</span>
            <input
              className="dialog-input"
              value={url}
              spellCheck={false}
              placeholder="specs/wizard.spec.json"
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </label>
          <div className="dialog-actions">
            <button
              className="bar-button primary"
              disabled={!url.trim()}
              onClick={async () => {
                const where = url.trim();
                dispatch({ type: 'modal', modal: null });
                try {
                  const response = await fetch(where, { cache: 'no-store' });
                  if (!response.ok) throw Error(`${response.status} from ${where}`);
                  docOps.load(await response.json(), 'import', 'Opened %s.');
                } catch (error) {
                  docOps.status(
                    error instanceof Error
                      ? error.message
                      : 'That URL could not be read.',
                  );
                }
              }}
            >
              Open
            </button>
            <button
              className="bar-button"
              onClick={() => dispatch({ type: 'modal', modal: null })}
            >
              Cancel
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <BlueprintDialog />
      <ShortcutsDialog />
      <CommandPalette context={context} />
      {dropping && (
        <div className="drop-veil" role="status">
          Drop a spec or recipe JSON to open it
        </div>
      )}
    </main>
  );
}
