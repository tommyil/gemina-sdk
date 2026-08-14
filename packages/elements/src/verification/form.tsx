/**
 * Verification form — field primitives (Task 12).
 *
 * Port of the console's `FieldValue.tsx` through the house-style
 * transformation table: antd `<Tooltip>` becomes a native `title` attribute
 * paired with an aria-label, `@ant-design/icons` becomes the hand-drawn
 * `IconEye`, SCSS-module classes become the Task 6 `.gemina-verification__*`
 * contract classes, and NO inline colors — every visual state is a class
 * driven by the theme tokens.
 *
 * Accessibility contract (load-bearing, not decorative):
 * - The confidence dot is a color-only signal, so it always carries
 *   `role="img"` + a text `aria-label` and a `title` tooltip listing the
 *   formatted reasons (WCAG 1.4.1 / 1.4.11).
 * - The dirty state pairs the `--dirty` border color with a visible "edited"
 *   text badge, linked to the input via `aria-describedby`. When a missed
 *   field is filled in, `--missed`'s error border wins the CSS cascade — the
 *   badge is then the ONLY visible dirty channel, which is why it is a word
 *   and not another color.
 *
 * Editing contract: dirtiness is exactly `edit !== undefined`. The PARENT
 * owns revert detection (it deletes the edits entry when the value returns to
 * the initial string) — nothing here compares against the initial value.
 *
 * Layout contract: FieldInput renders a FRAGMENT (input + "edited" badge) and
 * expects a flex-row container — `__dd`, `__cell`, and the simple-list items
 * provide it.
 *
 * Shape sections (Task 13): VerificationForm renders the classifier's buckets
 * in the CONSOLE's section order (FormView/index.tsx): Details (headers +
 * simple lists), entity cards, tables, fallback — then the SDK-only
 * "Not detected" section for bindings that matched no rendered field.
 */
import React from 'react';
import type { FieldBinding } from './bindings';
import { toInputString } from './bindings';
import type { ClassifiedCell, ClassifiedData, ClassifiedField } from './classify';
import { ROW_META_KEY, formatLabel, formatValue } from './classify';
import { NOT_FOUND } from './pointer';
import { Tip } from './tip';
import { IconEye } from './viewer';

