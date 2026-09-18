'use client';
/**
 * Everything that changes the document, in one hook.
 *
 * The viewport, the outliner, the property panel, the palette and the file
 * pickers all edit the same document, and each of them used to carry its own
 * copy of "try it, catch the schema error, put the message in the status line".
 * They call these instead, so an invalid edit reads the same however it was
 * made.
 */
import { useCallback } from 'react';
import { parseRecipe, type Recipe } from '@/lib/asset-recipe';
import { parseSpec, type AssetSpec } from '@/lib/asset-spec';
import {
  deletePart,
  duplicatePart,
  moveBone,
  removeJoint,
  updatePart,
  type Path,
  type PartPatch,
  type Vec3,
} from '@/lib/spec-edit';
import type { Doc, Origin } from './reducer';
import { useStudio } from './store';
import { useToaster } from './toasts';

/**
 * Turn an unknown parsed payload into a document.
 *
 * A spec and a recipe are told apart the same way everywhere — a `parts` array
 * — because the pointer, a `?spec=` file, a picked file and a pasted URL all
 * arrive as bare JSON with nothing to say which they are.
 */
export function docFrom(parsed: unknown, recipe: Recipe, origin: Origin): Doc {
  const isSpec =
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { parts?: unknown }).parts);
  if (isSpec) return { recipe, spec: parseSpec(parsed), origin };
  return { recipe: parseRecipe(parsed), spec: null, origin };
}

export function useDocument() {
  const { state, dispatch, ref } = useStudio();
  const say = useToaster();

  const status = useCallback(
    (text: string) => dispatch({ type: 'status', text }),
    [dispatch],
  );

  /**
   * An edit the schema refused, said twice on purpose.
   *
   * The status line is where the studio's running commentary goes and it is
   * overwritten by the next thing to happen — which for a rejected edit is
   * usually the next mouse move. A refusal is the one message here that is
   * worth keeping on screen until it has been read.
   */
  const fail = useCallback(
    (error: unknown, fallback: string) => {
      const text = error instanceof Error ? error.message : fallback;
      status(text);
      say(text, { tone: 'bad' });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status],
  );

  /** Live spec edits during a drag; only `record` pushes an undo step. */
  const editSpec = useCallback(
    (next: AssetSpec, record = true) => {
      const doc: Doc = { recipe: ref.current.doc.recipe, spec: next, origin: 'human' };
      // Detaching happens inside the reducer, on the first frame of a drag
      // rather than on release: a poll landing mid-drag would otherwise reload
      // the file over what is being dragged.
      dispatch(record ? { type: 'commit', doc } : { type: 'live', doc });
    },
    [dispatch, ref],
  );

  const editRecipe = useCallback(
    (next: Recipe, record = true) => {
      const doc: Doc = { recipe: next, spec: null, origin: 'human' };
      dispatch(record ? { type: 'commit', doc } : { type: 'live', doc });
    },
    [dispatch],
  );

  /**
   * One finished gizmo drag, as one undo step.
   *
   * The viewport never writes the spec while a drag runs — it moves a proxy and
   * hands the whole drag over as a single patch, so a rebuild of a thousand
   * meshes and a history entry happen once per drag rather than once per move.
   */
  const transformPart = useCallback(
    (path: Path, patch: PartPatch) => {
      const spec = ref.current.doc.spec;
      if (!spec) return;
      try {
        editSpec(updatePart(spec, path, patch));
      } catch (error) {
        fail(error, 'That edit is invalid.');
      }
    },
    [editSpec, fail, ref],
  );

  /** `moveBone` works out which rig it is writing to, so the viewport needn't. */
  const moveBoneTo = useCallback(
    (name: string, at: Vec3) => {
      const spec = ref.current.doc.spec;
      if (!spec) return;
      try {
        editSpec(moveBone(spec, name, at));
      } catch (error) {
        fail(error, 'That bone cannot be moved.');
      }
    },
    [editSpec, fail, ref],
  );

  const removeSelected = useCallback(() => {
    const { doc, selection } = ref.current;
    if (!doc.spec || !selection) return;
    if (selection.kind === 'bone') {
      // The body rig always has all 14 bones: there is no spec for a body
      // missing a shin, and the reset in the rig panel is what undoes an edit.
      if (doc.spec.rig)
        return status(
          'A body rig always has its 14 bones. Reset the bone in the rig panel instead.',
        );
      const index =
        doc.spec.joints?.findIndex((joint) => joint.name === selection.name) ?? -1;
      if (index < 0)
        return status('Root is the static bone a joints rig hangs off.');
      try {
        editSpec(removeJoint(doc.spec, index));
        dispatch({ type: 'select', selection: null });
        status(`Joint “${selection.name}” removed. Undo brings it back.`);
      } catch (error) {
        fail(error, 'Cannot delete.');
      }
      return;
    }
    try {
      editSpec(deletePart(doc.spec, selection.path));
      dispatch({ type: 'select', selection: null });
      status('Part removed. Undo brings it back.');
    } catch (error) {
      fail(error, 'Cannot delete.');
    }
  }, [dispatch, editSpec, fail, ref, status]);

  const duplicateSelected = useCallback(() => {
    const { doc, selection } = ref.current;
    if (!doc.spec || selection?.kind !== 'part') return;
    try {
      const result = duplicatePart(doc.spec, selection.path);
      editSpec(result.spec);
      dispatch({ type: 'select', selection: { kind: 'part', path: result.path } });
      status('Part duplicated.');
    } catch (error) {
      fail(error, 'Cannot duplicate.');
    }
  }, [dispatch, editSpec, fail, ref, status]);

  /** Put a parsed recipe or spec on screen as one undoable step. */
  const load = useCallback(
    (parsed: unknown, origin: Origin, note: string) => {
      try {
        const doc = docFrom(parsed, ref.current.doc.recipe, origin);
        dispatch({
          type: 'commit',
          doc,
          status: note.replace('%s', doc.spec?.name ?? doc.recipe.name),
        });
        dispatch({ type: 'select', selection: null });
      } catch (error) {
        fail(error, 'Could not read that file.');
      }
    },
    [dispatch, fail, ref],
  );

  return {
    state,
    dispatch,
    status,
    editSpec,
    editRecipe,
    transformPart,
    moveBoneTo,
    removeSelected,
    duplicateSelected,
    load,
  };
}
