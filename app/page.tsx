'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Download,
  Shuffle,
  Undo2,
  Redo2,
  Save,
  Upload,
  Image as ImageIcon,
  Focus,
  ArrowUpRight,
  Layers,
  Plus,
  Trash2,
  RotateCcw,
  Mountain,
  Shapes,
  Braces,
  Dices,
  GitBranch,
  UserRound,
  TreePine,
} from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  AssetViewport,
  type ViewHandle,
  type AssetStats,
} from '@/components/asset-viewport';
import {
  initialRecipe,
  parseRecipe,
  fileName,
  type Recipe,
  type Kind,
} from '@/lib/asset-recipe';
import { disposeScene } from '@/lib/three-world';
import { registerStudioTools } from '@/lib/studio-tools';
import {
  download,
  exportAsset,
  exportSpecAsset,
} from '@/lib/asset-export';
import { parseSpec, buildSpec, type AssetSpec } from '@/lib/asset-spec';
import { readySurface } from '@/lib/asset-surface';
import { auditModel, type Audit } from '@/lib/asset-audit';
import {
  flatten,
  updatePart,
  deletePart,
  duplicatePart,
  moveBone,
  removeJoint,
  type PartPatch,
  type Selection,
  type Vec3,
} from '@/lib/spec-edit';
import { clipsOf } from '@/lib/asset-joints';
import type { Path } from '@/lib/spec-edit';
import { SpecEditor } from '@/components/spec-editor';
import {
  blueprints,
  generateBlueprint,
  mutateRecipe,
  defaultBlueprint,
  type Blueprint,
} from '@/lib/procedural-director';
type Saved = { id: string; recipe: Recipe; thumbnail: string };
/** One undoable state of the workbench: a generator recipe, optionally overlaid
 *  by an imported spec being previewed and edited. */