/** Colored dot + native tooltip. Absent (or blank-level) confidence renders nothing. */
export function ConfidenceDot(props: {
  confidence: { level: string; reasons: string[] } | null;
}): React.JSX.Element | null {
  const { confidence } = props;
  if (!confidence?.level) {
    return null;
  }

  let variant: 'high' | 'medium' | 'low' | 'unknown';
  let label: string;
  switch (confidence.level.toLowerCase()) {
    case 'high':
      variant = 'high';
      label = 'High confidence';
      break;
    case 'medium':
      variant = 'medium';
      label = 'Medium confidence';
      break;
    case 'low':
      variant = 'low';
      label = 'Low confidence';
      break;
    default:
      variant = 'unknown';
      label = `${confidence.level} confidence`;
  }

  const reasons = confidence.reasons.map(formatLabel);
  // The reasons must reach AT (and the keyboard) regardless of the tooltip, so
  // the accessible NAME carries them: "Low confidence: Blurry Region, Low OCR
  // Quality". One string, no extra DOM. The tip is the SIGHTED channel for the
  // same facts — hence `aria-describedby` is all Tip adds, and the name is
  // left alone so nothing is announced twice.
  const ariaLabel = reasons.length > 0 ? `${label}: ${reasons.join(', ')}` : label;
  // A heading over a list — the shape `title=` could never express, and the
  // reason this component exists. Matches the console's FieldValue treatment.
  const tip = (
    <>
      <strong className="gemina-verification__tip-title">{label}</strong>
      {reasons.length > 0 ? (
        <ul className="gemina-verification__tip-list">
          {reasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      ) : null}
    </>
  );
  return (
    <Tip content={tip}>
      <span
        className={`gemina-verification__dot gemina-verification__dot--${variant}`}
        role="img"
        aria-label={ariaLabel}
      />
    </Tip>
  );
}

/** Eye button that flashes the field's rects on the document. */
export function EyeButton(props: {
  coordinates: { points: [number, number][] } | null;
  onFlash: () => void;
}): React.JSX.Element | null {
  const { coordinates, onFlash } = props;
  if (!coordinates) {
    return null;
  }
  return (
    <Tip content="Show on document">
      <button
        type="button"
        className="gemina-verification__eye"
        aria-label="Show on document"
        onClick={(event) => {
          // Rows use click-to-flash (Task 13); the field eye must not double-fire it.
          event.stopPropagation();
          onFlash();
        }}
      >
        <IconEye />
      </button>
    </Tip>
  );
}

/** One editable field: input prefilled with the RAW value, dirty + missed states. */
export function FieldInput(props: {
  binding: FieldBinding;
  /** Current value if dirty, else undefined (input falls back to initial). */
  edit: string | undefined;
  /** Parent deletes the edits entry when value returns to the initial string. */
  onEdit: (rawKey: string, value: string) => void;
  readOnly: boolean;
  /** formatLabel(label) — the visible label lives in the surrounding layout. */
  ariaLabel: string;
}): React.JSX.Element {
  const { binding, edit, onEdit, readOnly, ariaLabel } = props;
  const editedBadgeId = React.useId();

  // Container serverValues (value-object wrappers, arrays, objects) can never
  // score correct from a string edit — the server's coerce_like only adopts
  // types for scalar targets — so they render read-only (C1/C2 amendment).
  // NOTE: this branch deliberately DISCARDS `edit` and shows the extracted
  // value — correct for the 409 already-validated path. Task 17: keep
  // submit-in-progress as disabled buttons, NOT a readOnly flip, or the
  // user's pending edits would visually vanish mid-submit.
  if (readOnly || !binding.editable) {
    const display = binding.extracted === NOT_FOUND ? null : binding.extracted;
    return <span>{formatValue(display, binding.key.label)}</span>;
  }

  const dirty = edit !== undefined;
  const missed = binding.serverValue === NOT_FOUND;
  const className = [
    'gemina-verification__input',
    dirty ? 'gemina-verification__input--dirty' : '',
    missed ? 'gemina-verification__input--missed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <input
        type="text"
        className={className}
        // Per-input bidi: a Latin value inside an RTL (Hebrew) document — or
        // vice versa — must lay out by its own content, not the widget's dir.
        dir="auto"
        // RAW value only — a display-formatted "1,500" round-tripped into the
        // submission would score as a correction (see toInputString).
        value={dirty ? edit : toInputString(binding.extracted)}
        onChange={(event) => onEdit(binding.key.raw, event.target.value)}
        placeholder={missed ? 'Not detected — fill in if present' : undefined}
        aria-label={ariaLabel}
        aria-describedby={dirty ? editedBadgeId : undefined}
        autoComplete="off"
      />
      {dirty ? (
        // The badge is where the ORIGINAL belongs, now that the input holds
        // the edit — otherwise the extracted value is simply gone from the
        // screen the moment someone corrects it.
        //
        // Known limit: the badge is a non-focusable span, so this channel is
        // hover-only. AT is not worse off than before (nothing carried the
        // original previously), and the input's aria-describedby still names
        // the field as edited. Giving it a keyboard path needs a focusable
        // affordance, which belongs with the Phase 8 row work, not here.
        <Tip
          content={
            <>
              <span className="gemina-verification__tip-label">Was: </span>
              {formatValue(binding.extracted === NOT_FOUND ? null : binding.extracted,
                binding.key.label)}
            </>
          }
        >
          <span className="gemina-verification__edited" id={editedBadgeId}>
            edited
          </span>
        </Tip>
      ) : null}
    </>
  );
}

// --- Shape sections (Task 13) ------------------------------------------------

interface FlashRect {
  points: [number, number][];
}

/** State + callbacks every section threads down to its fields.
 *
 * STABILITY CONTRACT (callers, i.e. Task 14): `onEdit`, `onFlash`, and
 * `bindingIndex` MUST be referentially stable across renders (useCallback /
 * useMemo) — the table-row memo compares them by reference, so an unstable
 * handler silently degrades every row bail-out to a full re-render. `edits`
 * MUST be replaced immutably on every change, never mutated in place: the
 * comparator short-circuits on `prevEdits === nextEdits`, so an in-place
 * mutation renders no update at all. */
interface SectionShared {
  bindingIndex: Map<string, FieldBinding>;
  edits: ReadonlyMap<string, string>;
  onEdit: (rawKey: string, value: string) => void;
  readOnly: boolean;
  onFlash: (rects: FlashRect[]) => void;
}

/** Props for the whole form pane.
 *
 * The SectionShared stability contract applies (see above), and `classified`
 * must be the memoized product of one `classifyData` call — a fresh object
 * per render defeats both the row memo and the fallback-section memo. */
export interface VerificationFormProps extends SectionShared {
  classified: ClassifiedData;
  /** Bindings whose pointer matched NO rendered field — the "model missed the
   *  whole field" case; rendered as an extra "Not detected" section of empty inputs. */
  unmatched: FieldBinding[];
}

/** True when the click started on an interactive element — row click-to-flash
 * must never hijack typing, button presses, or link follows. */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('input, button, a, select, textarea') !== null;
}

