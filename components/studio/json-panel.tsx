'use client';
/**
 * The spec itself, as text.
 *
 * Every other panel is a view of one part of the document, which is what makes
 * them good for adjusting something and poor for the two things a reviewer of
 * generated specs actually does most: reading the whole thing at once, and
 * pasting a corrected block back in. This is the escape hatch — and it is a
 * real one, because Apply goes through `parseSpec` and the same `editSpec` path
 * as a slider drag, so a hand-typed spec is exactly as checked as a dragged one
 * and costs exactly one undo step.
 */
import { useMemo, useRef, useState } from 'react';
import { Check, ClipboardCopy, RotateCcw } from 'lucide-react';
import { parseSpec, type AssetSpec } from '@/lib/asset-spec';

/** A character offset into the text, as the line and column a textarea shows. */
function placeAt(text: string, offset: number) {
  const before = text.slice(0, Math.max(0, Math.min(text.length, offset))).split('\n');
  return { line: before.length, column: before[before.length - 1].length + 1 };
}

/**
 * Where V8 put the error, for the message shape that refuses to say.
 *
 * Since 2023 V8 reports `Unexpected token 'p', ..."…snippet…" is not valid
 * JSON` — no position, no line, just a quoted slice of the source. That is the
 * shape current Chrome throws, so ignoring it would mean the line number never
 * appeared in the browser this studio actually runs in. The snippet is found in
 * the text, and the offending token found within the snippet.
 */
function snippetOffset(message: string, text: string): number | null {
  if (!/is not valid JSON\s*$/.test(message)) return null;
  const open = message.indexOf('"');
  const close = message.lastIndexOf('"');
  if (open < 0 || close <= open) return null;
  const snippet = message.slice(open + 1, close);
  const at = snippet ? text.indexOf(snippet) : -1;
  if (at < 0) return null;
  // The snippet starts before the problem; the named token is the problem.
  const token = /Unexpected token '(.)'/.exec(message)?.[1];
  const within = token ? snippet.indexOf(token) : -1;
  return within < 0 ? at : at + within;
}

/**
 * Where a JSON syntax error is, as a line and column.
 *
 * Engines disagree about how to say it three different ways: Firefox gives a
 * line and column, older V8 gives `position N`, and current V8 gives neither.
 * Counting newlines is the one answer that holds for all of them, because a
 * character offset is useless to someone looking at a textarea.
 */
export function jsonErrorPlace(
  message: string,
  text: string,
): { line: number; column: number } | null {
  const named = /line (\d+) column (\d+)/i.exec(message);
  if (named) return { line: Number(named[1]), column: Number(named[2]) };
  const offset = /position (\d+)/i.exec(message);
  if (offset) return placeAt(text, Number(offset[1]));
  const snippet = snippetOffset(message, text);
  return snippet === null ? null : placeAt(text, snippet);
}

/** One line a person can act on, from whatever the parser threw. */
export function explain(error: unknown, text: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof SyntaxError)) return message;
  const place = jsonErrorPlace(message, text);
  const tidy = message
    // The engine's own offset is noise once the line is known, and the quoted
    // snippet is a copy of a line the author is already looking at — complete
    // with the newlines that would wrap this message over three rows.
    .replace(/\s*\(?(?:at\s+)?position \d+\)?/i, '')
    .replace(/\s*\(line \d+ column \d+\)/i, '')
    // `[\s\S]` rather than `.` with the `s` flag: the snippet spans newlines,
    // and this file compiles to ES2017, where that flag does not exist.
    .replace(/,?\s*(?:\.\.\.)?"[\s\S]*"(?:\.\.\.)?\s*is not valid JSON\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const said = tidy || 'That is not valid JSON.';
  return place ? `Line ${place.line}, column ${place.column}: ${said}` : said;
}

export function JsonPanel({
  spec,
  onApply,
  onStatus,
}: {
  spec: AssetSpec;
  /** Commits a parsed spec: one undo step, and the follow detaches. */
  onApply: (next: AssetSpec) => void;
  onStatus: (message: string) => void;
}) {
  /**
   * The text being typed, or null when the box is showing the document.
   *
   * Null rather than a separate `dirty` flag, because it is the same fact: a
   * build landing while someone is mid-edit must not overwrite what they typed,
   * and a box that is not being typed into must follow the document. One piece
   * of state cannot disagree with itself about which of those is happening.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement | null>(null);

  const canonical = useMemo(() => JSON.stringify(spec, null, 2), [spec]);
  const text = draft ?? canonical;
  const dirty = draft !== null && draft !== canonical;

  function apply() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      const message = explain(error, text);
      setProblem(message);
      return onStatus(message);
    }
    try {
      const next = parseSpec(parsed);
      setProblem(null);
      // Back to following the document, which is now what was typed — modulo
      // the defaults the schema filled in, which the box should show.
      setDraft(null);
      onApply(next);
      onStatus('Spec JSON applied. One undo step; the studio has stopped following.');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'That is not a valid spec.';
      setProblem(message);
      onStatus(message);
    }
  }

  return (
    <div className="json-panel">
      <div className="json-actions">
        <button
          className="bar-button primary"
          disabled={!dirty}
          title="Parse and commit this text (⌘↵)"
          onClick={apply}
        >
          <Check size={12} /> Apply
        </button>
        <button
          className="bar-button"
          title="Copy the whole spec to the clipboard"
          onClick={() => {
            // An insecure origin has no clipboard; failing to copy is not worth
            // an exception in the console.
            void navigator.clipboard
              ?.writeText(text)
              .then(() => onStatus('Spec JSON copied.'))
              .catch(() => onStatus('This browser would not let the studio copy.'));
          }}
        >
          <ClipboardCopy size={12} /> Copy
        </button>
        <button
          className="bar-button"
          disabled={draft === null}
          title="Throw away these edits and show the document again"
          onClick={() => {
            setDraft(null);
            setProblem(null);
            onStatus('Reverted to the document on screen.');
          }}
        >
          <RotateCcw size={12} /> Reset
        </button>
        {dirty && <span className="json-dirty">edited</span>}
      </div>
      <textarea
        ref={box}
        className="json-text"
        spellCheck={false}
        aria-label="Spec JSON"
        aria-invalid={problem ? true : undefined}
        value={text}
        onChange={(event) => {
          setDraft(event.target.value);
          // Stale after the first keystroke, and a red box under a line the
          // author has already fixed is worse than no message at all.
          if (problem) setProblem(null);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            apply();
          }
        }}
      />
      {problem ? (
        <p className="json-error" role="alert">
          {problem}
        </p>
      ) : (
        <p className="help">
          Editing here is the same as editing anywhere else in the studio: Apply
          validates against the schema, costs one undo step, and stops the page
          following the file.
        </p>
      )}
    </div>
  );
}
