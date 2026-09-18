/**
 * One keyboard handler, reading the action table.
 *
 * Three things already answer keys in this app — the 3D canvas, the outliner's
 * tree, and now the window — and the only way that stays sane is a strict order
 * of precedence rather than three handlers each hoping to be first:
 *
 * 1. A handler that has already acted marks the event handled, and this one
 *    stands back. The outliner does exactly that for Delete and ⌘D.
 * 2. Anything typed into a field belongs to the field.
 * 3. Keys the canvas owns are the canvas's while the canvas has focus, so one
 *    press is one action rather than two.
 * 4. Everything else falls to the table.
 */
import { COMMANDS, type ActionContext, type StudioCommand } from './actions';
import type { StudioState } from './reducer';

/** The shape of a keyboard event this module needs, so tests can fake one. */
export type Chordable = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

/**
 * A canonical name for one chord.
 *
 * `Mod` rather than Cmd or Ctrl, because the same binding has to read right on
 * both platforms and nothing in here cares which one was pressed. Single
 * characters are upper-cased so `z` and `Z` — the same key with shift reported
 * two different ways — never produce two different chords.
 */
export function chordOf(event: Chordable): string {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('Mod');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return parts.join('+');
}

/** How a chord is drawn in a menu or the palette. */
export function chordLabel(chord: string, apple = true): string {
  return chord
    .split('+')
    .map((part) => {
      if (part === 'Mod') return apple ? '⌘' : 'Ctrl';
      if (part === 'Shift') return '⇧';
      if (part === 'Alt') return apple ? '⌥' : 'Alt';
      if (part === ' ') return 'Space';
      if (part === 'Escape') return 'Esc';
      if (part === 'Delete') return 'Del';
      if (part === 'Backspace') return '⌫';
      return part;
    })
    .join(apple ? '' : '+');
}

function typing(target: unknown): boolean {
  if (typeof HTMLElement === 'undefined') return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/**
 * Controls that answer Space or Escape themselves.
 *
 * A focused button, switch, tab or menu item is activated by Space, and an
 * open menu or dialog is closed by Escape. Those presses belong to the control
 * that has focus — swallowing them here would leave "Single polygon mesh"
 * un-toggleable from the keyboard and make Escape in an open menu also clear
 * the selection behind it.
 */
const ACTIVATES =
  'button,a[href],summary,[role="button"],[role="switch"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"]';
const DISMISSES = '[role="menu"],[role="dialog"],[role="listbox"],[data-slot="command"]';

function ownedByControl(chord: string, target: unknown): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  if (chord === ' ') return Boolean(target.closest(ACTIVATES));
  if (chord === 'Escape') return Boolean(target.closest(DISMISSES));
  return false;
}

function onCanvas(target: unknown): boolean {
  return typeof HTMLCanvasElement !== 'undefined' &&
    target instanceof HTMLCanvasElement;
}

/**
 * The command a key press should run here, or null to leave it alone.
 *
 * Separate from `handleKey` so the rules can be asserted directly.
 */
export function commandFor(
  chord: string,
  state: StudioState,
  options: { canvasFocused?: boolean } = {},
  commands: StudioCommand[] = COMMANDS,
): StudioCommand | null {
  for (const command of commands) {
    if (!command.keys?.includes(chord)) continue;
    if (options.canvasFocused && command.canvasOwned) continue;
    if (!command.enabled(state)) continue;
    return command;
  }
  return null;
}

/** Wire this to `window`'s keydown. Returns true when it consumed the event. */
export function handleKey(
  event: KeyboardEvent,
  context: ActionContext,
  commands: StudioCommand[] = COMMANDS,
): boolean {
  if (event.defaultPrevented || typing(event.target)) return false;
  const chord = chordOf(event);
  if (ownedByControl(chord, event.target)) return false;
  const command = commandFor(
    chord,
    context.state,
    { canvasFocused: onCanvas(event.target) },
    commands,
  );
  if (!command) return false;
  event.preventDefault();
  command.run(context);
  return true;
}

/**
 * Chords claimed by more than one command that could both fire.
 *
 * Two commands may share a chord only when they can never be enabled together
 * or when one is canvas-owned and the other is not — anything else is a press
 * whose outcome depends on table order, which is a bug waiting for a user.
 */
export function keyConflicts(
  state: StudioState,
  commands: StudioCommand[] = COMMANDS,
): { chord: string; ids: string[] }[] {
  const claims = new Map<string, string[]>();
  for (const command of commands) {
    if (!command.enabled(state)) continue;
    for (const chord of command.keys ?? []) {
      // Canvas-owned and window-scoped commands live in different contexts:
      // the same chord in each is answered by exactly one of them.
      const scope = `${command.canvasOwned ? 'canvas' : 'window'}:${chord}`;
      claims.set(scope, [...(claims.get(scope) ?? []), command.id]);
    }
  }
  return [...claims]
    .filter(([, ids]) => ids.length > 1)
    .map(([scope, ids]) => ({ chord: scope, ids }));
}
