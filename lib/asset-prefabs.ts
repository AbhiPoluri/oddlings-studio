import { OVERRIDABLE, parseSpec, type AssetSpec } from './asset-spec';

/**
 * Prefabs: one part written once and used many times.
 *
 * A 114-part knight is not 114 decisions. It is a rivet, a plate and a finger,
 * each written once and then repeated by hand down the file — which is how a
 * spec ends up with nine copies of the same subtree that are subtly not the
 * same, because the eighth one was edited and the others were not. `repeat`
 * already covers copies that sit in a row or a ring; a prefab covers the rest,
 * where the copies go wherever the author puts them.
 *
 * `defs` is a library of parts, keyed by name. A part written
 * `{ "use": "rivet", "position": [...] }` is replaced, before anything is
 * validated, by the def's whole subtree with those overrides applied. Nothing
 * downstream — the schema, the builder, the audit, the surface blend, the rig
 * binder, the studio's path-addressed editing — ever sees a `use`, because by
 * the time any of them run there is none left. That is the whole point of
 * doing this in one pure pass at the top of `parseSpec` rather than teaching
 * every consumer a second way to spell a part.
 *
 * What expansion leaves behind is one mark: `prefab: { def, use }` on the part
 * a use site became. The mark is what stops an edit in the studio from being
 * written into the def by accident — see `contractPrefabs`.
 */

/** A JSON object mid-expansion: this pass runs before the schema, so nothing is typed yet. */
type Node = Record<string, unknown>;

/**
 * How far a def may reach through other defs.
 *
 * Nesting is the reason prefabs compose — a `finger` def used five times by a
 * `hand` def used twice by an `arm` def — but a def that reaches eight deep is
 * a mistake rather than a hand, and refusing at a bound keeps a typo from
 * turning into a multi-second expansion.
 */
export const MAX_PREFAB_DEPTH = 8;

/**
 * Ceiling on the parts one expansion may produce.
 *
 * Nesting multiplies: sixty children in a def used sixty times is 3600 parts
 * from four lines of JSON. The schema's own limits (200 top-level parts, 64
 * children) cannot see that, because they are applied after this pass.
 */
export const MAX_PREFAB_PARTS = 4000;

/** Where a part came from. Written by expansion; never authored by hand. */
export type PrefabMark = {
  /** The key in `defs` this subtree was stamped from. */
  def: string;
  /** Path of the use site in the expanded tree, restamped on every parse. */
  use: number[];
};

function plain(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The spelling zod uses for a part path, so both kinds of error read alike. */
function where(path: number[]): string {
  return `parts.${path.join('.children.')}`;
}

function nameOf(node: Node): string {
  return (
    (typeof node.name === 'string' && node.name) ||
    (typeof node.shape === 'string' && node.shape) ||
    'part'
  );
}

/** Every error from this pass reads like the parser's, because it is one. */
function refuse(at: string, message: string): never {
  throw Error(`Invalid asset spec at ${at}: ${message}`);
}

/**
 * Structural equality, with an absent key and an explicit `undefined` the same
 * thing, and `prefab.use` ignored.
 *
 * The path in a mark is a convenience that every parse recomputes, so two
 * parts that came from the same def are the same part even when the studio has
 * since moved one of them. Comparing it would turn a reordered outliner into a
 * refused save.
 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;
    return a.every((item, i) => same(item, b[i]));
  }
  if (!plain(a) || !plain(b)) return false;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === 'prefab') {
      const left = plain(a.prefab) ? a.prefab.def : undefined;
      const right = plain(b.prefab) ? b.prefab.def : undefined;
      if (left !== right) return false;
      continue;
    }
    if (!same(a[key], b[key])) return false;
  }
  return true;
}

/** True when this subtree, or anything under it, is a use site. */
function usesAnything(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(usesAnything);
  if (!plain(value)) return false;
  if ('use' in value || 'prefab' in value) return true;
  return usesAnything(value.children);
}

type Pass = {
  defs: Node;
  /** Parts produced so far, against `MAX_PREFAB_PARTS`. */
  made: { count: number };
};

/**
 * One node, expanded.
 *
 * `chain` is the defs entered to get here, in order, which is both the cycle
 * check and the text of the message when it fails: an author who wrote a loop
 * wants to be told which two defs to look at, not that the stack ran out.
 */
function expandNode(node: unknown, path: number[], chain: string[], pass: Pass): unknown {
  if (Array.isArray(node) || !plain(node)) return node;
  if (++pass.made.count > MAX_PREFAB_PARTS)
    refuse(
      where(path),
      `This spec expands past ${MAX_PREFAB_PARTS} parts. A def used inside a def multiplies: check the counts.`,
    );
  if (!('use' in node)) {
    const done = expandChildren(node, path, chain, pass);
    // A spec that has been through here already keeps its marks, but not their
    // paths: the studio moves and duplicates parts between parses, and a mark
    // that names where its use site used to be is worse than no mark at all.
    return plain(done.prefab)
      ? { ...done, prefab: { ...done.prefab, use: path } }
      : done;
  }

  const at = `${where(path)}.use`;
  const def = node.use;
  if (typeof def !== 'string' || !def)
    refuse(at, '"use" names a prefab from "defs", as a string.');
  const body = pass.defs[def];
  if (body === undefined) {
    const known = Object.keys(pass.defs);
    refuse(
      at,
      `There is no prefab called "${def}". ${
        known.length
          ? `"defs" holds: ${known.join(', ')}.`
          : 'This spec has no "defs" block to take one from.'
      }`,
    );
  }
  if (chain.includes(def))
    refuse(
      `defs.${chain[0] ?? def}`,
      `Prefab cycle: ${[...chain, def].map((name) => `"${name}"`).join(' uses ')}. A def cannot use itself, however many steps it takes to get back.`,
    );
  if (chain.length >= MAX_PREFAB_DEPTH)
    refuse(
      at,
      `Prefabs nest more than ${MAX_PREFAB_DEPTH} deep here (${[...chain, def].join(' → ')}). Flatten one of them.`,
    );

  const overrides: Node = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'use') continue;
    if (!(OVERRIDABLE as readonly string[]).includes(key))
      refuse(
        `${where(path)}.${key}`,
        `"${key}" cannot be set on a use of prefab "${def}": a use site places a copy, it does not redraw it. Set "${key}" in "defs.${def}" — or make a second def. A use may override: ${OVERRIDABLE.join(', ')}.`,
      );
    overrides[key] = value;
  }

  // The def's own body is expanded first, in the use site's position, so a def
  // that is itself a use of another def works and so do uses inside its
  // children — all with paths that already read as where the parts ended up.
  const stamped = expandNode(
    structuredClone(body),
    path,
    [...chain, def],
    pass,
  );
  if (!plain(stamped))
    refuse(`defs.${def}`, 'A prefab is a part: an object with a "shape".');

  /*
   * Children append rather than replace.
   *
   * A def's children are what it is — the bracket's bolt, the rivet's dome —
   * and a use site that replaced them would quietly delete the structure it
   * asked for, which is the one thing a prefab exists to keep. Appending makes
   * the use site purely additive: this copy also carries a banner, and the
   * bracket is still a bracket. An author who wants different children wants a
   * different def.
   */
  const inherited = Array.isArray(stamped.children) ? stamped.children : [];
  const added = Array.isArray(overrides.children) ? overrides.children : [];
  delete overrides.children;
  const children = [
    ...inherited,
    ...added.map((child, index) =>
      expandNode(child, [...path, inherited.length + index], chain, pass),
    ),
  ];

  const out: Node = { ...stamped, ...overrides, prefab: { def, use: path } };
  if (children.length) out.children = children;
  else delete out.children;
  return out;
}