type Doc = { recipe: Recipe; spec: AssetSpec | null };
const initialDoc: Doc = { recipe: initialRecipe, spec: null };
const colors = [
  '#93cec8',
  '#c7a4b5',
  '#d2c385',
  '#a7aed2',
  '#d2ac87',
  '#b8c99a',
  '#b3c4de',
  '#d7ddd0',
];
const worldColors = [
  '#596c50',
  '#626c53',
  '#50675c',
  '#8d8172',
  '#68798b',
  '#867887',
];
const STORAGE = 'oddlings-studio-library-v1';
function Range({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (n: number) => void;
  onCommit: () => void;
}) {
  return (
    <div className="parameter">
      <div>
        <span>{label}</span>
        <output>{step < 1 ? value.toFixed(2) : value}</output>
      </div>
      <Slider
        aria-label={label}
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
        onValueCommitted={onCommit}
      />
    </div>
  );
}
function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <Switch checked={value} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}
export default function Studio() {
  const [doc, setDoc] = useState<Doc>(initialDoc);
  const recipe = doc.recipe;
  const spec = doc.spec;
  /**
   * What the panel and the viewport are both pointed at.
   *
   * One authored part or one bone, never both: a rig handle and a part are
   * different things to grab, and the part tree, the gizmo and the rig panel
   * each read the half they own off this rather than keeping a selection each.
   */
  const [selected, setSelected] = useState<Selection>(null);
  /**
   * The file the studio is mirroring, if any.
   *
   * With no URL parameter it follows `.oddlings/active.json`, which every
   * build and audit rewrites — so opening the studio shows whatever was made
   * last, and it keeps up as that changes. A `?spec=` parameter pins it to one
   * file instead. Following is one-way: the moment anyone edits in here, the
   * studio detaches rather than fighting the file for the same document.
   */
  type Target = { url: string; label: string; pinned: boolean };
  const [follow, setFollow] = useState<Target | null>(null);
  const [followedAt, setFollowedAt] = useState<string | null>(null);
  const [followedFile, setFollowedFile] = useState<string | null>(null);
  /**
   * `waiting` is not `off`. A fresh clone has no pointer yet, and saying
   * "not following" there would describe a choice nobody made.
   */
  const [link, setLink] = useState<'waiting' | 'live' | 'gaveup' | 'off'>(
    'waiting',
  );
  /** Bumped by "Check again", which re-runs the attach effect. */
  const [recheck, setRecheck] = useState(0);
  const linkRef = useRef<'waiting' | 'live' | 'gaveup' | 'off'>('waiting');
  const target = useRef<Target | null>(null);
  // Surface-mode specs re-mesh through a WebAssembly decimator. Loading it up
  // front — and re-running the audit once it lands — means the first spec a
  // user opens builds the same way every later one does.
  const [surfaceReady, setSurfaceReady] = useState(false);
  useEffect(() => {
    let live = true;
    readySurface().then(() => live && setSurfaceReady(true));
    return () => {
      live = false;
    };
  }, []);

  /**
   * Attach to a file on load, and mirror it while it changes.
   *
   * ETag rather than content: the dev server sends one for every static file,
   * so a poll that finds nothing new costs a request with no body. Nothing
   * here exists in a deployed build, so a miss is a quiet no-op and the studio
   * just behaves as it always did.
   */
  useEffect(() => {
    const asked = new URLSearchParams(location.search).get('spec');
    const safe = asked && /^[\w./-]+\.json$/.test(asked) && !asked.includes('..');
    const want: Target = safe
      ? { url: `/${asked.replace(/^\//, '')}`, label: asked, pinned: true }
      : { url: '/.oddlings/active.json', label: 'the latest build', pinned: false };
    // Survives a detach, so the bar can offer to re-follow the right thing.
    target.current = want;
    if (linkRef.current === 'gaveup') {
      linkRef.current = 'waiting';
      setLink('waiting');
    }

    let live = true;
    let tag: string | null = null;

    async function pull(first: boolean) {
      let response: Response;
      try {
        response = await fetch(want.url, { cache: 'no-store' });
      } catch {
        return;
      }
      if (!live || !response.ok) return;
      const next = response.headers.get('etag');
      if (!first && next && next === tag) return;
      tag = next;
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        return;
      }
      if (!live) return;
      // The pointer wraps the document; a `?spec=` file is the document.
      const pointer = parsed as { doc?: unknown; source?: string; at?: string };
      const doc = pointer && typeof pointer === 'object' && 'doc' in pointer
        ? pointer.doc
        : parsed;
      const where = want.pinned ? want.label : (pointer?.source ?? want.label);
      if (!first && linkRef.current !== 'live') return;
      // The first load records one history entry so undo can get back behind
      // it. Later ones never do: a build loop that saves ten times must not
      // bury the user's own history under ten identical steps.
      apply.current(
        doc,
        first
          ? `Following ${where} — %s. Edit anything here and the studio stops following.`
          : `${where} changed — reloaded %s.`,
        first,
      );
      // Attach only after that first commit lands, or commitDoc would read the
      // studio's own load as a user edit and detach on the spot.
      if (first) {
        // A user who edited while we were still waiting has taken the document;
        // a build landing now must not reach in and overwrite it.
        if (linkRef.current === 'off') return;
        setFollow(want);
        linkRef.current = 'live';
        setLink('live');
      }
      setFollowedAt(pointer?.at ?? new Date().toISOString());
      setFollowedFile(where);
    }

    void pull(true);
    // A missing pointer is a 404, which the browser logs however carefully we
    // catch it. Retry slowly, and give up rather than filling the console.
    let tries = 0;
    const first = setInterval(() => {
      if (linkRef.current !== 'waiting') return clearInterval(first);
      if (++tries > 48) {
        clearInterval(first);
        linkRef.current = 'gaveup';
        setLink('gaveup');
        return;
      }
      void pull(true);
    }, 2500);
    const timer = setInterval(
      () => linkRef.current === 'live' && void pull(false),
      1000,
    );
    return () => {
      live = false;
      clearInterval(timer);
      clearInterval(first);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recheck]);
  // Re-checked whenever the spec changes, so the panel always describes what
  // the viewport is showing rather than what was imported.
  const audit = useMemo<Audit | null>(() => {
    if (!spec) return null;
    try {
      const model = buildSpec(spec);
      const result = auditModel(model, {
        rigged: Boolean(spec.rig),
        scale: spec.scale,
        labels: new Map(
          flatten(spec).map((row) => [
            row.path.join('.'),
            row.part.name ?? row.part.shape,
          ]),
        ),
      });
      disposeScene(model);
      return result;
    } catch {
      return null;
    }
  }, [spec, surfaceReady]);
  // The clip picker used to list the humanoid five no matter what was loaded,
  // so a spec with its own joints exported clips nobody could play.
  const clips = useMemo(
    () => ['Bind pose', ...clipsOf(spec, recipe).map((c) => c.name)],
    [spec, recipe],
  );
  const animated = clips.length > 1;
  const bones = spec?.joints?.length ? spec.joints.length + 1 : 14;
  const [library, setLibrary] = useState<Saved[]>([]);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('Ready to make something strange.');
  const [pixel, setPixel] = useState(true);
  const [wire, setWire] = useState(false);
  const [grid, setGrid] = useState(true);
  const [rotate, setRotate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [metric, setMetric] = useState<AssetStats | null>(null);
  const [history, setHistory] = useState<Doc[]>([initialDoc]);
  const [cursor, setCursor] = useState(0);
  const view = useRef<ViewHandle>(null);
  const input = useRef<HTMLInputElement>(null);
  const current = useRef(recipe);
  current.current = recipe;
  const historyRef = useRef({ history, cursor });
  historyRef.current = { history, cursor };
  const [animation, setAnimation] = useState('Idle');
  const [skeleton, setSkeleton] = useState(false);
  const [speed, setSpeed] = useState(1);
  const removed = useRef<Saved | null>(null);
  const [canRestore, setCanRestore] = useState(false);
  const [blueprint, setBlueprint] = useState<Blueprint>('scout');
  const [mutation, setMutation] = useState(0.45);
  const activeBlueprint: Blueprint =
    blueprints[blueprint].kind === recipe.kind
      ? blueprint
      : defaultBlueprint[recipe.kind];
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE);
      if (raw) {
        const saved = JSON.parse(raw);
        if (!Array.isArray(saved)) throw Error();
        setLibrary(
          saved.slice(0, 40).map((s: Saved) => ({
            id: String(s.id),
            recipe: parseRecipe(s.recipe),
            thumbnail:
              typeof s.thumbnail === 'string' &&
              s.thumbnail.startsWith('data:image/png;base64,')
                ? s.thumbnail
                : '',
          })),
        );
      }
    } catch {
      setStatus(
        'Saved library could not be loaded. Import a recipe to recover an asset.',
      );
    }
    setReady(true);
  }, []);
  /**
   * Every undoable state — a recipe edit, loading a spec, tweaking a spec part
   * — is one document in one history, so undo walks back across the boundary
   * between the generators and an imported spec without stranding either.
   */
  function commitDoc(next: Doc) {
    const { history: h, cursor: c } = historyRef.current;
    // An edit means the user has taken over. Two writers on one document is a
    // conflict nobody asked for, so the file loses and the studio detaches.
    if (linkRef.current === 'live' && h.length) detach();
    if (JSON.stringify(h[c]) === JSON.stringify(next)) return;
    const updated = [...h.slice(0, c + 1), next].slice(-60);
    historyRef.current = { history: updated, cursor: updated.length - 1 };
    setHistory(updated);
    setCursor(updated.length - 1);
    current.current = next.recipe;
    setDoc(next);
  }
  function detach(message?: string) {
    if (linkRef.current === 'off') return;
    // Also leaves `waiting`: once this document has been edited, a build that
    // lands later must not reach in and overwrite it.
    linkRef.current = 'off';
    setLink('off');
    setFollow(null);
    if (message) setStatus(message);
  }
  /** Re-follow whatever this page was pointed at when it loaded. */
  function reattach() {
    if (target.current?.pinned) location.reload();
    else location.href = location.pathname;
  }
  function commit(next: Recipe = current.current) {
    commitDoc({ recipe: next, spec: null });
  }
  function change(p: Partial<Recipe>, record = true) {
    detach();
    const next = { ...current.current, ...p };
    current.current = next;
    setDoc({ recipe: next, spec: null });
    if (record) commitDoc({ recipe: next, spec: null });
  }
  /**
   * Take a parsed recipe or spec and put it on screen.
   *
   * Four things now feed the studio — a picked file, a `?spec=` URL, the
   * preview pointer, and that pointer changing under us — and they all have to
   * agree on what loading means, down to clearing the selection and picking an
   * animation. One function, four callers.
   */
  function loadPayload(parsed: unknown, note: string, record = true) {
    const isSpec =
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { parts?: unknown }).parts);
    if (isSpec) {
      const next = parseSpec(parsed);
      const document = { recipe: current.current, spec: next };
      if (record) commitDoc(document);
      else setDoc(document);
      setSelected(null);
      setAnimation(clipsOf(next).at(0)?.name ?? 'Bind pose');
      setStatus(note.replace('%s', next.name));
      return next.name;
    }
    const next = parseRecipe(parsed);
    current.current = next;
    if (record) commitDoc({ recipe: next, spec: null });
    else setDoc({ recipe: next, spec: null });
    setStatus(note.replace('%s', next.name));
    return next.name;
  }

  // The poll effect runs with empty deps and would otherwise close over the
  // first render's `loadPayload` forever. Today that is harmless — everything
  // it touches is a ref or a stable setter — but it would break silently the
  // day someone reads a `useState` value inside it. Keep the latest one here.
  const apply = useRef(loadPayload);
  apply.current = loadPayload;

  /** Live spec edits during a drag; only `record` pushes a history step. */
  function editSpec(next: AssetSpec, record = true) {
    // Detach before the first frame of a drag, not on release: a poll landing
    // mid-drag would otherwise reload the file over what is being dragged.
    detach();
    const document = { recipe: current.current, spec: next };
    if (record) commitDoc(document);
    else setDoc(document);
  }
  /**
   * One finished gizmo drag, as one undo step.
   *
   * The viewport never writes the spec while a drag is running — it moves a
   * proxy and hands the whole drag over as a single patch here, so a rebuild
   * of a thousand meshes and a history entry happen once per drag rather than
   * once per pointer move.
   */
  function transformPart(path: Path, patch: PartPatch) {
    if (!doc.spec) return;
    try {
      editSpec(updatePart(doc.spec, path, patch));
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : 'That edit is invalid.',
      );
    }
  }
  /**
   * One finished bone drag, as one undo step.
   *
   * `moveBone` sorts out which of the two rigs it is writing to — a joint's
   * `at` or an entry in `rig.bones` — so the viewport can hand back a position
   * without knowing what kind of skeleton it just dragged.
   */
  function moveBoneTo(name: string, at: Vec3) {
    if (!doc.spec) return;
    try {
      editSpec(moveBone(doc.spec, name, at));
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : 'That bone cannot be moved.',
      );
    }
  }
  /** Delete and duplicate are reachable from the panel and from the canvas. */
  function removeSelected() {
    if (!doc.spec || !selected) return;
    if (selected.kind === 'bone') {
      // The humanoid rig always has all 14 bones: there is no spec for a body
      // missing a shin, and the reset in the panel is what undoes an edit.
      if (doc.spec.rig)
        return setStatus(
          'A body rig always has its 14 bones. Reset the bone in the Rig panel to undo an override.',
        );
      const index =
        doc.spec.joints?.findIndex((joint) => joint.name === selected.name) ??
        -1;
      if (index < 0)
        return setStatus(
          'Root is the static bone a joints rig hangs off. It cannot be removed.',
        );
      try {
        editSpec(removeJoint(doc.spec, index));
        setSelected(null);
        setStatus(`Joint “${selected.name}” removed. Undo brings it back.`);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Cannot delete.');
      }
      return;
    }
    try {
      editSpec(deletePart(doc.spec, selected.path));
      setSelected(null);
      setStatus('Part removed. Undo brings it back.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Cannot delete.');
    }
  }
  function duplicateSelected() {
    if (!doc.spec || selected?.kind !== 'part') return;
    const result = duplicatePart(doc.spec, selected.path);
    editSpec(result.spec);
    setSelected({ kind: 'part', path: result.path });
    setStatus('Part duplicated.');
  }
  function undo(direction: number) {
    // Undo writes straight to `setDoc`, so without this the next poll would
    // quietly reload the file over the step the user just walked back to.
    detach();
    const { history: h, cursor: c } = historyRef.current;
    const next = Math.max(0, Math.min(h.length - 1, c + direction));
    historyRef.current = { history: h, cursor: next };
    setCursor(next);
    current.current = h[next].recipe;
    setDoc(h[next]);
    setStatus(direction < 0 ? 'Previous edit restored.' : 'Edit restored.');
  }
  function randomize() {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0] % 2147483647;
    const names =
      recipe.kind === 'creature'
        ? [
            'Mossling',
            'Wobble',
            'Tumble',
            'Nettle',
            'Pebble',
            'Bramble',
            'Mumble',
            'Sprig',
          ]
        : recipe.kind === 'person'
          ? ['Mira', 'Rowan', 'Tavi', 'Ash', 'Fern']
          : recipe.kind === 'prop'
            ? [
                'Module',
                'Construct',
                'Old Oak',
                'Moss Rock',
                'Glowcap',
                'Acorn Hut',
              ]
            : [
                'Fern Hollow',
                'Quiet Clearing',
                'Moon Garden',
                'Mossy Outpost',
                'Pebble Grove',
              ];
    change({
      seed,
      name: `${names[seed % names.length]} ${String(seed).slice(-3)}`,
    });
    setStatus('New seed. Your shape and palette settings are preserved.');
  }
  function switchKind(kind: Kind) {
    const selected = defaultBlueprint[kind];
    setBlueprint(selected);
    const next = generateBlueprint(selected, current.current.seed);
    current.current = next;
    commit(next);
    setStatus(`${kind[0].toUpperCase()}${kind.slice(1)} generator selected.`);
  }
  function persist(next: Saved[]) {
    try {
      localStorage.setItem(STORAGE, JSON.stringify(next));
      setLibrary(next);
      return true;
    } catch {
      setStatus(
        'Device storage is full. Download a recipe to keep this asset.',
      );
      return false;
    }
  }
  function save() {
    if (spec) {
      setStatus(
        'The library stores generator recipes. Download the spec JSON to keep this asset.',
      );
      return;
    }
    if (library.length >= 40) {
      setStatus(
        'Library limit reached. Download recipes or remove an older variation.',
      );
      return;
    }
    const savedRecipe = { ...current.current };
    let thumbnail = '';
    try {
      thumbnail = view.current?.capture() ?? '';
    } catch {}
    const add = (image: string) => {
      if (
        persist([
          {
            id: crypto.randomUUID(),
            recipe: savedRecipe,
            thumbnail: image,
          },
          ...library,
        ])
      )
        setStatus('Saved a new variation to this browser.');
    };
    if (thumbnail) {
      const img = new window.Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = 180;
        c.height = 140;
        const ctx = c.getContext('2d');
        ctx?.drawImage(img, 0, 0, 180, 140);
        add(c.toDataURL('image/png'));
      };
      img.onerror = () => add('');
      img.src = thumbnail;
    } else add('');
  }
  function recipeDownload() {
    const source = spec ?? recipe;
    download(
      new Blob([JSON.stringify(source, null, 2)], { type: 'application/json' }),
      `${fileName(source.name)}.${spec ? 'spec' : 'recipe'}.json`,
    );
    setStatus(
      spec ? 'Editable spec downloaded.' : 'Editable recipe downloaded.',
    );
  }
  async function exportModel(format: 'unity' | 'glb') {
    setBusy(true);
    try {
      if (spec) await exportSpecAsset(spec, format);
      else await exportAsset(recipe, format);
      setStatus(
        format === 'unity'
          ? 'Unity pack downloaded: GLB, static OBJ + MTL, recipe, and import notes.'
          : 'GLB downloaded. Use a glTF importer in Unity.',
      );
    } catch {
      setStatus('Export failed. Your asset is still here; try again.');
    } finally {
      setBusy(false);
    }
  }
  function png() {
    try {
      const data = view.current?.capture();
      if (!data) throw Error();
      const a = document.createElement('a');
      a.href = data;
      a.download = `${fileName(recipe.name)}.png`;
      a.click();
      setStatus('Transparent PNG downloaded from the current camera view.');
    } catch {
      setStatus(
        'The viewport could not be captured. Try again after the model loads.',
      );
    }
  }
  function freshSeed() {
    return crypto.getRandomValues(new Uint32Array(1))[0] % 2147483647;
  }
  function generateFromCode(selected: Blueprint) {
    const next = generateBlueprint(selected, freshSeed());
    current.current = next;
    commit(next);
    if (next.kind === 'creature' || next.kind === 'person')
      setAnimation('Idle');
    setStatus(
      `${blueprints[selected].label} generated locally from procedural TypeScript. Every value remains editable.`,
    );
  }
  function mutateFromCode() {
    const next = mutateRecipe(current.current, freshSeed(), mutation);
    current.current = next;
    commit(next);
    setStatus(
      `Code-generated mutation applied at ${Math.round(mutation * 100)}% strength as one undoable step.`,
    );
  }
  useEffect(
    () =>
      registerStudioTools(
        () => current.current,
        (next) => {
          current.current = next;
          commit(next);
        },
      ),
    [],
  );
  function range(
    key: keyof Recipe,
    label: string,
    min: number,
    max: number,
    step = 1,
  ) {
    return (
      <Range
        key={key}
        label={label}
        min={min}
        max={max}
        step={step}
        value={recipe[key] as number}
        onChange={(v) => change({ [key]: v }, false)}
        onCommit={() => commit()}
      />
    );
  }
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo(e.shiftKey ? 1 : -1);
      }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  return (
    <main className="studio">
      <header className="app-header">
        <div className="wordmark">
          <Shapes size={27} />
          <h1>
            oddlings<span>STUDIO</span>
          </h1>
        </div>
        <span className="header-divider" />
        <span className="header-subtitle">Procedural asset workshop</span>
        <div className="header-actions">
          <button className="quiet" onClick={() => input.current?.click()}>
            <Upload size={16} /> Import recipe or spec
          </button>
          <button className="save-button" onClick={save} disabled={!ready}>
            <Save size={16} /> Save variation
          </button>
          <button
            className="accent"
            onClick={() => void exportModel('unity')}
            disabled={busy}
          >
            <Download size={16} />
            {busy ? 'Preparing…' : 'Export for Unity'}
          </button>
        </div>
      </header>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          try {
            if (f.size > 200000)
              throw Error(
                'That file is too large. Choose a single exported recipe or spec.',
              );
            const parsed: unknown = JSON.parse(await f.text());
            if (
              parsed &&
              typeof parsed === 'object' &&
              Array.isArray((parsed as { parts?: unknown }).parts)
            ) {
              const next = parseSpec(parsed);
              commitDoc({ recipe: current.current, spec: next });
              setSelected(null);
              setAnimation(clipsOf(next).at(0)?.name ?? 'Bind pose');
              setStatus(
                `Spec loaded: ${next.name}. Previewing the exact geometry it describes — edit any slider to go back to the generators.`,
              );
            } else {
              const next = parseRecipe(parsed);
              commit(next);
              setStatus(
                'Recipe imported. Every generator setting has been restored.',
              );
            }
          } catch (error) {
            setStatus(
              error instanceof Error
                ? error.message
                : 'Could not import this file.',
            );
          }
          e.target.value = '';
        }}
      />
      <div className="workbench">
        <aside className="library">
          <div className="panel-heading">
            <span>YOUR COLLECTION</span>
            <span>{library.length.toString().padStart(2, '0')}</span>
          </div>
          <button className="new-asset" onClick={randomize}>
            <Plus size={16} /> New variation
          </button>
          {library.length === 0 ? (
            <div className="library-empty">
              <Layers size={29} />
              <h2>
                A home for your
                <br />
                happy accidents.
              </h2>
              <p>
                Save a variation to keep it here. Pick it up and keep shaping it
                anytime.
              </p>
            </div>
          ) : (
            <div className="asset-list">
              {library.map((s) => (
                <div className="saved-asset" key={s.id}>
                  <button
                    onClick={() => {
                      commit(s.recipe);
                      setStatus(
                        `Loaded ${s.recipe.name}. Changes won’t overwrite the saved variation.`,
                      );
                    }}
                  >
                    {s.thumbnail ? (
                      <img src={s.thumbnail} alt={s.recipe.name} />
                    ) : (
                      <Box size={36} />
                    )}
                    <strong>{s.recipe.name}</strong>
                    <span>
                      {s.recipe.kind} · {String(s.recipe.seed).slice(-6)}
                    </span>
                  </button>
                  <button
                    className="remove"
                    aria-label={`Remove ${s.recipe.name} from library`}
                    onClick={() => {
                      if (persist(library.filter((x) => x.id !== s.id))) {
                        setStatus(
                          'Variation removed. Use Restore removed to undo.',
                        );
                        removed.current = s;
                        setCanRestore(true);
                      }
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="library-foot">
            <span>Stored on this device</span>
            <p>Download recipes to back up or move your assets.</p>
          </div>
        </aside>
        <section className="working-area">
          <div className="asset-title">
            <div>
              <span className="eyebrow">
                {spec
                  ? `${spec.kind.toUpperCase()} / SPEC`
                  : `${recipe.kind.toUpperCase()} / ${recipe.archetype.toUpperCase()}`}
              </span>
              <h2>{(spec ? spec.name : recipe.name) || 'Untitled asset'}</h2>
            </div>
            <div className="history">
              <button
                aria-label="Undo"
                title="Undo (Ctrl+Z)"
                disabled={cursor === 0}
                onClick={() => undo(-1)}
              >
                <Undo2 size={17} />
              </button>
              <button
                aria-label="Redo"
                title="Redo (Ctrl+Shift+Z)"
                disabled={cursor === history.length - 1}
                onClick={() => undo(1)}
              >
                <Redo2 size={17} />
              </button>
            </div>
          </div>
          {spec && (
            <div className="spec-banner">
              <Braces size={15} />
              <div>
                <strong>Previewing an authored spec</strong>
                <span>
                  {spec.parts.length} top-level part
                  {spec.parts.length === 1 ? '' : 's'} · seed {spec.seed}
                  {spec.rig
                    ? ' · rigged'
                    : spec.joints?.length
                      ? ` · ${spec.joints.length} joint${spec.joints.length === 1 ? '' : 's'}`
                      : ' · static'}
                </span>
              </div>
              <button
                onClick={() => {
                  commitDoc({ recipe: current.current, spec: null });
                  setSelected(null);
                }}
              >
                Back to generators
              </button>
            </div>
          )}
          <section
            className="generator-workshop"
            aria-labelledby="generator-workshop-title"
          >
            <div className="generator-workshop-head">
              <div className="code-mark">
                <Braces size={17} />
              </div>
              <div>
                <h3 id="generator-workshop-title">Procedural code generator</h3>
                <p>
                  Meshes, rigs, skin weights, and worlds are built locally from
                  TypeScript, math, and a seed.
                </p>
              </div>
              <span className="code-badge">
                <i /> LOCAL CODE
              </span>
            </div>
            <div className="blueprint-grid">
              {(Object.keys(blueprints) as Blueprint[])
                .filter((key) => blueprints[key].kind === recipe.kind)
                .map((key) => (
                  <button
                    key={key}
                    aria-pressed={activeBlueprint === key}
                    onClick={() => setBlueprint(key)}
                  >
                    <strong>{blueprints[key].label}</strong>
                    <span>{blueprints[key].description}</span>
                  </button>
                ))}
            </div>
            <div className="generator-actions">
              <button
                className="accent"
                onClick={() => {
                  setBlueprint(activeBlueprint);
                  generateFromCode(activeBlueprint);
                }}
              >
                <Dices size={16} /> Generate blueprint
              </button>
              <button onClick={mutateFromCode}>
                <GitBranch size={16} /> Mutate current
              </button>
              <label>
                Mutation
                <Slider
                  aria-label="Mutation strength"
                  value={[mutation]}
                  min={0.1}
                  max={1}
                  step={0.05}
                  onValueChange={(value) =>
                    setMutation(Array.isArray(value) ? value[0] : value)
                  }
                />
                <output>{Math.round(mutation * 100)}%</output>
              </label>
            </div>
            <p className="deterministic-note">
              Same seed + recipe = same geometry. No model API, generated media,
              or network request.
            </p>
          </section>
          <div className="viewport-shell">
            <div className={`follow-bar${link === 'live' ? '' : ' detached'}`}>
              {link === 'waiting' && !follow ? (
                <span>
                  Waiting for a build — run <code>oddlings build</code> or{' '}
                  <code>oddlings audit</code> and it appears here.
                </span>
              ) : link === 'gaveup' ? (
                <>
                  <span>
                    No build found. Run <code>oddlings build</code> or{' '}
                    <code>oddlings audit</code>, then:
                  </span>
                  <button
                    className="quiet"
                    onClick={() => setRecheck((n) => n + 1)}
                  >
                    Check again
                  </button>
                </>
              ) : follow ? (
                <>
                  <span className="follow-dot" aria-hidden />
                  <span>
                    Following <strong>{followedFile ?? follow.label}</strong>
                    {follow.pinned ? ' (pinned)' : ' — latest build'}
                  </span>
                  {followedAt && (
                    <time dateTime={followedAt}>
                      {new Date(followedAt).toLocaleTimeString()}
                    </time>
                  )}
                  <button
                    className="quiet"
                    onClick={() => detach('Stopped following. This document is yours now.')}
                  >
                    Stop
                  </button>
                </>
              ) : (
                <>
                  <span>Not following a file — edits stay here.</span>
                  <button className="quiet" onClick={reattach}>
                    {target.current?.pinned
                      ? `Re-follow ${target.current.label}`
                      : 'Follow the latest build'}
                  </button>
                </>
              )}
            </div>
            <div className="view-toolbar">
              <span>
                <Box size={14} /> PERSPECTIVE
              </span>
              <div>
                <button onClick={() => view.current?.front()}>Front</button>
                <button
                  title="Fit model to view"
                  aria-label="Fit model to view"
                  onClick={() => view.current?.home()}
                >
                  <Focus size={16} />
                </button>
                <button
                  title="Download transparent PNG"
                  aria-label="Download transparent PNG"
                  onClick={png}
                >
                  <ImageIcon size={16} />
                </button>
              </div>
            </div>
            <AssetViewport
              ref={view}
              recipe={recipe}
              spec={spec}
              selected={selected}
              onSelect={setSelected}
              onTransform={transformPart}
              onMoveBone={moveBoneTo}
              onDelete={removeSelected}
              onDuplicate={duplicateSelected}
              pixel={pixel}
              wireframe={wire}
              grid={grid}
              rotate={rotate}
              animation={animation}
              skeleton={skeleton}
              speed={speed}
              onStats={setMetric}
            />
            {animated && (
              <div className="clip-tests" aria-label="Animation test clips">
                <span>TEST</span>
                {clips.map((clip) => (
                  <button
                    key={clip}
                    aria-pressed={animation === clip}
                    onClick={() => setAnimation(clip)}
                  >
                    {clip}
                  </button>
                ))}
              </div>
            )}
            <div className="view-options">
              <Toggle label="Pixel preview" value={pixel} onChange={setPixel} />
              <Toggle label="Wireframe" value={wire} onChange={setWire} />
              <Toggle label="Grid" value={grid} onChange={setGrid} />
              <Toggle label="Turntable" value={rotate} onChange={setRotate} />
            </div>
          </div>
          <div className="asset-metrics">
            <div>
              <span>TRIANGLES</span>
              <b>{metric?.triangles.toLocaleString() ?? '—'}</b>
            </div>
            <div>
              <span>MESH PARTS</span>
              <b>{metric?.meshes ?? '—'}</b>
            </div>
            <div>
              <span>MATERIALS</span>
              <b>{metric?.materials ?? '—'}</b>
            </div>
            <div>
              <span>SIZE / METERS</span>
              <b>{metric?.size.map((n) => n.toFixed(2)).join(' × ') ?? '—'}</b>
            </div>
          </div>
          <div className="export-strip">
            <div className="export-icon">
              <Box size={21} />
            </div>
            <div>
              <h3>From odd little idea to game asset.</h3>
              <p>
                {animated
                  ? `${bones} bones · ${clips.length - 1} clip${clips.length === 2 ? '' : 's'} · Skinned meshes`
                  : 'Static meshes · Flat normals · Solid-color materials'}
              </p>
            </div>
            <button onClick={() => void exportModel('glb')} disabled={busy}>
              Export GLB <ArrowUpRight size={15} />
            </button>
            <button onClick={recipeDownload}>
              {spec ? 'Spec JSON' : 'Recipe JSON'} <Download size={14} />
            </button>
          </div>
        </section>
        <aside className="properties">
          <div className="panel-heading">
            <span>{spec ? 'EDIT THE SPEC' : 'MAKE IT YOURS'}</span>
            {!spec && (
              <button
                className="icon-button"
                aria-label="Reset generator settings"
                title="Reset generator settings"
                onClick={() =>
                  change({
                    ...generateBlueprint(activeBlueprint, recipe.seed),
                    name: recipe.name,
                  })
                }
              >
                <RotateCcw size={14} />
              </button>
            )}
          </div>
          {spec ? (
            <SpecEditor
              spec={spec}
              audit={audit}
              selected={selected}
              onSelect={setSelected}
              onChange={editSpec}
              onDelete={removeSelected}
              onDuplicate={duplicateSelected}
              onStatus={setStatus}
            />
          ) : (
            <>
          <Tabs
            value={recipe.kind}
            onValueChange={(v) => switchKind(v as Kind)}
          >
            <TabsList className="generator-tabs">
              <TabsTrigger value="creature">
                <Shapes size={15} />
                Creature
              </TabsTrigger>
              <TabsTrigger value="person">
                <UserRound size={15} />
                Person
              </TabsTrigger>
              <TabsTrigger value="prop">
                <TreePine size={15} />
                Prop
              </TabsTrigger>
              <TabsTrigger value="environment">
                <Mountain size={15} />
                World
              </TabsTrigger>
            </TabsList>
            <div className="property-section identity">
              <label htmlFor="asset-name">Asset name</label>
              <input
                id="asset-name"
                value={recipe.name}
                maxLength={60}
                onChange={(e) => change({ name: e.target.value }, false)}
                onBlur={() => commit()}
              />
              <label htmlFor="seed">Generation seed</label>
              <div className="seed-row">
                <input
                  id="seed"
                  type="number"
                  min={0}
                  max={2147483647}
                  value={recipe.seed}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isInteger(n) && n >= 0 && n <= 2147483647)
                      change({ seed: n }, false);
                  }}
                  onBlur={() => commit()}
                />
                <button
                  title="Generate a new seed"
                  aria-label="Generate a new seed"
                  onClick={randomize}
                >
                  <Shuffle size={17} />
                </button>
              </div>
            </div>
            <TabsContent value="creature">
              <div className="property-section">
                <h3>Shape & character</h3>
                {range('width', 'Head width', 0.6, 1.5, 0.01)}
                {range('height', 'Head height', 0.65, 1.5, 0.01)}
                {range('roughness', 'Asymmetry', 0, 0.3, 0.01)}
                {range('ears', 'Ear size', 0, 1.8, 0.05)}
              </div>
              <div className="property-section">
                <h3>Little peculiarities</h3>
                {range('eyes', 'Eyes', 1, 5)}
                {range('horns', 'Horns', 0, 8)}
                {range('teeth', 'Teeth', 0, 10)}
              </div>
            </TabsContent>
            <TabsContent value="person">
              <div className="property-section">
                <h3>Body & silhouette</h3>
                {range('width', 'Build', 0.6, 1.5, 0.01)}
                {range('height', 'Stature', 0.65, 1.5, 0.01)}
                {range('roughness', 'Variation', 0, 0.3, 0.01)}
                {range('horns', 'Hair tufts', 0, 8)}
                {range('ears', 'Gear size', 0, 1.8, 0.05)}
              </div>
            </TabsContent>
            <TabsContent value="prop">
              <div className="property-section">
                <h3>Procedural form</h3>
                {range('width', 'Width', 0.6, 1.5, 0.01)}
                {range('height', 'Height', 0.65, 1.5, 0.01)}
                {range('roughness', 'Irregularity', 0, 0.3, 0.01)}
                {range(
                  'horns',
                  recipe.archetype === 'tree' ? 'Branches' : 'Primary details',
                  0,
                  8,
                )}
                {range(
                  'teeth',
                  recipe.archetype === 'mushroom'
                    ? 'Cap spots'
                    : 'Small details',
                  0,
                  10,
                )}
                {range('ears', 'Depth / spread', 0, 1.8, 0.05)}
              </div>
            </TabsContent>
            <TabsContent value="environment">
              <div className="property-section">
                <h3>Populate the clearing</h3>
                {range('trees', 'Trees', 0, 24)}
                {range('huts', 'Huts', 0, 5)}
                {range('rocks', 'Rocks', 0, 40)}
                {range('plants', 'Mushrooms', 0, 100)}
                <Toggle
                  label="Pond"
                  value={recipe.pond}
                  onChange={(pond) => change({ pond })}
                />
              </div>
            </TabsContent>
          </Tabs>
          <div className="property-section">
            <h3>
              {recipe.kind === 'creature' || recipe.kind === 'person'
                ? 'Character palette'
                : 'Material palette'}
            </h3>
            <div className="swatches">
              {(recipe.kind === 'creature' || recipe.kind === 'person'
                ? colors
                : worldColors
              ).map((color) => (
                <button
                  key={color}
                  style={{ background: color }}
                  className={recipe.color === color ? 'chosen' : ''}
                  aria-label={`Use color ${color}`}
                  aria-pressed={recipe.color === color}
                  onClick={() => change({ color })}
                />
              ))}
              <label title="Custom color">
                <input
                  type="color"
                  aria-label="Custom asset color"
                  value={recipe.color}
                  onChange={(e) => change({ color: e.target.value }, false)}
                  onBlur={() => commit()}
                />
                <span>+</span>
              </label>
            </div>
            <span className="hex-value">{recipe.color.toUpperCase()}</span>
          </div>
          {(recipe.kind === 'creature' || recipe.kind === 'person') && (
            <div className="property-section rigging">
              <h3>Rig & animate</h3>
              <Toggle
                label="Body rig"
                value={recipe.rigged}
                onChange={(rigged) => change({ rigged })}
              />
              {recipe.rigged && (
                <>
                  <p className="help">
                    14 joints · automatic skin weights · Generic rig
                  </p>
                  <span className="animation-label">Preview clip</span>
                  <Select
                    value={animation}
                    onValueChange={(v) => setAnimation(String(v))}
                  >
                    <SelectTrigger
                      className="animation-select"
                      aria-label="Animation preview"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {clips.map((clip) => (
                        <SelectItem key={clip} value={clip}>
                          {clip}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Toggle
                    label="Show skeleton"
                    value={skeleton}
                    onChange={setSkeleton}
                  />
                  <Range
                    label="Playback speed"
                    value={speed}
                    min={0.25}
                    max={2}
                    step={0.25}
                    onChange={setSpeed}
                    onCommit={() => {}}
                  />
                  {range('hipHeight', 'Hip joint height', 0.35, 0.85, 0.01)}
                  {range('headPivot', 'Head pivot', 0.7, 1.65, 0.01)}
                  {range('shoulderWidth', 'Shoulder width', 0.2, 0.55, 0.01)}
                </>
              )}
            </div>
          )}
          <div className="property-section">
            <h3>Game scale</h3>
            {range('scale', 'Scale multiplier', 0.1, 5, 0.1)}
            <p className="help">
              1 unit = 1 meter. Preview pixelation is not baked into the
              exported mesh.
            </p>
          </div>
            </>
          )}
          <div className="unity-note">
            <Box size={16} />
            <p>
              Unity pack includes OBJ + MTL. GLB needs a glTF importer. Rigged
              characters include Idle, Walk, Jump, Wave, and Attack clips. Use
              the GLB for animation; OBJ is static. Add collision in Unity.
            </p>
          </div>
        </aside>
      </div>
      <footer className="status-bar">
        <output>{status}</output>
        {canRestore && (
          <button
            onClick={() => {
              if (
                removed.current &&
                library.length < 40 &&
                persist([
                  removed.current,
                  ...library.filter((s) => s.id !== removed.current?.id),
                ])
              ) {
                setCanRestore(false);
                setStatus('Removed variation restored.');
              }
            }}
          >
            Restore removed
          </button>
        )}
        <span>
          Y UP <i /> METERS <i /> LOCAL LIBRARY
        </span>
      </footer>
    </main>
  );
}
