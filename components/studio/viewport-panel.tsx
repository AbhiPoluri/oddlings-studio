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
import { useEffect, useRef, useState, type RefObject } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AssetViewport,
  type AssetStats,
  type ViewHandle,
  type ViewName,
} from '@/components/asset-viewport';
import { runCommand, type ActionContext } from './actions';
import type { Overlays } from './reducer';
import { useStudio } from './store';
import { useDocument } from './use-document';

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
  { key: 'pixel', id: 'toggle.pixel', label: 'Pixel' },
  { key: 'rotate', id: 'toggle.rotate', label: 'Spin' },
];

export function ViewportPanel({
  view,
  context,
}: {
  view: RefObject<ViewHandle | null>;
  context: ActionContext;
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
  // A surface spec re-meshes through a WebAssembly decimator; building one
  // before it has loaded throws. The viewport guards too, but the audit in the
  // shell reads the same document, so the gate belongs above both.
  const ready = !spec?.surface || state.surfaceReady;

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
          </DropdownMenuContent>
        </DropdownMenu>
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
        <AssetViewport
          ref={view}
          // Supplying `isolate` takes the state over from the viewport, so
          // `onIsolate` has to come with it or `/` on the canvas would flip
          // nothing. The viewport hands over the value it wants, already
          // resolved, which is what the reducer's toggle reads.
          isolate={state.isolate}
          onIsolate={(selection) => dispatch({ type: 'isolate', selection })}
          recipe={state.doc.recipe}
          spec={ready ? spec : null}
          selected={state.selection}
          hover={state.hover}
          onSelect={(selection) => dispatch({ type: 'select', selection })}
          onHover={(selection) => dispatch({ type: 'hover', selection })}
          onTransform={transformPart}
          onMoveBone={moveBoneTo}
          onDelete={removeSelected}
          onDuplicate={duplicateSelected}
          pixel={state.overlays.pixel}
          wireframe={state.overlays.wireframe}
          grid={state.overlays.grid}
          rotate={state.overlays.rotate}
          skeleton={state.overlays.skeleton}
          animation={state.playback.clip}
          speed={state.playback.speed}
          playing={state.playback.playing}
          time={state.playback.time}
          onTime={(time) => dispatch({ type: 'time', time })}
          onClips={(clips) => dispatch({ type: 'clips', clips })}
          onPlayToggle={() =>
            dispatch({ type: 'playing', playing: !state.playback.playing })
          }
          onStats={setStats}
        />
      </div>
    </section>
  );
}
