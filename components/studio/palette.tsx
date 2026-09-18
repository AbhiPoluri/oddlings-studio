'use client';
/**
 * ⌘K over the action table.
 *
 * Nothing here decides what the studio can do — it reads `COMMANDS`, which is
 * also what the keymap and the menus read. Adding an operation therefore adds
 * it here, with its shortcut, without anyone remembering to.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import { COMMANDS, runCommand, type ActionContext } from './actions';
import { chordLabel } from './keymap';
import { useStudio } from './store';

export function CommandPalette({ context }: { context: ActionContext }) {
  const { state, dispatch } = useStudio();
  // Read after mount: the server has no platform to report, and a guess that
  // disagrees with the browser is a hydration mismatch over a ⌘ glyph.
  const [apple, setApple] = useState(true);
  useEffect(() => {
    setApple(/Mac|iPhone|iPad/.test(navigator.userAgent));
  }, []);

  const groups = useMemo(() => {
    const byGroup = new Map<string, typeof COMMANDS>();
    for (const command of COMMANDS)
      byGroup.set(command.group, [...(byGroup.get(command.group) ?? []), command]);
    return [...byGroup];
  }, []);

  return (
    <CommandDialog
      open={state.palette}
      onOpenChange={(open) => dispatch({ type: 'palette', open })}
      className="studio-palette"
      title="Command palette"
      description="Search every studio action by name."
    >
      <Command loop>
        <CommandInput placeholder="Run a command…" />
        <CommandList>
          <CommandEmpty>No command matches.</CommandEmpty>
          {groups.map(([group, commands]) => (
            <CommandGroup key={group} heading={group}>
              {commands.map((command) => {
                const enabled = command.enabled(state);
                return (
                  <CommandItem
                    key={command.id}
                    // Searched text: the label plus the id, so "frame" and
                    // "view.frameAll" both find the same row.
                    value={`${command.label} ${command.group} ${command.id}`}
                    disabled={!enabled}
                    onSelect={() => {
                      dispatch({ type: 'palette', open: false });
                      runCommand(command.id, context);
                    }}
                  >
                    <span>{command.label}</span>
                    {command.keys?.[0] && (
                      <CommandShortcut>
                        {chordLabel(command.keys[0], apple)}
                      </CommandShortcut>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
