'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import type { AssetSpec, Shape } from '@/lib/asset-spec';
import { boneLayout } from '@/lib/asset-joints';
import {
  flatten,
  jointBindingsByPath,
  labelFor,
  pathKey,
  sameSelection,
  type Path,
  type Selection,
} from '@/lib/spec-edit';

/**
 * The scene list: every authored part, and optionally the skeleton under it.
 *
 * Split out of the property panel because the two answer different questions —
 * this one is "what is in this asset and which of it am I looking at", the
 * panel is "what is this one thing made of". Keeping them in one column meant
 * the tree scrolled away the moment a part had more than a few fields, which is
 * exactly when you need it.
 *
 * Every row is addressed by path key, so a selection made here, a finding from
 * the audit and a mark from `diffSpecs` all name rows the same way.
 */

/**
 * Three letters per shape, so the glyph column stays one width.
 *
 * A pictogram per shape would be prettier and would need fourteen icons that
 * nobody could tell apart at 16px — a prism and a cone are the same triangle.
 */
const SHAPE_TAG: Record<Shape, string> = {
  sphere: 'sph',
  box: 'box',
  cylinder: 'cyl',
  cone: 'con',
  capsule: 'cap',
  torus: 'tor',
  icosahedron: 'ico',
  octahedron: 'oct',
  tetrahedron: 'tet',
  prism: 'pri',
  plane: 'pln',
  limb: 'lmb',
  lathe: 'lth',
  extrude: 'ext',
  loft: 'lof',
};

/** The key a selection is remembered by, for focus and scroll-into-view. */
function keyOf(selection: Selection): string | null {
  if (!selection) return null;
  return selection.kind === 'part'
    ? `part:${pathKey(selection.path)}`
    : `bone:${selection.name}`;
}

/**
 * How deep a bone sits, walked from its parent chain rather than from its
 * position in the list: `boneLayout` returns joints in authored order, where a
 * child may well come before its parent.
 */
function boneDepths(layout: { name: string; parent: string | null }[]) {
  const parents = new Map(layout.map((bone) => [bone.name, bone.parent]));
  const depths = new Map<string, number>();
  const depthOf = (name: string, seen: Set<string>): number => {
    const held = depths.get(name);
    if (held !== undefined) return held;
    const parent = parents.get(name);
    // `seen` guards a cycle the schema would reject but an editor can hold
    // mid-edit; a cycle reads as depth 0 rather than as a hung tab.
    const depth =
      !parent || seen.has(parent) ? 0 : depthOf(parent, seen.add(name)) + 1;
    depths.set(name, depth);
    return depth;
  };
  for (const bone of layout) depthOf(bone.name, new Set([bone.name]));
  return depths;
}

