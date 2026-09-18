'use client';
/**
 * The one place the studio's state lives.
 *
 * A context rather than props because almost every panel reads three or four
 * unrelated slices — the outliner wants the spec, the selection, the hover and
 * the diff — and threading those through a five-deep layout is how a shell ends
 * up with a component that exists only to pass things down.
 *
 * `ref` is handed out alongside `state` on purpose: the follow poll and the key
 * handler run from effects registered once, and a closure over `state` would
 * pin them to the render that created them. They read `ref.current` instead.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { parseRecipe } from '@/lib/asset-recipe';
import {
  DEFAULT_LAYOUT,
  initialState,
  reducer,
  type Layout,
  type Saved,
  type StudioAction,
  type StudioState,
} from './reducer';

export const LAYOUT_KEY = 'oddlings-studio-layout-v2';
export const LIBRARY_KEY = 'oddlings-studio-library-v1';

type Store = {
  state: StudioState;
  dispatch: (action: StudioAction) => void;
  /** Always the newest state, for effects that outlive a render. */
  ref: RefObject<StudioState>;
};

const StudioContext = createContext<Store | null>(null);

/** Read whatever the last session left, clamped by the reducer on the way in. */
function storedLayout(): Partial<Layout> | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<Layout>;
    const out: Partial<Layout> = {};
    for (const key of ['left', 'right', 'dock'] as const)
      if (typeof saved[key] === 'number' && Number.isFinite(saved[key]))
        out[key] = saved[key];
    for (const key of ['leftOpen', 'rightOpen', 'dockOpen'] as const)
      if (typeof saved[key] === 'boolean') out[key] = saved[key];
    // An object with nothing usable in it is not a stored layout. Returning the
    // empty object would be truthy, and the width default below would never run
    // again for anyone whose storage had ever been written by an older build.
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

function storedLibrary(): Saved[] {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) return [];
    const saved: unknown = JSON.parse(raw);
    if (!Array.isArray(saved)) return [];
    return saved.slice(0, 40).map((entry: Saved) => ({
      id: String(entry.id),
      recipe: parseRecipe(entry.recipe),
      thumbnail:
        typeof entry.thumbnail === 'string' &&
        entry.thumbnail.startsWith('data:image/png;base64,')
          ? entry.thumbnail
          : '',
    }));
  } catch {
    return [];
  }
}

export function StudioProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const ref = useRef(state);
  ref.current = state;

  // Restored in an effect rather than in the initialiser: this component is
  // rendered on the server too, and a layout read from a browser that is not
  // there yet would hydrate into a mismatch.
  useEffect(() => {
    const layout = storedLayout();
    // A narrow pane cannot show three columns and a viewport worth looking at,
    // so the tree steps aside until someone asks for it — on a first visit
    // only. Once someone has sized or collapsed a column themselves, that is
    // the answer at every width.
    dispatch({
      type: 'layout',
      patch: layout ?? { leftOpen: window.innerWidth >= 900 },
    });
    const library = storedLibrary();
    if (library.length) dispatch({ type: 'library', items: library });
  }, []);

  // Written back on every change, which is cheap: this is six numbers.
  const layout = state.layout;
  useEffect(() => {
    // The very first flush runs before the restore above has landed, holding
    // the defaults object itself. Writing that would persist a layout nobody
    // chose — and a persisted layout is exactly what suppresses the width
    // default on the next visit, so the narrow-screen default would work once
    // and never again. Identity is the check because only the reducer builds a
    // new layout object, and it only does so for a real change.
    if (layout === DEFAULT_LAYOUT) return;
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // A browser with storage switched off still gets a working studio.
    }
  }, [layout]);

  const store = useMemo<Store>(() => ({ state, dispatch, ref }), [state]);
  return (
    <StudioContext.Provider value={store}>{children}</StudioContext.Provider>
  );
}

export function useStudio(): Store {
  const store = useContext(StudioContext);
  if (!store) throw Error('useStudio must be used inside <StudioProvider>.');
  return store;
}

/** Persist the library, reporting failure rather than losing it silently. */
export function persistLibrary(items: Saved[]): boolean {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(items));
    return true;
  } catch {
    return false;
  }
}
