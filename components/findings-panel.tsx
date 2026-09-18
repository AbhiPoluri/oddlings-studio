'use client';
import type { Audit, Severity } from '@/lib/asset-audit';
import { pathKey } from '@/lib/spec-edit';

/**
 * What the checks found, as a place to work from rather than a report to read.
 *
 * Every finding that names a part is a button that selects it and frames it, so
 * the loop is click, look, fix, re-check. A list you cannot click is a list that
 * gets skimmed once — which is the failure `asset-audit` designs against from
 * the other end, by refusing to report anything not worth acting on.
 */

const MARK: Record<Severity, string> = { error: '✗', warn: '!', info: '·' };
const HEADING: Record<Severity, string> = {
  error: 'Errors',
  warn: 'Warnings',
  info: 'Notes',
};
const ORDER: Severity[] = ['error', 'warn', 'info'];

const plural = (count: number, one: string) =>
  `${count} ${one}${count === 1 ? '' : 's'}`;

export function FindingsPanel({
  audit,
  labels,
  onSelectPart,
  onFrame,
}: {
  /** Null while there is no spec to check — the panel says so rather than lying. */
  audit: Audit | null;
  /** Part path keys (`"11.0"`) to readable names, as `auditModel` takes them. */
  labels?: Map<string, string>;
  onSelectPart?: (path: number[]) => void;
  /** Called with the same path, so one click both selects and frames. */
  onFrame?: (path: number[]) => void;
}) {
  if (!audit)
    return (
      <div className="findings">
        <p className="findings-empty help">
          Nothing to check yet. Load or generate a spec and the checks run on
          every build.
        </p>
      </div>
    );

  const counts = {
    error: audit.findings.filter((f) => f.severity === 'error').length,
    warn: audit.findings.filter((f) => f.severity === 'warn').length,
    info: audit.findings.filter((f) => f.severity === 'info').length,
  };
  const summary = [
    audit.ok ? 'passes' : null,
    counts.error ? plural(counts.error, 'error') : null,
    counts.warn ? plural(counts.warn, 'warning') : null,
    counts.info ? plural(counts.info, 'note') : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="findings">
      {/* `output` carries an implicit live region, so a re-check speaks the
          new tally without the reader having to go looking for it. */}
      <output className={`findings-summary ${audit.ok ? 'audit-pass' : 'audit-fail'}`}>
        {summary}
      </output>
      {ORDER.filter((severity) => counts[severity]).map((severity) => (
        <div className="findings-group" key={severity} data-severity={severity}>
          <h4 className="findings-heading">
            {HEADING[severity]} <span>{counts[severity]}</span>
          </h4>
          {audit.findings
            .map((finding, index) => ({ finding, index }))
            .filter((row) => row.finding.severity === severity)
            .map(({ finding, index }) => {
              const label = finding.part
                ? (labels?.get(pathKey(finding.part)) ?? pathKey(finding.part))
                : null;
              return (
                <button
                  key={`${finding.code}-${index}`}
                  type="button"
                  className={`findings-row audit-${finding.severity}`}
                  data-code={finding.code}
                  disabled={!finding.part}
                  onClick={() => {
                    if (!finding.part) return;
                    onSelectPart?.(finding.part);
                    onFrame?.(finding.part);
                  }}
                >
                  <i className="findings-mark" aria-hidden="true">
                    {MARK[finding.severity]}
                  </i>
                  <span className="findings-message">{finding.message}</span>
                  {label && <span className="findings-part">{label}</span>}
                </button>
              );
            })}
        </div>
      ))}
    </div>
  );
}
