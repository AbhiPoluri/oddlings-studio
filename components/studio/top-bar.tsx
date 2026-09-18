'use client';
/**
 * The one strip that is always there: what this document is, where it came
 * from, and the four things you do to a whole document.
 *
 * Every button runs a command by id rather than calling a handler of its own,
 * so a button and its shortcut can never mean two different things, and a
 * disabled button is disabled for the same reason the palette greys the row.
 */
import { useEffect, useState } from 'react';
import {
  ChevronDown,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Redo2,
  Search,
  Undo2,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { canRedo, canSave, canUndo, isDirty } from './reducer';
import { COMMAND_BY_ID, runCommand, type ActionContext } from './actions';
import { useStudio } from './store';
import { useDocument } from './use-document';

/** A menu row that runs a registered command, greyed when it cannot run. */
function CommandItem({
  id,
  context,
  label,
}: {
  id: string;
  context: ActionContext;
  label?: string;
}) {
  const command = COMMAND_BY_ID.get(id);
  if (!command) return null;
  return (
    <DropdownMenuItem
      disabled={!command.enabled(context.state)}
      onClick={() => runCommand(id, context)}
    >
      {label ?? command.label}
    </DropdownMenuItem>
  );
}

function FollowPill({ context }: { context: ActionContext }) {
  const { state } = useStudio();
  const { follow } = state;
  const at = follow.lastBuildAt ? new Date(follow.lastBuildAt) : null;

  if (follow.status === 'live')
    return (
      <div className="follow-pill" data-state="live">
        <i className="follow-dot" aria-hidden="true" />
        <span className="follow-source" title={follow.source ?? ''}>
          {follow.source ?? 'the latest build'}
        </span>
        {follow.pinned && <em>pinned</em>}
        {at && !Number.isNaN(at.getTime()) && (
          <time dateTime={follow.lastBuildAt!}>{at.toLocaleTimeString()}</time>
        )}
        <button className="pill-button" onClick={() => runCommand('follow.detach', context)}>
          Stop
        </button>
      </div>
    );

  if (follow.status === 'waiting')
    return (
      <div className="follow-pill" data-state="waiting">
        <span>Waiting for a build…</span>
      </div>
    );

  return (
    <div className="follow-pill" data-state="off">
      <span>
        {follow.status === 'gaveup' ? 'No build found' : 'Detached — edits stay here'}
      </span>
      <button className="pill-button" onClick={() => runCommand('follow.attach', context)}>
        {follow.status === 'gaveup' ? 'Check again' : 'Follow'}
      </button>
    </div>
  );
}

/**
 * The asset's name, editable in place, written straight onto the document.
 *
 * The dot beside it is the whole unsaved story: this studio is the only place
 * an edit exists until Save writes it back to the file the agent reads, and
 * without a mark there is nothing on screen that distinguishes "reviewed and
 * written back" from "about to be lost".
 */
function NameField() {
  const { state } = useStudio();
  const { editSpec, editRecipe } = useDocument();
  const name = state.doc.spec?.name ?? state.doc.recipe.name;
  const [draft, setDraft] = useState<string | null>(null);
  const unsaved = isDirty(state);

  // A build that lands while the field is untouched must show the new name.
  useEffect(() => setDraft(null), [name]);

  function commit(value: string) {
    setDraft(null);
    const next = value.trim().slice(0, 60);
    if (!next || next === name) return;
    if (state.doc.spec) editSpec({ ...state.doc.spec, name: next });
    else editRecipe({ ...state.doc.recipe, name: next });
  }

  return (
    <span className="asset-identity">
      <input
        className="asset-name"
        aria-label="Asset name"
        spellCheck={false}
        maxLength={60}
        value={draft ?? name}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          else if (event.key === 'Escape') {
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
      />
      {unsaved && (
        <i
          className="unsaved-dot"
          role="img"
          aria-label="Unsaved changes"
          title="Edited since the last build or save. ⌘S writes it back to the followed file."
        />
      )}
    </span>
  );
}

export function TopBar({ context }: { context: ActionContext }) {
  const { state, dispatch } = useStudio();
  const layout = state.layout;

  return (
    <header className="top-bar">
      <span className="mark" aria-label="Oddlings Studio">
        ODDLINGS
      </span>
      <NameField />
      <FollowPill context={context} />

      <div className="bar-group" role="group" aria-label="History">
        <button
          className="bar-icon"
          aria-label="Undo"
          title="Undo (⌘Z)"
          disabled={!canUndo(state)}
          onClick={() => runCommand('edit.undo', context)}
        >
          <Undo2 size={14} />
        </button>
        <button
          className="bar-icon"
          aria-label="Redo"
          title="Redo (⇧⌘Z)"
          disabled={!canRedo(state)}
          onClick={() => runCommand('edit.redo', context)}
        >
          <Redo2 size={14} />
        </button>
      </div>

      <button
        className="bar-button primary"
        disabled={!canSave(state)}
        title={
          canSave(state)
            ? `Write this spec back to ${state.follow.source} (⌘S)`
            : 'Nothing to save: this document is not an edited spec from a followed file.'
        }
        onClick={() => runCommand('file.save', context)}
      >
        Save
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger className="bar-button">
          Export <ChevronDown size={12} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="studio-menu">
          <CommandItem id="file.export.glb" context={context} label="GLB" />
          <CommandItem id="file.export.obj" context={context} label="OBJ + MTL" />
          <CommandItem id="file.export.unity" context={context} label="Unity zip" />
          <DropdownMenuSeparator />
          <CommandItem id="file.export.json" context={context} label="Spec JSON" />
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger className="bar-button">
          New <ChevronDown size={12} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="studio-menu">
          <CommandItem id="file.new.empty" context={context} label="Empty spec" />
          <CommandItem id="file.new.blueprint" context={context} label="From blueprint…" />
          <DropdownMenuSeparator />
          <CommandItem id="file.new.import" context={context} label="Import file…" />
          <CommandItem id="file.new.url" context={context} label="Open URL…" />
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        className="bar-button"
        title="Command palette (⌘K)"
        onClick={() => runCommand('palette.open', context)}
      >
        <Search size={12} /> <kbd>⌘K</kbd>
      </button>

      <div className="bar-group" role="group" aria-label="Panels">
        <button
          className="bar-icon"
          aria-label="Toggle the left column"
          aria-pressed={layout.leftOpen}
          title="Left column (⌘B)"
          onClick={() => runCommand('panel.left', context)}
        >
          <PanelLeft size={14} />
        </button>
        <button
          className="bar-icon"
          aria-label="Toggle the bottom dock"
          aria-pressed={layout.dockOpen}
          title="Bottom dock (⌘J)"
          onClick={() => runCommand('panel.dock', context)}
        >
          <PanelBottom size={14} />
        </button>
        <button
          className="bar-icon"
          aria-label="Toggle the right column"
          aria-pressed={layout.rightOpen}
          title="Right column (⌘I)"
          onClick={() =>
            dispatch({ type: 'layout', patch: { rightOpen: !layout.rightOpen } })
          }
        >
          <PanelRight size={14} />
        </button>
      </div>
    </header>
  );
}
