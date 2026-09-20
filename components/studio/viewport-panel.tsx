'use client';
/**
 * The centre column: a thin strip of camera and overlay controls, and the
 * viewport filling everything under it.
 *
 * The gizmo's Move/Rotate/Scale control is deliberately not in this strip.
 * `AssetViewport` keeps the mode in its own state with no prop to set it, and
 * it is the only place that knows a bone cannot be rotated or scaled — so the
 * control stays where the viewport draws it, over the canvas, and the strip
 * does not pretend to own something it cannot read.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type * as T from 'three';
import { ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { filterCount } from './filters';
import { FiltersPanel } from './filters-panel';
import {
  AssetViewport,
  type AssetStats,
  type ViewHandle,
  type ViewName,
} from '@/components/asset-viewport';
import type { AssetSpec } from '@/lib/asset-spec';
import { runCommand, type ActionContext } from './actions';
import { clockAt, setClock } from './clock';
import { BootScreen } from './loading';
import { EmptyState } from './empty-state';
import type { Overlays } from './reducer';
import { useStudio } from './store';
import { useDocument } from './use-document';
import { DrawOverlay } from './draw-overlay';
import { drawnMarks, markNote, noteId } from './notes';
import type { Notes } from './use-notes';

const VIEWS: { id: string; label: string; which: ViewName; key: string }[] = [
  { id: 'view.persp', label: 'Perspective', which: 'persp', key: '5' },
  { id: 'view.front', label: 'Front', which: 'front', key: '1' },
  { id: 'view.back', label: 'Back', which: 'back', key: '⌘1' },
  { id: 'view.right', label: 'Right', which: 'right', key: '3' },
  { id: 'view.left', label: 'Left', which: 'left', key: '⌘3' },
  { id: 'view.top', label: 'Top', which: 'top', key: '7' },
  { id: 'view.bottom', label: 'Bottom', which: 'bottom', key: '⌘7' },
];

const OVERLAYS: { key: keyof Overlays; id: string; label: string }[] = [
  { key: 'wireframe', id: 'toggle.wireframe', label: 'Wire' },
  { key: 'grid', id: 'toggle.grid', label: 'Grid' },
  { key: 'skeleton', id: 'toggle.skeleton', label: 'Bones' },
  { key: 'rotate', id: 'toggle.rotate', label: 'Spin' },
];

export function ViewportPanel({
  view,
  context,
  ghost,
  notes,
  onModel,
}: {
  view: RefObject<ViewHandle | null>;
  context: ActionContext;
  /** The previous agent build, drawn through when Compare is on. */
  ghost?: AssetSpec | null;
  /**
   * The review notes for the file on screen.
   *
   * Passed down rather than read here with a second `useNotes()`: two copies
   * of that hook would be two lists autosaving over each other, and the marks
   * the viewport draws have to be the same list the Notes panel shows.
   */
  notes: Notes;
  /**
   * The model the viewport just built, passed up for the shell to audit.
   *
   * Null while a build is in flight. The shell used to build its own copy of
   * every spec for the findings panel, which meant every edit was built twice
   * on the main thread; this is the same model, lent rather than duplicated.
   */
  onModel: (model: T.Object3D | null) => void;
}) {
  const { state, dispatch } = useStudio();
  const { transformPart, moveBoneTo, removeSelected, duplicateSelected } =
    useDocument();
  const [stats, setStats] = useState<AssetStats | null>(null);
  const reported = useRef<{ doc: unknown; tris: number } | null>(null);

  // The build log wants the triangle count of what actually rendered, which
  // only the viewport knows. Reported once per document rather than once per
  // frame — and keyed on the document, because two builds in a row can very
  // well have the same triangle count and the second still needs its row.
  const triangles = stats?.triangles ?? null;
  const doc = state.doc;
  useEffect(() => {
    if (triangles === null) return;
    if (reported.current?.doc === doc && reported.current.tris === triangles)
      return;
    reported.current = { doc, tris: triangles };
    dispatch({ type: 'buildStats', tris: triangles });
  }, [triangles, doc, dispatch]);

  const spec = state.doc.spec;
  /** How many filters are actually drawing, for the toolbar's badge. */
  const filters = filterCount(state.filters);

  /**
   * The open notes that were drawn, as lines for the viewport.
   *
   * Memoised on the list rather than rebuilt every render, because the
   * viewport's side of this disposes and re-creates every line whenever the
   * array's identity changes — which would be every frame of a gizmo drag.
   */
  const marks = useMemo(() => drawnMarks(notes.notes), [notes.notes]);

  /**
   * Park the playhead in the store when a clip stops.
   *
   * While a clip runs the live time lives in `clock.ts` and never reaches the
   * store, which is what keeps the shell from committing ten times a second.
   * The store's own `playback.time` is the seek the viewport obeys once it is
   * paused — so on the way from playing to paused, one dispatch hands the live
   * reading over and the model stays exactly where it stopped.
   */
  /**
   * The start-up line, or null once a model has been drawn.
   *
   * Assembled here rather than dispatched step by step, because every input is
   * already in the store: what the decimator is doing, what the follow poll is
   * doing, and whether a build is in flight. A reducer case per step would be
   * three more actions saying what three booleans already say.
   */
  const step = !state.loading.booted
    ? state.loading.build
      ? `building ${state.doc.spec?.name ?? 'the asset'}…`
      : !state.surfaceReady && state.doc.spec?.surface
        ? 'loading the decimator…'
        : state.doc.spec || state.doc.origin !== 'agent'
          ? 'starting the build worker…'
          : state.follow.status === 'waiting'
            ? 'reading .oddlings/active.json…'
            : state.follow.status === 'off'
              ? null
              : 'waiting for a build…'
    : null;
  // Through the store rather than straight into the markup, so what start-up
  // is waiting on is state anything can read and `tests/studio.test.ts` can
  // assert on — and so the "booted once, booted for good" rule lives in one
  // place instead of in a condition here.
  useEffect(() => {
    dispatch({ type: 'bootStep', step });
  }, [step, dispatch]);
  const boot = state.loading.boot;

  const playing = state.playback.playing;
  const wasPlaying = useRef(playing);
  useEffect(() => {
    if (wasPlaying.current && !playing)
      dispatch({ type: 'time', time: clockAt() });
    wasPlaying.current = playing;
  }, [playing, dispatch]);

  return (
    <section className="viewport-column" aria-label="Viewport">
      <div className="view-bar">
        <DropdownMenu>
          <DropdownMenuTrigger className="bar-button">
            View <ChevronDown size={12} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="studio-menu">
            {VIEWS.map((option) => (
              <DropdownMenuItem
                key={option.id}
                onClick={() => runCommand(option.id, context)}
              >
                {option.label}
                <span className="menu-key">{option.key}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          className="bar-button"
          disabled={!state.selection}
          title="Frame selected (F)"
          onClick={() => runCommand('view.frameSelected', context)}
        >
          Frame
        </button>
        <button
          className="bar-button"
          title="Frame all (Home)"
          onClick={() => runCommand('view.frameAll', context)}
        >
          Frame all
        </button>
        {/* Not routed through `runCommand`: the table's `tool.draw` is a
            toggle, which is the right thing for a key and the wrong thing for
            a pair of buttons that say which mode you are in. */}
        <div className="segmented tool-bar" role="group" aria-label="Tool">
          <button
            type="button"
            aria-pressed={state.tool === 'select'}
            title="Select and orbit"
            onClick={() => dispatch({ type: 'tool', tool: 'select' })}
          >
            Select
          </button>
          <button
            type="button"
            aria-pressed={state.tool === 'draw'}
            disabled={!spec}
            title="Draw a review mark (D)"
            onClick={() => dispatch({ type: 'tool', tool: 'draw' })}
          >
            Draw
          </button>
        </div>
        {/* Five toggles and a six-column statistics table do not fit beside a
            camera menu on a narrow screen. Both are rendered and the stylesheet
            picks one, so the swap costs no measuring, no resize listener and no
            first paint at the wrong width. */}
        <div className="segmented overlay-bar" role="group" aria-label="Overlays">
          {OVERLAYS.map((overlay) => (
            <button
              key={overlay.key}
              type="button"
              aria-pressed={state.overlays[overlay.key]}
              onClick={() => runCommand(overlay.id, context)}
            >
              {overlay.label}
            </button>
          ))}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger className="bar-button overlay-menu">
            Overlays <ChevronDown size={12} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="studio-menu">
            {OVERLAYS.map((overlay) => (
              <DropdownMenuItem
                key={overlay.key}
                onClick={() => runCommand(overlay.id, context)}
              >
                {state.overlays[overlay.key] ? '✓' : '  '} {overlay.label}
              </DropdownMenuItem>
            ))}
            {/* The stack's master switch, so the narrow layout can reach what
                `P` reaches even with the popover's trigger crowded out. The
                parameters stay in the popover. */}
            <DropdownMenuItem
              onClick={() => runCommand('toggle.filters', context)}
            >
              {state.filters.on ? '✓' : '  '} Filters
              {filters > 0 ? ` (${filters})` : ''}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Outside the segmented group on purpose: that group is hidden at
            narrow widths in favour of the dropdown above, and a popover the
            layout can hide is a panel with no way into it. */}
        <Popover>
          <PopoverTrigger
            className="bar-button filters-button"
            title="Viewport filters (P)"
            data-on={filters > 0 ? '' : undefined}
          >
            Filters
            {filters > 0 && <span className="filters-badge">{filters}</span>}
            <ChevronDown size={12} />
          </PopoverTrigger>
          <PopoverContent align="start" className="filters-popover">
            <FiltersPanel />
          </PopoverContent>
        </Popover>
        <dl className="stats" aria-label="Asset statistics">
          <div>
            <dt>tris</dt>
            <dd>{stats?.triangles.toLocaleString() ?? '—'}</dd>
          </div>
          <div>
            <dt>mesh</dt>
            <dd>{stats?.meshes ?? '—'}</dd>
          </div>
          <div>
            <dt>mat</dt>
            <dd>{stats?.materials ?? '—'}</dd>
          </div>
          <div>
            <dt>bone</dt>
            <dd>{stats?.bones ?? '—'}</dd>
          </div>
          <div>
            <dt>fps</dt>
            <dd>{stats?.fps ?? '—'}</dd>
          </div>
          <div>
            <dt>size</dt>
            <dd>{stats?.size.map((n) => n.toFixed(2)).join('×') ?? '—'}</dd>
          </div>
        </dl>
      </div>
      <div className="viewport-host">
        {/* Nothing followed and nothing loaded: the stage would otherwise be
            an empty grey box, which reads as broken rather than as waiting. */}
        {!spec && state.follow.status === 'gaveup' && (
          <EmptyState context={context} />
        )}
        <AssetViewport
          ref={view}
          // Supplying `isolate` takes the state over from the viewport, so
          // `onIsolate` has to come with it or `/` on the canvas would flip
          // nothing. The viewport hands over the value it wants, already
          // resolved, which is what the reducer's toggle reads.
          isolate={state.isolate}
          onIsolate={(selection) => dispatch({ type: 'isolate', selection })}
          recipe={state.doc.recipe}
          spec={spec}
          selected={state.selection}
          hover={state.hover}
          onSelect={(selection) => dispatch({ type: 'select', selection })}
          onHover={(selection) => dispatch({ type: 'hover', selection })}
          onTransform={transformPart}
          onMoveBone={moveBoneTo}
          onDelete={removeSelected}
          onDuplicate={duplicateSelected}
          filters={state.filters}
          wireframe={state.overlays.wireframe}
          grid={state.overlays.grid}
          rotate={state.overlays.rotate}
          skeleton={state.overlays.skeleton}
          // Held behind the toggle rather than passed always: building a second
          // model costs what building the first one did, and nobody who is not
          // comparing should pay it.
          ghost={state.overlays.compare ? (ghost ?? null) : null}
          ghostWire={state.overlays.wireframe}
          animation={state.playback.clip}
          speed={state.playback.speed}
          playing={state.playback.playing}
          time={state.playback.time}
          onTime={setClock}
          onClips={(clips) => dispatch({ type: 'clips', clips })}
          onPlayToggle={() =>
            dispatch({ type: 'playing', playing: !state.playback.playing })
          }
          marks={marks}
          onMarkPick={(id) => {
            const note = notes.notes.find((row) => row.id === id);
            if (!note) return;
            const path = note.mark?.parts[0]?.path ?? note.part;
            if (path) dispatch({ type: 'select', selection: { kind: 'part', path } });
            dispatch({ type: 'rightTab', tab: 'notes' });
          }}
          onStats={setStats}
          lastEdit={state.lastEdit}
          onModel={onModel}
          onBuild={(event) =>
            dispatch(
              'done' in event
                ? { type: 'built', id: event.id }
                : { type: 'building', id: event.id, since: event.since },
            )
          }
        />
        <DrawOverlay
          active={state.tool === 'draw' && Boolean(spec)}
          resolve={(points) => view.current?.resolveStroke(points) ?? null}
          onMark={(mark, label) => {
            notes.add(
              markNote({
                id: noteId(),
                mark,
                text: label,
                at: new Date().toISOString(),
              }),
            );
            dispatch({ type: 'rightTab', tab: 'notes' });
          }}
          onExit={() => dispatch({ type: 'tool', tool: 'select' })}
        />
        {boot && <BootScreen step={boot} />}
      </div>
    </section>
  );
}