function expandChildren(node: Node, path: number[], chain: string[], pass: Pass): Node {
  const children = node.children;
  if (!Array.isArray(children)) return node;
  return {
    ...node,
    children: children.map((child, index) =>
      expandNode(child, [...path, index], chain, pass),
    ),
  };
}

/**
 * Replace every `use` with the subtree it names. Pure: the input is never
 * touched, and the same input always gives the same output.
 *
 * Deliberately tolerant of rubbish — anything that is not a spec-shaped object
 * is handed straight back, so the schema gets to write the message about it
 * rather than this pass throwing something vaguer first.
 *
 * `defs` survives into the parsed spec rather than being consumed here. It is
 * what lets a save-back rewrite the use sites instead of the inlined copies
 * (`contractPrefabs`), and it means a spec stays authored-shaped however many
 * times it is parsed, edited and reparsed on its way through the studio.
 */
export function expandPrefabs(input: unknown): unknown {
  if (!plain(input)) return input;
  const parts = input.parts;
  if (!Array.isArray(parts) || !usesAnything(parts)) return input;
  const defs = input.defs;
  if (!plain(defs))
    refuse(
      'defs',
      'A "use" needs a "defs" block: { "defs": { "rivet": { "shape": ... } } }.',
    );
  const pass: Pass = { defs, made: { count: 0 } };
  return {
    ...input,
    parts: parts.map((part, index) => expandNode(part, [index], [], pass)),
  };
}

/**
 * The def and use site behind an expanded part, for an error the schema raised.
 *
 * A bevel wider than its part is reported by zod at `parts.7.children.0`,
 * which in a prefab spec is a place the author never typed. This walks the
 * expanded tree alongside the issue path and names the deepest prefab it
 * passed through, so the message ends up pointing at the def to fix and the
 * copy that showed the problem.
 */
export function prefabWhere(
  expanded: unknown,
  path: readonly PropertyKey[],
): string {
  const text = path.join('.');
  if (!plain(expanded)) return text;
  let node: unknown = expanded;
  let mark: PrefabMark | null = null;
  for (const step of path) {
    node = Array.isArray(node)
      ? node[Number(step)]
      : plain(node)
        ? node[String(step)]
        : undefined;
    if (plain(node) && plain(node.prefab)) mark = node.prefab as PrefabMark;
  }
  if (!mark) return text;
  return `${text} (from prefab "${mark.def}", used at ${where(mark.use)})`;
}

