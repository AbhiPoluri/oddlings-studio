'use client';
import { useEffect, useState, type ReactNode } from 'react';

/**
 * What the studio shows while it is not yet showing anything.
 *
 * Three rules, all of them about not lying and not flashing.
 *
 * It names the actual step. "Loading…" over a blank rectangle tells a person
 * nothing they could act on; "loading the decimator" and "building Wizard" at
 * least say which part is slow, and this studio's slow part is genuinely worth
 * naming — the decimator is a WebAssembly download and the first surface build
 * is a second of real work.
 *
 * It covers only the cell whose data is missing. The top bar, the outliner and
 * the property panel are all usable while the first model is still in the
 * worker, so a full-screen curtain would take away more than it explains.
 *
 * And it waits before appearing. A cached reload of a faceted spec is ready in
 * well under a tenth of a second, and a panel that blinks on every one of
 * those reads as a fault rather than as progress.
 */

/** Below this, the wait is short enough that saying anything would flicker. */
export const BOOT_DELAY = 120;

/** Delay showing `children` until the wait has gone on long enough to matter. */
export function AfterAMoment({
  delay = BOOT_DELAY,
  children,
}: {
  delay?: number;
  children: ReactNode;
}) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShow(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);
  return show ? <>{children}</> : null;
}

/**
 * The start-up placeholder for the viewport cell.
 *
 * `step` is the sentence: whatever the studio is actually waiting on right
 * now. The progress line is indeterminate on purpose — none of these steps can
 * honestly report a fraction, and a bar that fakes one is worse than a bar that
 * admits it is just moving.
 */
export function BootScreen({ step }: { step: string }) {
  return (
    <AfterAMoment>
      <output className="boot" aria-live="polite">
        <div className="boot-mark" aria-hidden>
          ◇
        </div>
        <p className="boot-step">{step}</p>
        <div className="boot-bar" aria-hidden>
          <span />
        </div>
      </output>
    </AfterAMoment>
  );
}

/**
 * A row of grey blocks standing in for a list that has not arrived.
 *
 * Deliberately the same height and rhythm as the rows it replaces, so the
 * panel does not jump when the real ones land.
 */
export function RowSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <AfterAMoment>
      <ul className="skeleton-rows" aria-hidden>
        {Array.from({ length: rows }, (_, at) => (
          <li key={at} className="skeleton-row" />
        ))}
      </ul>
    </AfterAMoment>
  );
}