export function Outliner({
  spec,
  selected,
  hover,
  onSelect,
  onHover,
  onDelete,
  onDuplicate,
  onRename,
  onFrame,
  onIsolate,
  changed,
  notes,
  bones = false,
  filter: initialFilter = '',
}: {
  spec: AssetSpec;
  selected: Selection;
  /** What the viewport is pointing at, drawn as a second, lighter highlight. */
  hover?: Selection;
  onSelect: (selection: Selection) => void;
  onHover?: (selection: Selection) => void;
  /** Delete removes the selected part; without this the key does nothing. */
  onDelete?: (path: Path) => void;
  /** Cmd/Ctrl+D, matching the shortcut the viewport already answers. */
  onDuplicate?: (path: Path) => void;
  /** Double-click a row to rename in place; without this the row is read-only. */
  onRename?: (path: Path, name: string) => void;
  /** Fit the camera to one part, from the row's own menu. */
  onFrame?: (path: Path) => void;
  /** Show one branch alone in the viewport. Toggled, like the `/` shortcut. */
  onIsolate?: (path: Path) => void;
  /** Path keys to mark as changed since the last build. */
  changed?: Set<string>;
  /**
   * Open review notes per path key, for the badge.
   *
   * A note is a piece of work with a place in the tree, and the tree is where
   * you go looking for work — a panel that only lists them somewhere else makes
   * "which parts has anyone said anything about" a thing you have to remember.
   */
  notes?: Map<string, number>;
  /** Show the resolved skeleton below the parts. */
  bones?: boolean;
  /** Seeds the filter box. The box owns the text from then on. */
  filter?: string;
}) {
  const [filter, setFilter] = useState(initialFilter);
  /** The path key of the row being renamed in place, if any. */
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Which row the context menu was opened on; null when it was a bone. */
  const [menuOn, setMenuOn] = useState<Path | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const chosen = keyOf(selected);
  const lit = keyOf(hover ?? null);
  /**
   * Whether this tree is the studio's, rather than the copy the property panel
   * embeds. Gated on the props only the shell passes, so the embedded one keeps
   * rendering exactly the markup it did before any of this existed.
   */
  const hasMenu = Boolean(onFrame || onIsolate || onRename);

  // A selection made in the viewport has to bring its row into view, or
  // clicking a part on screen leaves the tree showing somewhere else entirely.
  useEffect(() => {
    if (!chosen) return;
    rows.current.get(chosen)?.scrollIntoView({ block: 'nearest' });
  }, [chosen]);

  const parts = flatten(spec);
  const bindings = jointBindingsByPath(spec);
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? parts.filter(
        (row) =>
          labelFor(row.part).toLowerCase().includes(needle) ||
          row.part.shape.includes(needle),
      )
    : parts;
  const skeleton = bones ? boneLayout(spec) : [];
  const depths = boneDepths(skeleton);

  /** Arrow keys walk what is on screen, parts then bones, as one list. */
  const walkable: NonNullable<Selection>[] = [
    ...visible.map((row) => ({ kind: 'part', path: row.path }) as const),
    ...skeleton.map((bone) => ({ kind: 'bone', name: bone.name }) as const),
  ];

  function step(by: number) {
    if (!walkable.length) return;
    const at = walkable.findIndex((row) => sameSelection(row, selected));
    const next =
      walkable[
        Math.min(
          walkable.length - 1,
          Math.max(0, at < 0 ? (by > 0 ? 0 : walkable.length - 1) : at + by),
        )
      ];
    onSelect(next);
    rows.current.get(keyOf(next)!)?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    // The rename box lives inside the tree, so every key below would otherwise
    // be taken from it — arrows would walk the rows out from under the caret,
    // and Delete would remove the very part being renamed.
    if (event.target instanceof HTMLInputElement) return;
    const path = selected?.kind === 'part' ? selected.path : null;
    if (event.key === 'ArrowDown') step(1);
    else if (event.key === 'ArrowUp') step(-1);
    else if (event.key === 'Home') step(-walkable.length);
    else if (event.key === 'End') step(walkable.length);
    else if (
      (event.key === 'Delete' || event.key === 'Backspace') &&
      path &&
      onDelete
    )
      onDelete(path);
    else if (
      (event.key === 'd' || event.key === 'D') &&
      (event.metaKey || event.ctrlKey) &&
      path &&
      onDuplicate
    )
      onDuplicate(path);
    else return;
    // Only swallow the keys actually answered, so typing in the filter box and
    // whatever the layout binds above this both keep working.
    event.preventDefault();
  }

  /**
   * Roving tabindex: one stop for the whole tree, on the row in play.
   *
   * Anchored on the first row when the selected one is filtered out, or a
   * selection hidden by the filter box would take the tree out of the tab
   * order entirely.
   */
  const anchor = walkable.some((row) => keyOf(row) === chosen)
    ? chosen
    : keyOf(walkable[0] ?? null);
  const stop = (key: string) => (key === anchor ? 0 : -1);

  const hold = (key: string) => (element: HTMLButtonElement | null) => {
    if (element) rows.current.set(key, element);
    else rows.current.delete(key);
  };

  /**
   * Escape has to leave a rename without writing it, and blurring the box is
   * how a rename ends — so the cancel has to be known by the time `onBlur`
   * runs, and a state update would not have landed yet.
   */
  const cancelled = useRef(false);

  const tree = (
    <div
      className="outliner-tree part-tree"
      role="tree"
      aria-label="Outliner"
      // The rows carry the tab stop; this is here so the tree itself can hold
      // focus when a row is removed out from under it.
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {visible.map(({ path, part, depth, copies }) => {
        const key = `part:${pathKey(path)}`;
        const joint = bindings.get(pathKey(path));
        const open = notes?.get(pathKey(path)) ?? 0;

        if (onRename && renaming === key)
          return (
            <div
              key={key}
              role="treeitem"
              className="outliner-row outliner-editing"
              data-path={pathKey(path)}
              data-depth={depth}
              aria-level={depth + 1}
              aria-selected={chosen === key}
            >
              {depth > 0 && <ChevronRight size={11} aria-hidden="true" />}
              <span className="outliner-shape" title={part.shape}>
                {SHAPE_TAG[part.shape]}
              </span>
              <input
                className="outliner-rename"
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                defaultValue={part.name ?? ''}
                placeholder={part.shape}
                maxLength={60}
                spellCheck={false}
                aria-label={`Rename ${labelFor(part)}`}
                onFocus={(event) => event.currentTarget.select()}
                onBlur={(event) => {
                  setRenaming(null);
                  if (cancelled.current) return void (cancelled.current = false);
                  const next = event.currentTarget.value.trim();
                  // An empty box means "no name", which the placeholder already
                  // says — writing it would be a rename to the shape's label.
                  if (next && next !== part.name) onRename(path, next);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    event.currentTarget.blur();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelled.current = true;
                    event.currentTarget.blur();
                  }
                }}
              />
            </div>
          );

        return (
          <button
            key={key}
            ref={hold(key)}
            type="button"
            role="treeitem"
            className="outliner-row"
            data-path={pathKey(path)}
            data-depth={depth}
            data-changed={changed?.has(pathKey(path)) ? 'true' : undefined}
            data-notes={open || undefined}
            data-hover={lit === key ? 'true' : undefined}
            aria-level={depth + 1}
            aria-selected={chosen === key}
            tabIndex={stop(key)}
            onClick={() =>
              onSelect(chosen === key ? null : { kind: 'part', path })
            }
            onDoubleClick={
              onRename ? () => setRenaming(key) : undefined
            }
            // Right-clicking a row selects it, the way it does in every tree —
            // and it is what tells the one shared menu which row it is on.
            onContextMenu={
              hasMenu
                ? () => {
                    setMenuOn(path);
                    onSelect({ kind: 'part', path });
                  }
                : undefined
            }
            onMouseEnter={() => onHover?.({ kind: 'part', path })}
            onMouseLeave={() => onHover?.(null)}
          >
            {depth > 0 && <ChevronRight size={11} aria-hidden="true" />}
            <span className="outliner-shape" title={part.shape}>
              {SHAPE_TAG[part.shape]}
            </span>
            <strong className="outliner-name">{labelFor(part)}</strong>
            {copies > 1 && (
              <Badge
                className="outliner-badge"
                variant="secondary"
                title={`Builds ${copies} meshes`}
              >
                ×{copies}
              </Badge>
            )}
            {part.rigPart && (
              <Badge
                className="outliner-badge"
                variant="outline"
                title={`Weighted to ${part.rigPart}`}
              >
                {part.rigPart}
              </Badge>
            )}
            {joint && (
              <Badge
                className="outliner-badge"
                variant="outline"
                title={`Carried by the joint ${joint}`}
              >
                {joint}
              </Badge>
            )}
            {open > 0 && (
              <Badge
                className="outliner-badge outliner-notes"
                variant="outline"
                title={`${open} open review note${open === 1 ? '' : 's'}`}
              >
                {`✎${open}`}
              </Badge>
            )}
          </button>
        );
      })}
        {bones &&
          skeleton.length > 0 && [
            <div className="outliner-heading" role="presentation" key="rig">
              Rig
            </div>,
            ...skeleton.map((bone) => {
              const key = `bone:${bone.name}`;
              const depth = depths.get(bone.name) ?? 0;
              return (
                <button
                  key={key}
                  ref={hold(key)}
                  type="button"
                  role="treeitem"
                  className="outliner-row outliner-bone"
                  data-bone={bone.name}
                  data-depth={depth}
                  data-hover={lit === key ? 'true' : undefined}
                  aria-level={depth + 1}
                  aria-selected={chosen === key}
                  tabIndex={stop(key)}
                  onClick={() =>
                    onSelect(
                      chosen === key ? null : { kind: 'bone', name: bone.name },
                    )
                  }
                  // A bone has no part path, so the shared menu has nothing to
                  // act on: clearing it is what makes the menu say so rather
                  // than offering the last part's actions on a skeleton row.
                  onContextMenu={hasMenu ? () => setMenuOn(null) : undefined}
                  onMouseEnter={() => onHover?.({ kind: 'bone', name: bone.name })}
                  onMouseLeave={() => onHover?.(null)}
                >
                  {depth > 0 && <ChevronRight size={11} aria-hidden="true" />}
                  <span className="outliner-shape" title="Bone">
                    bne
                  </span>
                  <strong className="outliner-name">{bone.name}</strong>
                </button>
              );
            }),
          ]}
    </div>
  );

  const onPath = menuOn;
  const menu: ReactNode = (
    <ContextMenuContent className="studio-menu">
      {onPath ? (
        <>
          <ContextMenuItem disabled={!onRename} onClick={() => setRenaming(`part:${pathKey(onPath)}`)}>
            Rename
            <span className="menu-key">dbl-click</span>
          </ContextMenuItem>
          <ContextMenuItem disabled={!onFrame} onClick={() => onFrame?.(onPath)}>
            Frame
            <span className="menu-key">F</span>
          </ContextMenuItem>
          <ContextMenuItem disabled={!onIsolate} onClick={() => onIsolate?.(onPath)}>
            Isolate
            <span className="menu-key">/</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!onDuplicate} onClick={() => onDuplicate?.(onPath)}>
            Duplicate
            <span className="menu-key">⌘D</span>
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!onDelete}
            variant="destructive"
            onClick={() => onDelete?.(onPath)}
          >
            Delete
            <span className="menu-key">⌫</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => {
              // Not every context has a clipboard — an insecure origin has
              // none — and failing to copy is not worth an exception.
              void navigator.clipboard?.writeText(pathKey(onPath)).catch(() => {});
            }}
          >
            Copy path
            <span className="menu-key">{pathKey(onPath)}</span>
          </ContextMenuItem>
        </>
      ) : (
        <ContextMenuItem disabled>Bones are edited in the rig panel</ContextMenuItem>
      )}
    </ContextMenuContent>
  );

  return (
    <div className="outliner">
      <div className="outliner-filter">
        <Input
          className="h-7"
          type="search"
          spellCheck={false}
          aria-label="Filter parts"
          placeholder="Filter parts"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      {hasMenu ? (
        // One menu for the whole tree rather than one per row: a spec with
        // sixty parts would otherwise mount sixty menu roots to show one.
        <ContextMenu>
          <ContextMenuTrigger className="outliner-menu-host">
            {tree}
          </ContextMenuTrigger>
          {menu}
        </ContextMenu>
      ) : (
        tree
      )}
      {!visible.length && (
        <p className="outliner-empty help">No part matches “{filter.trim()}”.</p>
      )}
    </div>
  );
}
