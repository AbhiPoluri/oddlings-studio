'use client';
/**
 * The surface a reviewer draws on.
 *
 * A sheet over the WebGL canvas rather than listeners on it, because drawing
 * and orbiting want the same gesture — press, drag, release — and there is no
 * honest way to share it. While the Draw tool is on, this sheet takes every
 * pointer event and the camera does not move; while it is off it is inert and
 * the viewport behaves exactly as it always has. That is also why the tool is
 * a mode with a key rather than a modifier: a mode is visible, and a modifier
 * held wrong is a camera that will not turn for no reason anyone can see.
 *
 * The stroke in progress is drawn here, in 2D, because that is what it is: a
 * line on the screen the reviewer has not finished making. The moment they let
 * go it is resolved into the world and handed to the viewport, which draws it
 * as geometry from then on — so the wet ink and the dry ink are different
 * things drawn by different code, and the changeover is the release.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { describeMark, type Mark, type Point2 } from '@/lib/draw-marks';

/** What each gesture is called where the reviewer can see it. */
const GESTURE_LABEL: Record<Mark['gesture'], string> = {
  circle: 'circled',
  remove: 'crossed out',
  arrow: 'pointing at',
  sketch: 'sketched',
};

export function DrawOverlay({
  active,
  resolve,
  onMark,
  onExit,
}: {
  active: boolean;
  /** Resolve a finished stroke against the model, in overlay-local pixels. */
  resolve: (points: Point2[]) => Mark | null;
  /** A finished, labelled mark. An empty label is the mark's own description. */
  onMark: (mark: Mark, label: string) => void;
  /** Leave the tool: Escape with nothing in progress. */
  onExit: () => void;
}) {
  const surface = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  /** The stroke being drawn, or null between strokes. */
  const [stroke, setStroke] = useState<Point2[] | null>(null);
  /** A finished stroke waiting for its label. */
  const [pending, setPending] = useState<{ mark: Mark; at: Point2 } | null>(
    null,
  );
  const [label, setLabel] = useState('');

  // Leaving the tool with a half-written label must not leave the label behind
  // to reappear over the next stroke someone draws.
  useEffect(() => {
    if (active) return;
    setStroke(null);
    setPending(null);
    setLabel('');
  }, [active]);

  useEffect(() => {
    if (pending) input.current?.focus();
  }, [pending]);

  const local = (event: { clientX: number; clientY: number }): Point2 => {
    const rect = surface.current?.getBoundingClientRect();
    return {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    };
  };

  const accept = useCallback(() => {
    if (!pending) return;
    onMark(pending.mark, label);
    setPending(null);
    setLabel('');
    setStroke(null);
  }, [pending, label, onMark]);

  const cancel = useCallback(() => {
    setPending(null);
    setLabel('');
    setStroke(null);
  }, []);

  if (!active) return null;

  return (
    <div
      ref={surface}
      className="draw-surface"
      aria-label="Draw on the model"
      tabIndex={0}
      data-pending={pending ? '' : undefined}
      onPointerDown={(event) => {
        // A press while the prompt is up is the reviewer moving on: take the
        // label as it stands rather than throwing away the stroke they drew.
        if (pending) accept();
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        surface.current?.focus({ preventScroll: true });
        setStroke([local(event)]);
      }}
      onPointerMove={(event) => {
        setStroke((points) => (points ? [...points, local(event)] : points));
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        const points = stroke ? [...stroke, local(event)] : null;
        setStroke(points);
        if (!points) return;
        const mark = resolve(points);
        // Not a gesture — a click that drifted, or a stroke drawn before the
        // model finished building. Silently dropped: the alternative is an
        // error message for having clicked.
        if (!mark) return setStroke(null);
        setPending({ mark, at: points[points.length - 1] });
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        // Outermost first, the way the viewport's own Escape works: the stroke
        // in hand, then the tool. Marked handled either way so the window's
        // handler does not also clear the selection behind it.
        event.preventDefault();
        event.stopPropagation();
        if (pending || stroke) cancel();
        else onExit();
      }}
    >
      <svg className="draw-ink" aria-hidden="true">
        {stroke && stroke.length > 1 && (
          <polyline points={stroke.map((p) => `${p.x},${p.y}`).join(' ')} />
        )}
      </svg>
      <p className="draw-hint">
        Circle a part, cross one out, point an arrow at one, or sketch a new
        shape beside it. Esc to stop drawing.
      </p>
      {pending && (
        <form
          className="draw-prompt"
          style={{ left: `${pending.at.x}px`, top: `${pending.at.y}px` }}
          onSubmit={(event) => {
            event.preventDefault();
            accept();
          }}
        >
          <span className="draw-prompt-what">
            {GESTURE_LABEL[pending.mark.gesture]}
            {pending.mark.parts.length
              ? ` ${pending.mark.parts.map((part) => part.name ?? part.path.join('.')).join(', ')}`
              : ''}
          </span>
          <input
            ref={input}
            className="draw-prompt-input"
            value={label}
            spellCheck={false}
            placeholder="what should the agent do here?"
            aria-label="What should the agent do here?"
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              cancel();
            }}
          />
          <button type="submit" className="bar-button primary">
            Add
          </button>
          {/* What the note will say when nothing is typed, so an empty Enter is
              a choice rather than a surprise. */}
          <span className="draw-prompt-fallback help">
            {label.trim() ? '' : describeMark(pending.mark)}
          </span>
        </form>
      )}
    </div>
  );
}
