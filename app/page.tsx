'use client';
import { useEffect, useRef, useState } from 'react';
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
import { registerStudioTools } from '@/lib/studio-tools';
import { download, exportAsset } from '@/lib/asset-export';
import {
  blueprints,
  generateBlueprint,
  mutateRecipe,
  type Blueprint,
} from '@/lib/procedural-director';
type Saved = { id: string; recipe: Recipe; thumbnail: string };
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
  const [recipe, setRecipe] = useState<Recipe>(initialRecipe);
  const [library, setLibrary] = useState<Saved[]>([]);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('Ready to make something strange.');
  const [pixel, setPixel] = useState(true);
  const [wire, setWire] = useState(false);
  const [grid, setGrid] = useState(true);
  const [rotate, setRotate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [metric, setMetric] = useState<AssetStats | null>(null);
  const [history, setHistory] = useState<Recipe[]>([initialRecipe]);
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
      : recipe.kind === 'creature'
        ? 'scout'
        : 'grove';
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
  function commit(next: Recipe = current.current) {
    const { history: h, cursor: c } = historyRef.current;
    if (JSON.stringify(h[c]) === JSON.stringify(next)) return;
    const updated = [...h.slice(0, c + 1), next].slice(-60);
    historyRef.current = { history: updated, cursor: updated.length - 1 };
    setHistory(updated);
    setCursor(updated.length - 1);
    setRecipe(next);
  }
  function change(p: Partial<Recipe>, record = true) {
    const next = { ...current.current, ...p };
    current.current = next;
    setRecipe(next);
    if (record) commit(next);
  }
  function undo(direction: number) {
    const { history: h, cursor: c } = historyRef.current;
    const next = Math.max(0, Math.min(h.length - 1, c + direction));
    historyRef.current = { history: h, cursor: next };
    setCursor(next);
    current.current = h[next];
    setRecipe(h[next]);
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
    setBlueprint(kind === 'creature' ? 'scout' : 'grove');
    change({
      kind,
      name: kind === 'creature' ? 'Mossling' : 'Fern Hollow',
      color: kind === 'creature' ? '#93cec8' : '#596c50',
    });
    setStatus(
      kind === 'creature'
        ? 'Creature generator selected.'
        : 'Environment generator selected.',
    );
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
    download(
      new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' }),
      `${fileName(recipe.name)}.recipe.json`,
    );
    setStatus('Editable recipe downloaded.');
  }
  async function exportModel(format: 'unity' | 'glb') {
    setBusy(true);
    try {
      await exportAsset(recipe, format);
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
    if (next.kind === 'creature') setAnimation('Idle');
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
            <Upload size={16} /> Import recipe
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
            if (f.size > 20000)
              throw Error(
                'Recipe is too large. Choose a single exported recipe.',
              );
            const next = parseRecipe(JSON.parse(await f.text()));
            commit(next);
            setStatus(
              'Recipe imported. Every generator setting has been restored.',
            );
          } catch (error) {
            setStatus(
              error instanceof Error
                ? error.message
                : 'Could not import this recipe.',
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
                {recipe.kind === 'creature'
                  ? 'CREATURE / GENERATOR 01'
                  : 'ENVIRONMENT / GENERATOR 02'}
              </span>
              <h2>{recipe.name || 'Untitled asset'}</h2>
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
              pixel={pixel}
              wireframe={wire}
              grid={grid}
              rotate={rotate}
              animation={animation}
              skeleton={skeleton}
              speed={speed}
              onStats={setMetric}
            />
            {recipe.kind === 'creature' && recipe.rigged && (
              <div className="clip-tests" aria-label="Animation test clips">
                <span>TEST</span>
                {['Bind pose', 'Idle', 'Walk', 'Jump', 'Wave', 'Attack'].map(
                  (clip) => (
                    <button
                      key={clip}
                      aria-pressed={animation === clip}
                      onClick={() => setAnimation(clip)}
                    >
                      {clip}
                    </button>
                  ),
                )}
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
                {recipe.kind === 'creature' && recipe.rigged
                  ? '14-bone rig · 5 test clips · Skinned meshes'
                  : 'Static meshes · Flat normals · Solid-color materials'}
              </p>
            </div>
            <button onClick={() => void exportModel('glb')} disabled={busy}>
              Export GLB <ArrowUpRight size={15} />
            </button>
            <button onClick={recipeDownload}>
              Recipe JSON <Download size={14} />
            </button>
          </div>
        </section>
        <aside className="properties">
          <div className="panel-heading">
            <span>MAKE IT YOURS</span>
            <button
              className="icon-button"
              aria-label="Reset generator settings"
              title="Reset generator settings"
              onClick={() =>
                change({
                  ...initialRecipe,
                  kind: recipe.kind,
                  name: recipe.name,
                  color:
                    recipe.kind === 'creature'
                      ? initialRecipe.color
                      : '#596c50',
                })
              }
            >
              <RotateCcw size={14} />
            </button>
          </div>
          <Tabs
            value={recipe.kind}
            onValueChange={(v) => switchKind(v as Kind)}
          >
            <TabsList className="generator-tabs">
              <TabsTrigger value="creature">
                <Shapes size={15} />
                Creature
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
              {recipe.kind === 'creature' ? 'Skin palette' : 'Ground palette'}
            </h3>
            <div className="swatches">
              {(recipe.kind === 'creature' ? colors : worldColors).map(
                (color) => (
                  <button
                    key={color}
                    style={{ background: color }}
                    className={recipe.color === color ? 'chosen' : ''}
                    aria-label={`Use color ${color}`}
                    aria-pressed={recipe.color === color}
                    onClick={() => change({ color })}
                  />
                ),
              )}
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
          {recipe.kind === 'creature' && (
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
                      <SelectItem value="Bind pose">Bind pose</SelectItem>
                      <SelectItem value="Idle">Idle</SelectItem>
                      <SelectItem value="Walk">Walk</SelectItem>
                      <SelectItem value="Jump">Jump</SelectItem>
                      <SelectItem value="Wave">Wave</SelectItem>
                      <SelectItem value="Attack">Attack</SelectItem>
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
                  {range('hipHeight', 'Hip joint height', 0.35, 0.65, 0.01)}
                  {range('headPivot', 'Head pivot', 0.7, 1.3, 0.01)}
                  {range('shoulderWidth', 'Shoulder width', 0.2, 0.4, 0.01)}
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
          <div className="unity-note">
            <Box size={16} />
            <p>
              Unity pack includes OBJ + MTL. GLB needs a glTF importer. Rigged
              creatures include Idle, Walk, Jump, Wave, and Attack clips. Use
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