/** One label/value pair inside a description list (headers + entity cards). */
function FieldPair(props: {
  label: string;
  ariaLabel: string;
  cell: ClassifiedCell | ClassifiedField;
  shared: SectionShared;
}): React.JSX.Element {
  const { label, ariaLabel, cell, shared } = props;
  const binding = shared.bindingIndex.get(cell.pointer);
  return (
    <>
      <dt className="gemina-verification__dt">
        <ConfidenceDot confidence={cell.confidence} />
        <span>{label}</span>
      </dt>
      <dd className="gemina-verification__dd">
        {binding !== undefined ? (
          <FieldInput
            binding={binding}
            edit={shared.edits.get(binding.key.raw)}
            onEdit={shared.onEdit}
            readOnly={shared.readOnly}
            ariaLabel={ariaLabel}
          />
        ) : (
          <span>{formatValue(cell.value, label)}</span>
        )}
        <EyeButton
          coordinates={cell.coordinates}
          onFlash={() => {
            if (cell.coordinates) {
              shared.onFlash([cell.coordinates]);
            }
          }}
        />
      </dd>
    </>
  );
}

/** "Details": header fields + simple lists in one description-list section. */
function HeaderSection(props: {
  headers: ClassifiedField[];
  simpleLists: ClassifiedData['simpleLists'];
  shared: SectionShared;
}): React.JSX.Element | null {
  const { headers, simpleLists, shared } = props;
  if (headers.length === 0 && simpleLists.length === 0) {
    return null;
  }
  return (
    <section className="gemina-verification__section" aria-label="Details">
      <div className="gemina-verification__section-header">Details</div>
      <dl className="gemina-verification__dl">
        {headers.map((field) => (
          <FieldPair
            key={field.pointer}
            label={formatLabel(field.key)}
            ariaLabel={formatLabel(field.key)}
            cell={field}
            shared={shared}
          />
        ))}
        {simpleLists.map((list) => (
          <React.Fragment key={list.pointer}>
            <dt className="gemina-verification__dt">
              <span>{formatLabel(list.key)}</span>
            </dt>
            <dd className="gemina-verification__dd">
              <ul className="gemina-verification__list">
                {list.items.map((item, index) => {
                  const binding = shared.bindingIndex.get(item.pointer);
                  return (
                    <li key={item.pointer} className="gemina-verification__cell">
                      {binding !== undefined ? (
                        <FieldInput
                          binding={binding}
                          edit={shared.edits.get(binding.key.raw)}
                          onEdit={shared.onEdit}
                          readOnly={shared.readOnly}
                          ariaLabel={`${formatLabel(list.key)} item ${index + 1}`}
                        />
                      ) : (
                        <span>{formatValue(item.value)}</span>
                      )}
                      <ConfidenceDot confidence={item.confidence} />
                      <EyeButton
                        coordinates={item.coordinates}
                        onFlash={() => {
                          if (item.coordinates) {
                            shared.onFlash([item.coordinates]);
                          }
                        }}
                      />
                    </li>
                  );
                })}
              </ul>
            </dd>
          </React.Fragment>
        ))}
      </dl>
    </section>
  );
}