/* ------------------------------------------------------------------------ *
 * Contraction: putting an edited spec back the way it was written.
 * ------------------------------------------------------------------------ */

/**
 * The inverse of expansion, as far as an inverse can go.
 *
 * The studio holds an expanded spec and saves it over the file it is
 * following. Written as it stands, that file would come back with nine inlined
 * rivets where it had one def and nine use sites — the prefab silently
 * dissolved by the act of correcting one of its copies. So every part carrying
 * a mark is diffed against a fresh stamp of its def, and what differs becomes
 * the override on the use site: move one bracket in the viewport and the file
 * gains `"position"` on that one use, which is what a person would have typed.
 *
 * Two edits cannot be written that way, and both are refused rather than
 * guessed at:
 *
 * - a field a use site may not override (`shape`, `detail`, a profile): the
 *   author means the def, and writing it into the def would move all nine.
 * - anything inside the def's own subtree — a child moved, removed, restyled.
 *   Same reason, one level down.
 *
 * The refusal names the def, the use site and the part, because the fix is a
 * choice only a person can make: edit the def and move every copy, or detach
 * this one by dropping its `prefab` mark.
 */
export function contractPrefabs(spec: unknown): unknown {
  if (!plain(spec)) return spec;
  const defs = spec.defs;
  const parts = spec.parts;
  // Nothing to put back: the overwhelmingly common case, and it has to hand
  // back the very object it was given so a plain spec saves byte for byte.
  if (!plain(defs) || !Array.isArray(parts)) return spec;
  const pass: Pass = { defs, made: { count: 0 } };
  const out = {
    ...spec,
    parts: parts.map((part, index) => contractNode(part, [index], pass)),
  };
  /*
   * The guard that makes the two refusals above trustworthy: parse what is
   * about to be written and check it comes back as what is on screen. Without
   * it, any field this pass fails to account for is lost silently, and the
   * first person to find out is whoever opens the file tomorrow.
   */
  if (!same(parseSpec(out), spec))
    throw Error(
      'Cannot save: rewriting the prefab use sites would not reproduce this spec exactly. Detach the edited copies (drop their "prefab" marks) and save again.',
    );
  return out;
}

function contractNode(node: unknown, path: number[], pass: Pass): unknown {
  if (!plain(node)) return node;
  const mark = plain(node.prefab) ? (node.prefab as PrefabMark) : null;
  // A mark naming a def that is no longer there is a part in its own right:
  // somebody deleted the def, and the subtree in hand is all there is of it.
  if (!mark || pass.defs[mark.def] === undefined)
    return contractChildren(node, path, pass);
  const template = expandNode(
    structuredClone(pass.defs[mark.def]),
    path,
    [mark.def],
    { defs: pass.defs, made: { count: 0 } },
  );
  if (!plain(template)) return contractChildren(node, path, pass);

  const use: Node = { use: mark.def };
  for (const key of new Set([...Object.keys(node), ...Object.keys(template)])) {
    if (key === 'prefab' || key === 'children') continue;
    if (same(node[key], template[key])) continue;
    if (!(OVERRIDABLE as readonly string[]).includes(key))
      throw Error(
        `Cannot save: "${key}" on "${nameOf(node)}" (${where(path)}) differs from prefab "${mark.def}", and a use site cannot override "${key}". Change "defs.${mark.def}" to move every copy, or drop the "prefab" mark on this part to detach it.`,
      );
    use[key] = node[key];
  }

  const inherited = Array.isArray(template.children) ? template.children : [];
  const children = Array.isArray(node.children) ? node.children : [];
  for (let i = 0; i < inherited.length; i++)
    if (!same(children[i], inherited[i]))
      throw Error(
        `Cannot save: this changes "${plain(children[i]) ? nameOf(children[i]) : 'a part'}" inside prefab "${mark.def}" (${where([...path, i])}), not the use site at ${where(path)}. Edit "defs.${mark.def}" to change every copy, or drop the "prefab" mark on ${where(path)} to detach this one.`,
      );
  const added = children
    .slice(inherited.length)
    .map((child, index) => contractNode(child, [...path, inherited.length + index], pass));
  if (added.length) use.children = added;
  return use;
}

function contractChildren(node: Node, path: number[], pass: Pass): Node {
  const children = node.children;
  if (!Array.isArray(children)) return node;
  return {
    ...node,
    children: children.map((child, index) =>
      contractNode(child, [...path, index], pass),
    ),
  };
}

/**
 * What the save endpoint should write for a spec the studio has edited.
 *
 * Separated from `contractPrefabs` so the endpoint stays a one-line hook: a
 * spec with no prefabs in it is handed back untouched, object identity and
 * all, and only a prefab spec takes the rewrite — and its refusals arrive as
 * the same 400-with-a-message any other bad save gets.
 */
export function contractSaved(spec: unknown): unknown {
  if (!plain(spec) || !plain(spec.defs)) return spec;
  return contractPrefabs(spec);
}

/** The defs a spec declares, for a caller that wants to list them. */
export function prefabNames(spec: AssetSpec): string[] {
  return spec.defs ? Object.keys(spec.defs) : [];
}
