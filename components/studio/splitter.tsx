'use client';
/**
 * A draggable edge between two panes.
 *
 * Pointer capture rather than window listeners: the pointer leaves the 4px
 * strip on the first frame of any real drag, and capture is what keeps the
 * events coming to the element that started it — including over the WebGL
 * canvas, which would otherwise swallow them into an orbit.
 *
 * It is a real `separator` with a value, so the panes can also be sized from
 * the keyboard; a splitter you can only drag is one a keyboard user cannot
 * reach at all.
 */
import { useRef } from 'react';

export function Splitter({
  orientation,
  value,
  min,
  max,
  label,
  /** True when dragging towards the origin should *grow* the pane. */
  invert = false,
  onResize,
  onReset,
}: {
  orientation: 'vertical' | 'horizontal';
  value: number;
  min: number;
  max: number;
  label: string;
  invert?: boolean;
  onResize: (size: number) => void;
  onReset: () => void;
}) {
  const start = useRef<{ at: number; size: number } | null>(null);
  const axis = orientation === 'vertical' ? 'clientX' : 'clientY';
  const sign = invert ? -1 : 1;

  function move(size: number) {
    onResize(Math.max(min, Math.min(max, Math.round(size))));
  }

  return (
    <div
      className="splitter"
      data-orientation={orientation}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { at: event[axis], size: value };
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        move(start.current.size + (event[axis] - start.current.at) * sign);
      }}
      onPointerUp={(event) => {
        start.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        start.current = null;
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 12;
        const back = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
        const on = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
        if (event.key === back) move(value - step * sign);
        else if (event.key === on) move(value + step * sign);
        else if (event.key === 'Enter' || event.key === ' ') onReset();
        else return;
        event.preventDefault();
      }}
    />
  );
}