/** Entity bucket: one card per item, headers singularized console-style. */
function EntitySection(props: {
  entity: ClassifiedData['entities'][number];
  shared: SectionShared;
}): React.JSX.Element {
  const { entity, shared } = props;
  const label = formatLabel(entity.key);
  // The console's naive strip-trailing-s, ported verbatim ("Suppliers" →
  // "Supplier"; yes, "Parties" → "Partie" — console parity over grammar).
  const singular = label.replace(/s$/, '');
  return (
    <section className="gemina-verification__section" aria-label={label}>
      <div className="gemina-verification__section-header">
        {label} ({entity.items.length})
      </div>
      <div className="gemina-verification__section-body">
        {entity.items.map((item, itemIndex) => (
          <div key={itemIndex} className="gemina-verification__card">
            <div className="gemina-verification__card-header">
              {singular} {itemIndex + 1}
            </div>
            <dl className="gemina-verification__dl">
              {Object.entries(item).map(([fieldKey, cell]) => (
                <FieldPair
                  key={fieldKey}
                  label={formatLabel(fieldKey)}
                  // Card context: two "Supplier" cards both announcing a bare
                  // "Name" would be ambiguous to a screen reader.
                  ariaLabel={`${singular} ${itemIndex + 1} — ${formatLabel(fieldKey)}`}
                  cell={cell}
                  shared={shared}
                />
              ))}
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}

interface TableRowViewProps {
  row: Record<string, ClassifiedCell>;
  rowIndex: number;
  columns: string[];
  /** formatLabel(tableKey), precomputed once per table. */
  tableLabel: string;
  hasCoords: boolean;
  hasRowConfidence: boolean;
  shared: SectionShared;
}

function TableRowView(props: TableRowViewProps): React.JSX.Element {
  const { row, rowIndex, columns, tableLabel, hasCoords, hasRowConfidence, shared } = props;
  const { bindingIndex, edits, onEdit, readOnly, onFlash } = shared;

  const rects = React.useMemo(() => {
    const collected: FlashRect[] = [];
    for (const [key, cell] of Object.entries(row)) {
      if (key !== ROW_META_KEY && cell.coordinates) {
        collected.push(cell.coordinates);
      }
    }
    return collected;
  }, [row]);

  const handleRowClick = React.useCallback(
    (event: React.MouseEvent<HTMLTableRowElement>) => {
      if (isInteractiveTarget(event.target)) {
        return;
      }
      if (rects.length > 0) {
        onFlash(rects);
      }
    },
    [rects, onFlash],
  );

  const firstRect = rects.length > 0 ? rects[0]! : null;
  return (
    <tr onClick={handleRowClick}>
      {hasCoords ? (
        <td>
          {/* EyeButton's coordinates prop is only the render gate here — the
              click flashes ALL the row's rects, console DataTable style. */}
          <EyeButton coordinates={firstRect} onFlash={() => onFlash(rects)} />
        </td>
      ) : null}
      {hasRowConfidence ? (
        <td>
          <ConfidenceDot confidence={row[ROW_META_KEY]?.confidence ?? null} />
        </td>
      ) : null}
      {columns.map((column) => {
        const cell = row[column];
        const binding = cell === undefined ? undefined : bindingIndex.get(cell.pointer);
        return (
          <td key={column}>
            <div className="gemina-verification__cell">
              {binding !== undefined ? (
                <FieldInput
                  binding={binding}
                  edit={edits.get(binding.key.raw)}
                  onEdit={onEdit}
                  readOnly={readOnly}
                  ariaLabel={`${tableLabel} row ${rowIndex + 1} — ${formatLabel(column)}`}
                />
              ) : (
                <span>{cell === undefined ? '-' : formatValue(cell.value, column)}</span>
              )}
              <ConfidenceDot confidence={cell?.confidence ?? null} />
            </div>
          </td>
        );
      })}
    </tr>
  );
}

/** Bail out unless THIS row's data or its slice of the edits changed. The
 * comparator inspects only edits for bindings on this row's cells, so one
 * keystroke re-renders one row. Callbacks are compared by reference: the
 * parent must pass referentially stable `onEdit`/`onFlash` (and a stable
 * `classified`/`bindingIndex`) or the memoization degrades to plain renders. */
function areRowPropsEqual(prev: TableRowViewProps, next: TableRowViewProps): boolean {
  if (
    prev.row !== next.row
    || prev.rowIndex !== next.rowIndex
    || prev.columns !== next.columns
    || prev.tableLabel !== next.tableLabel
    || prev.hasCoords !== next.hasCoords
    || prev.hasRowConfidence !== next.hasRowConfidence
    || prev.shared.bindingIndex !== next.shared.bindingIndex
    || prev.shared.onEdit !== next.shared.onEdit
    || prev.shared.onFlash !== next.shared.onFlash
    || prev.shared.readOnly !== next.shared.readOnly
  ) {
    return false;
  }
  if (prev.shared.edits === next.shared.edits) {
    return true;
  }
  for (const column of next.columns) {
    const cell = next.row[column];
    const binding = cell === undefined ? undefined : next.shared.bindingIndex.get(cell.pointer);
    if (
      binding !== undefined
      && prev.shared.edits.get(binding.key.raw) !== next.shared.edits.get(binding.key.raw)
    ) {
      return false;
    }
  }
  return true;
}

const TableRow = React.memo(TableRowView, areRowPropsEqual);

/** Table bucket: the console DataTable's column model without antd. */
function TableSection(props: {
  table: ClassifiedData['tables'][number];
  shared: SectionShared;
}): React.JSX.Element {
  const { table, shared } = props;
  const label = formatLabel(table.key);
  // Full-row scans — memoized so keystroke re-renders don't re-walk every cell.
  const hasCoords = React.useMemo(
    () =>
      table.rows.some((row) =>
        Object.entries(row).some(([key, cell]) => key !== ROW_META_KEY && cell.coordinates !== null),
      ),
    [table],
  );
  const hasRowConfidence = React.useMemo(
    () => table.rows.some((row) => Boolean(row[ROW_META_KEY]?.confidence?.level)),
    [table],
  );
  return (
    <section className="gemina-verification__section" aria-label={label}>
      <div className="gemina-verification__section-header">
        <span>
          {label} ({table.rows.length} rows)
        </span>
        <ConfidenceDot confidence={table.overallConfidence} />
      </div>
      <div className="gemina-verification__table-wrap">
        <table className="gemina-verification__table">
          <thead>
            <tr>
              {hasCoords ? <th aria-label="Show row on document" /> : null}
              {hasRowConfidence ? <th aria-label="Row confidence" /> : null}
              {table.columns.map((column) => (
                <th key={column}>{formatLabel(column)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <TableRow
                key={rowIndex}
                row={row}
                rowIndex={rowIndex}
                columns={table.columns}
                tableLabel={label}
                hasCoords={hasCoords}
                hasRowConfidence={hasRowConfidence}
                shared={shared}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Unclassifiable blobs: native <details> + pretty-printed JSON (no viewer dep).
 * Memoized: fallback is exactly where large unclassifiable payloads land, and
 * without the memo every parent render (i.e., every keystroke) would re-run
 * JSON.stringify over all of them. `classified.fallback` is referentially
 * stable (the parent memoizes classifyData), so the memo is a complete fix. */
const FallbackSection = React.memo(function FallbackSection(
  props: { fallback: ClassifiedData['fallback'] },
): React.JSX.Element | null {
  const { fallback } = props;
  if (fallback.length === 0) {
    return null;
  }
  return (
    <section className="gemina-verification__section" aria-label="Additional Data">
      <div className="gemina-verification__section-header">Additional Data</div>
      <div className="gemina-verification__section-body">
        {fallback.map((item) => (
          <details key={item.key} className="gemina-verification__fallback">
            <summary>{formatLabel(item.key)}</summary>
            <pre>{JSON.stringify(item.data, null, 2)}</pre>
          </details>
        ))}
      </div>
    </section>
  );
});

/** Bindings the model missed entirely: a section of empty fill-in inputs. */
function UnmatchedSection(props: {
  unmatched: FieldBinding[];
  shared: SectionShared;
}): React.JSX.Element | null {
  const { unmatched, shared } = props;
  if (unmatched.length === 0) {
    return null;
  }
  return (
    <section className="gemina-verification__section" aria-label="Not detected">
      <div className="gemina-verification__section-header">Not detected</div>
      <dl className="gemina-verification__dl">
        {unmatched.map((binding) => (
          <React.Fragment key={binding.key.raw}>
            {/* Schema labels are already human text — formatLabel is for raw
                payload keys only (it would mangle "PO Number" → "Po Number"). */}
            <dt className="gemina-verification__dt">
              <span>{binding.key.label}</span>
            </dt>
            <dd className="gemina-verification__dd">
              <FieldInput
                binding={binding}
                edit={shared.edits.get(binding.key.raw)}
                onEdit={shared.onEdit}
                readOnly={shared.readOnly}
                ariaLabel={binding.key.label}
              />
            </dd>
          </React.Fragment>
        ))}
      </dl>
    </section>
  );
}

/** The whole form pane: every classified bucket in console order, then the
 * unmatched "Not detected" section. Empty buckets render nothing. */
export function VerificationForm(props: VerificationFormProps): React.JSX.Element {
  const { classified, unmatched, bindingIndex, edits, onEdit, readOnly, onFlash } = props;
  const shared: SectionShared = { bindingIndex, edits, onEdit, readOnly, onFlash };
  return (
    // A real, labeled <form> (role "form" landmark): AT users can jump
    // straight to the editable fields. Submission is owned by the root's
    // footer button, never by the form element itself — preventDefault stops
    // implicit submission (Enter in a payload with exactly one input would
    // otherwise navigate).
    <form
      className="gemina-verification__form"
      aria-label="Extraction fields"
      onSubmit={(event) => event.preventDefault()}
    >
      <HeaderSection headers={classified.headers} simpleLists={classified.simpleLists} shared={shared} />
      {classified.entities.map((entity) => (
        <EntitySection key={entity.pointer} entity={entity} shared={shared} />
      ))}
      {classified.tables.map((table) => (
        <TableSection key={table.pointer} table={table} shared={shared} />
      ))}
      <FallbackSection fallback={classified.fallback} />
      <UnmatchedSection unmatched={unmatched} shared={shared} />
    </form>
  );
}
