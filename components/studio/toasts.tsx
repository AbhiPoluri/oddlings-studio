'use client';
/**
 * Passing news, bottom right.
 *
 * The status line at the foot of the window says what the studio is doing now,
 * and it is overwritten by the next thing — which makes it the wrong place for
 * news that arrives while you are looking somewhere else. An agent finishing a
 * build in another file, a spec appearing in the folder, a save that failed:
 * all of them are worth a sentence, none of them are worth a dialog.
 *
 * So these never take focus and never block anything. They are announced to a
 * screen reader politely, they go by themselves, and the one button any of them
 * carries is the one that would otherwise be a path you had to type.
 */
import { useEffect } from 'react';
import { X } from 'lucide-react';
import type { ActionContext } from './actions';
import type { Toast } from './reducer';
import { useStudio } from './store';

/** How long a line stays. Bad news stays longer, because it may need reading. */
const LIFE: Record<Toast['tone'], number> = {
  info: 6000,
  good: 6000,
  bad: 11_000,
};

let counter = 0;

/** Unique for the life of the page, which is as long as a toast can live. */
export function toastId(): string {
  counter += 1;
  return `toast-${Date.now().toString(36)}-${counter}`;
}

/**
 * Say one thing.
 *
 * A hook rather than a bare dispatch so the id is minted in one place: the
 * reducer takes the id as an argument precisely so that it stays a pure
 * function, and that only works if nobody hand-rolls one.
 */
export function useToaster() {
  const { dispatch } = useStudio();
  return (
    text: string,
    options: { tone?: Toast['tone']; open?: string } = {},
  ) =>
    dispatch({
      type: 'toast',
      toast: {
        id: toastId(),
        text,
        tone: options.tone ?? 'info',
        open: options.open,
      },
    });
}

function Line({
  toast,
  context,
}: {
  toast: Toast;
  context: ActionContext;
}) {
  const { dispatch } = useStudio();
  useEffect(() => {
    const timer = setTimeout(
      () => dispatch({ type: 'untoast', id: toast.id }),
      LIFE[toast.tone],
    );
    return () => clearTimeout(timer);
  }, [dispatch, toast.id, toast.tone]);

  return (
    <div className="toast" data-tone={toast.tone}>
      <span className="toast-text">{toast.text}</span>
      {toast.open && (
        <button
          type="button"
          className="pill-button"
          onClick={() => {
            context.openSpec(toast.open!);
            dispatch({ type: 'untoast', id: toast.id });
          }}
        >
          Open
        </button>
      )}
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss"
        onClick={() => dispatch({ type: 'untoast', id: toast.id })}
      >
        <X size={11} aria-hidden="true" />
      </button>
    </div>
  );
}

export function Toasts({ context }: { context: ActionContext }) {
  const { state } = useStudio();
  if (!state.toasts.length) return null;
  return (
    // Polite, not assertive: none of this is worth interrupting a reader
    // mid-sentence, and `role="status"` is what says so.
    <div className="toasts" role="status" aria-live="polite">
      {state.toasts.map((toast) => (
        <Line key={toast.id} toast={toast} context={context} />
      ))}
    </div>
  );
}
