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
import { ISO_4217_CODES, cellSchemaKey, validateInput } from './field-types';
import type { RowMutableTable, ValidationFieldDescriptor } from './field-types';
import { matchesTablePointer, tableColumns } from './row-cells';
import type { PlannedCell, PlannedRow } from './row-cells';
import { cellEditKey } from './row-plan';
import { NOTHING_HIDDEN, unplannedRowKey } from './review-filter';
import type { HiddenSets } from './review-filter';
import type { RowPlanEntry } from './row-plan';
import { NOT_FOUND, parseSchemaKey, snakeToCamel } from './pointer';
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
  /** `binding` travels with the change so revert detection never has to
   *  resolve an edit key back to a field — a cell key could not be. */
  onEdit: (editKey: string, value: string, binding: FieldBinding) => void;
  readOnly: boolean;
  /** formatLabel(label) — the visible label lives in the surrounding layout. */
  ariaLabel: string;
  /**
   * A row-level error decided outside this field (the unit-size pair rule).
   * Wins over per-field validation and applies even when untouched: the field
   * is invalid because of its SIBLING, so dirtiness here is irrelevant.
   */
  pairError?: string;
  /**
   * The key this field's edit is stored under. Defaults to the raw schema key
   * (headers, and tables with no row plan); a row-mutable table passes a
   * `cellEditKey` so the edit follows the ROW rather than the position.
   */
  editKey?: string;
}): React.JSX.Element {
  const { binding, edit, onEdit, readOnly, ariaLabel, pairError } = props;
  const editKey = props.editKey ?? binding.key.raw;
  const editedBadgeId = React.useId();
  const errorId = React.useId();
  const currencyListId = React.useId();

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
  const field = binding.field;
  const value = dirty ? edit : toInputString(binding.extracted);

  // Only a value the reviewer TYPED can be invalid. An extracted value that is
  // off-roster is the model's output, not their mistake: it is preserved (see
  // the pinned option below) and must not block a submission they never
  // touched. Task 6.4's gate reads the same rule.
  const error = pairError ?? (dirty ? validateInput(value, field) : null);
  const className = [
    'gemina-verification__input',
    dirty ? 'gemina-verification__input--dirty' : '',
    missed ? 'gemina-verification__input--missed' : '',
    error ? 'gemina-verification__input--invalid' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Space-separated, never overwritten: the edited badge and the error are
  // both descriptions of the same control and a reviewer needs to hear both.
  const describedBy = [dirty ? editedBadgeId : '', error ? errorId : '']
    .filter(Boolean)
    .join(' ');
  const shared = {
    className,
    'aria-label': ariaLabel,
    'aria-describedby': describedBy || undefined,
    'aria-invalid': error ? (true as const) : undefined,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      onEdit(editKey, event.target.value, binding),
  };

  // A closed roster is a choice, not a spelling test. The extracted value is
  // PINNED as an option when it is off-roster, so opening the select can never
  // silently destroy what the model found.
  const roster = field?.enum && field.enum.length > 0 ? field.enum : null;
  const offRoster = roster && value !== '' && !roster.includes(value) ? value : null;

  const control = roster ? (
    <select {...shared} value={value} dir="auto">
      {/* Clearing stays possible: an empty submission asserts "not present". */}
      <option value="">—</option>
      {offRoster ? <option value={offRoster}>{offRoster} (as extracted)</option> : null}
      {roster.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
  ) : (
    <input
      {...shared}
      // `date` gets the native picker; everything else stays text so the
      // server's own leniency (commas, underscores) is not fought by the
      // browser's number parsing.
      type={field?.type === 'date' ? 'date' : 'text'}
      // Per-input bidi: a Latin value inside an RTL (Hebrew) document — or
      // vice versa — must lay out by its own content, not the widget's dir.
      dir="auto"
      // RAW value only — a display-formatted "1,500" round-tripped into the
      // submission would score as a correction (see toInputString).
      value={value}
      // A hint to the soft keyboard, NOT validation — validateInput is that.
      inputMode={field?.type === 'number' || field?.type === 'integer' ? 'decimal' : undefined}
      list={field?.format === 'iso4217' ? currencyListId : undefined}
      placeholder={missed ? 'Not detected — fill in if present' : undefined}
      autoComplete="off"
    />
  );

  return (
    <>
      {control}
      {field?.format === 'iso4217' ? (
        <datalist id={currencyListId}>
          {ISO_4217_CODES.map((code) => <option key={code} value={code} />)}
        </datalist>
      ) : null}
      {error ? (
        <span className="gemina-verification__field-error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
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
  /** Edit key -> row-level error. Empty for every extraction without the pair. */
  pairErrors: ReadonlyMap<string, string>;
  /** Server-declared row-mutable tables. Empty disables every row control. */
  rowMutableTables: readonly RowMutableTable[];
  /**
   * Table pointer -> its rows, already resolved to cells. Computed ONCE by the
   * parent: computing it here as well would produce a second object per render
   * and defeat the row memo, which compares it by reference.
   */
  plannedTables: ReadonlyMap<string, PlannedRow[]>;
  onAddRow: (tablePointer: string, afterPosition: number) => void;
  onRemoveRow: (tablePointer: string, position: number) => void;

  bindingIndex: Map<string, FieldBinding>;
  edits: ReadonlyMap<string, string>;
  /** `binding` travels with the change so revert detection never has to
   *  resolve an edit key back to a field — a cell key could not be. */
  onEdit: (editKey: string, value: string, binding: FieldBinding) => void;
  readOnly: boolean;
  onFlash: (rects: FlashRect[]) => void;
  /**
   * Fields and rows the review filter is hiding. `NOTHING_HIDDEN` when off.
   *
   * NOT part of `areRowPropsEqual`, on purpose: it is derived from `edits`, so
   * a new object arrives on every keystroke and comparing it would re-render
   * every row in the table — the same cost `pairErrors` is excluded to avoid.
   * It costs nothing to leave out, because a hidden row is never rendered at
   * all; only the sections need to read it.
   */
  hidden: HiddenSets;
  /**
   * Whether the filter is engaged. Rows DO react to this — they drop their
   * add/remove controls, because "insert below row 3" is meaningless when row
   * 4 is hidden — so unlike `hidden` it must be compared. It is a stable
   * boolean, so that is free.
   */
  filterOn: boolean;
}

/** Props for the whole form pane.
 *
 * The SectionShared stability contract applies (see above), and `classified`
 * must be the memoized product of one `classifyData` call — a fresh object
 * per render defeats both the row memo and the fallback-section memo. */
/** One shared empty instance: `shared` is compared by reference downstream, so
 *  "no row errors" must always be the SAME object. */
const NO_PAIR_ERRORS: ReadonlyMap<string, string> = new Map();
const NO_TABLES: readonly RowMutableTable[] = [];
const NO_PLANNED: ReadonlyMap<string, PlannedRow[]> = new Map();
const NOOP_ROW = () => {};

export interface VerificationFormProps
  extends Omit<SectionShared,
  'pairErrors' | 'rowMutableTables' | 'plannedTables' | 'onAddRow' | 'onRemoveRow' | 'hidden' | 'filterOn'> {
  /** Review filter. Omitted = off, hiding nothing — same contract as the row
   *  props above: a host rendering the form directly need not know it exists. */
  hidden?: HiddenSets;
  filterOn?: boolean;
  /**
   * All optional on the public surface. The pair rule and the row plans are
   * internal details of the full component, and a host — or a test — rendering
   * the form directly should not have to know they exist. Omitting them yields
   * exactly the pre-row-editing form: no controls, raw-key edits.
   */
  pairErrors?: ReadonlyMap<string, string>;
  rowMutableTables?: readonly RowMutableTable[];
  plannedTables?: ReadonlyMap<string, PlannedRow[]>;
  onAddRow?: (tablePointer: string, afterPosition: number) => void;
  onRemoveRow?: (tablePointer: string, position: number) => void;
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

/**
 * A field label, with the model's description as a tooltip when there is one.
 *
 * Plain text when there is not: an empty tooltip trigger is worse than none,
 * because it promises information it does not have.
 */
function FieldLabel(props: { label: string; description?: string | null }): React.JSX.Element {
  const { label, description } = props;
  if (!description) {
    return <span>{label}</span>;
  }
  return (
    <Tip content={description}>
      <span className="gemina-verification__label-described" tabIndex={0}>{label}</span>
    </Tip>
  );
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
        {/* The model's own field description, which the backend publishes per
            field. Without this it is carried all the way to the client and
            then dropped — and it is the only place a reviewer can learn what
            a field like "assignment number" is actually supposed to contain. */}
        <FieldLabel label={label} description={binding?.field?.description} />
      </dt>
      <dd className="gemina-verification__dd">
        {binding !== undefined ? (
          <FieldInput
            binding={binding}
            pairError={shared.pairErrors.get(binding.key.raw)}
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
  // The review filter hides what already scored high. Applied here rather than
  // at the call site so simple lists get the same treatment as headers.
  const visibleHeaders = headers.filter((field) => !shared.hidden.fields.has(field.pointer));
  const visibleLists = simpleLists
    .map((list) => ({ ...list, items: list.items.filter((item) => !shared.hidden.fields.has(item.pointer)) }))
    .filter((list) => list.items.length > 0);
  if (visibleHeaders.length === 0 && visibleLists.length === 0) {
    return null;
  }
  return (
    <section className="gemina-verification__section" aria-label="Details">
      <div className="gemina-verification__section-header">Details</div>
      <dl className="gemina-verification__dl">
        {visibleHeaders.map((field) => (
          <FieldPair
            key={field.pointer}
            label={formatLabel(field.key)}
            ariaLabel={formatLabel(field.key)}
            cell={field}
            shared={shared}
          />
        ))}
        {visibleLists.map((list) => (
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
                          pairError={shared.pairErrors.get(binding.key.raw)}
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
  // Drop a card only when ALL of its cells are hidden — a card with one
  // remaining medium-confidence field is still worth reviewing.
  // The ORIGINAL index travels with each surviving card. Renumbering after a
  // filter would relabel "Supplier 2" as "Supplier 1" — in the visible header
  // AND in the aria-label, telling a screen-reader user they are editing a
  // different entity than they are. Same reason the table keeps plan positions.
  const visibleItems = entity.items
    .map((item, index) => ({
      index,
      cells: Object.fromEntries(
        Object.entries(item).filter(([, cellValue]) => !shared.hidden.fields.has(cellValue.pointer)),
      ),
    }))
    .filter(({ cells }) => Object.keys(cells).length > 0);
  const label = formatLabel(entity.key);
  // The console's naive strip-trailing-s, ported verbatim ("Suppliers" →
  // "Supplier"; yes, "Parties" → "Partie" — console parity over grammar).
  const singular = label.replace(/s$/, '');
  return (
    <section className="gemina-verification__section" aria-label={label}>
      <div className="gemina-verification__section-header">
        {/* The true count, not the filtered one: the heading says how many
            entities the document has, and the filter never changes that. */}
        {label} ({entity.items.length})
      </div>
      <div className="gemina-verification__section-body">
        {visibleItems.map(({ index, cells }) => (
          // Keyed by the original index, never the filtered position, or React
          // reuses a hidden card's DOM (and its focus) for its successor.
          <div key={index} className="gemina-verification__card">
            <div className="gemina-verification__card-header">
              {singular} {index + 1}
            </div>
            <dl className="gemina-verification__dl">
              {Object.entries(cells).map(([fieldKey, cell]) => (
                <FieldPair
                  key={fieldKey}
                  label={formatLabel(fieldKey)}
                  // Card context: two "Supplier" cards both announcing a bare
                  // "Name" would be ambiguous to a screen reader.
                  ariaLabel={`${singular} ${index + 1} — ${formatLabel(fieldKey)}`}
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
  /** The classified row behind this render — undefined for a row the reviewer added. */
  row: Record<string, ClassifiedCell> | undefined;
  /** Position in the SUBMITTED table: what the reviewer sees, and what labels count. */
  rowIndex: number;
  columns: string[];
  /** formatLabel(tableKey), precomputed once per table. */
  tableLabel: string;
  hasCoords: boolean;
  hasRowConfidence: boolean;
  shared: SectionShared;
  /** Resolved cells + row identity. Present ONLY for a row-mutable table. */
  planned?: PlannedRow;
  /** The server's pointer for this table — the key the row handlers take. */
  tablePointer?: string;
}

function TableRowView(props: TableRowViewProps): React.JSX.Element {
  const { row, rowIndex, columns, tableLabel, hasCoords, hasRowConfidence, shared, planned, tablePointer } = props;
  const { bindingIndex, edits, onEdit, readOnly, onFlash } = shared;

  const rects = React.useMemo(() => {
    const collected: FlashRect[] = [];
    for (const [key, cell] of Object.entries(row ?? {})) {
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

  /** Cells by column: from the plan when there is one, else today's lookup. */
  const cellFor = (column: string) => {
    // Server-declared table columns use model names (snake_case), but response
    // DTOs expose the same keys in camelCase. Prefer an exact key (important
    // for dynamic templates that genuinely use either spelling), then match
    // through the one shared casing rule.
    const direct = row?.[column];
    const alias = direct === undefined ? row?.[snakeToCamel(column)] : undefined;
    const fallbackKey = direct === undefined && alias === undefined && row !== undefined
      ? Object.keys(row).find((key) => snakeToCamel(key) === snakeToCamel(column))
      : undefined;
    const classified = direct ?? alias ?? (fallbackKey === undefined ? undefined : row?.[fallbackKey]);
    const fromPlan = planned?.cells.find((cell: PlannedCell) => cell.column === column);
    if (fromPlan) {
      return { classified, binding: fromPlan.binding, editKey: fromPlan.editKey };
    }
    const binding = classified === undefined ? undefined : bindingIndex.get(classified.pointer);
    return { classified, binding, editKey: binding?.key.raw };
  };

  const firstRect = rects.length > 0 ? rects[0]! : null;
  // Row controls are OMITTED while filtering, not disabled: "insert below
  // row 3" is meaningless when row 4 is hidden, and a disabled button
  // cannot carry its own explanation — Tip attaches hover/focus handlers to
  // its child, and a disabled button dispatches neither.
  const showControls = planned !== undefined && tablePointer !== undefined && !readOnly
    && !shared.filterOn;
  // A REDUNDANT channel: the confidence dot and its tooltip already carry the
  // meaning, so this marker does not have to pass contrast on its own — it is
  // there so a reviewer can find the rows worth checking by scanning the edge
  // of a 150-line table instead of reading every dot.
  const rowLevel = (row?.[ROW_META_KEY]?.confidence?.level ?? '').toLowerCase();
  const rowClass = rowLevel === 'low' || rowLevel === 'medium'
    ? `gemina-verification__row--${rowLevel}`
    : undefined;
  return (
    <tr onClick={handleRowClick} className={rowClass}>
      {hasCoords ? (
        <td>
          {/* EyeButton's coordinates prop is only the render gate here — the
              click flashes ALL the row's rects, console DataTable style. */}
          <EyeButton coordinates={firstRect} onFlash={() => onFlash(rects)} />
        </td>
      ) : null}
      {hasRowConfidence ? (
        <td>
          <ConfidenceDot confidence={row?.[ROW_META_KEY]?.confidence ?? null} />
        </td>
      ) : null}
      {columns.map((column) => {
        const { classified, binding, editKey } = cellFor(column);
        return (
          <td key={column}>
            <div className="gemina-verification__cell">
              {binding !== undefined ? (
                <FieldInput
                  binding={binding}
                  editKey={editKey}
                  pairError={editKey === undefined ? undefined : shared.pairErrors.get(editKey)}
                  edit={editKey === undefined ? undefined : edits.get(editKey)}
                  onEdit={onEdit}
                  readOnly={readOnly}
                  ariaLabel={`${tableLabel} row ${rowIndex + 1} — ${formatLabel(column)}`}
                />
              ) : (
                <span>{classified === undefined ? '-' : formatValue(classified.value, column)}</span>
              )}
              <ConfidenceDot confidence={classified?.confidence ?? null} />
            </div>
          </td>
        );
      })}
      {showControls ? (
        <td className="gemina-verification__row-actions">
          {/* Row-numbered labels: "Remove line" repeated N times is unusable
              with a screen reader, and the number is what the reviewer sees. */}
          <Tip content="Insert a line below">
            <button
              type="button"
              className="gemina-verification__row-btn"
              aria-label={`Insert line below line ${rowIndex + 1}`}
              onClick={() => shared.onAddRow(tablePointer!, rowIndex)}
            >
              +
            </button>
          </Tip>
          <Tip content="Remove this line">
            <button
              type="button"
              className="gemina-verification__row-btn"
              aria-label={`Remove line ${rowIndex + 1}`}
              onClick={() => shared.onRemoveRow(tablePointer!, rowIndex)}
            >
              ×
            </button>
          </Tip>
        </td>
      ) : null}
    </tr>
  );
}

/** Bail out unless THIS row's data or its slice of the edits changed. The
 * comparator inspects only edits for this row's cells, so one keystroke
 * re-renders one row. Callbacks are compared by reference: the parent must
 * pass referentially stable `onEdit`/`onFlash` (and a stable
 * `classified`/`bindingIndex`) or the memoization degrades to plain renders.
 *
 * `rowMutableTables` belongs on that list too, and less obviously so, because
 * it is not compared here at all. `columns` is — and TableSection derives it
 * with one `tableColumns` memo keyed on `[table, shared.rowMutableTables]`.
 * `displayColumns` mints a fresh array every time that memo runs, so a
 * `rowMutableTables` prop rebuilt per render invalidates `columns` on every
 * keystroke and re-renders EVERY row of the table, not one. (The earlier
 * two-memo shape happened to absorb this — `.find` returns the same element,
 * so the inner memo did not re-run — but that buffer is gone, and no lint in
 * this repo would report its loss.) */
function areRowPropsEqual(prev: TableRowViewProps, next: TableRowViewProps): boolean {
  if (
    prev.row !== next.row
    || prev.rowIndex !== next.rowIndex
    || prev.columns !== next.columns
    || prev.tableLabel !== next.tableLabel
    || prev.hasCoords !== next.hasCoords
    || prev.hasRowConfidence !== next.hasRowConfidence
    || prev.planned !== next.planned
    || prev.tablePointer !== next.tablePointer
    || prev.shared.bindingIndex !== next.shared.bindingIndex
    || prev.shared.onEdit !== next.shared.onEdit
    || prev.shared.onFlash !== next.shared.onFlash
    || prev.shared.readOnly !== next.shared.readOnly
    // Stable boolean, and rows must react to it (controls disappear).
    // `shared.hidden` is deliberately absent — see SectionShared.
    || prev.shared.filterOn !== next.shared.filterOn
  ) {
    // NOT compared by reference: `pairErrors` is derived from `edits`, so a new
    // Map arrives on EVERY keystroke and a blanket check would re-render every
    // row in the table. Its per-cell values are checked below instead.
    return false;
  }
  if (prev.shared.edits === next.shared.edits) {
    return true;
  }
  // Compare by EDIT key, which under a row plan is the cell key rather than
  // the raw schema key — comparing raw keys would leave a row stale after an
  // edit to a row that moved.
  for (const column of next.columns) {
    const planned = next.planned?.cells.find((cell: PlannedCell) => cell.column === column);
    const classified = next.row?.[column];
    const editKey = planned?.editKey
      ?? (classified === undefined ? undefined : next.shared.bindingIndex.get(classified.pointer)?.key.raw);
    if (editKey === undefined) {
      continue;
    }
    if (prev.shared.edits.get(editKey) !== next.shared.edits.get(editKey)
      || prev.shared.pairErrors.get(editKey) !== next.shared.pairErrors.get(editKey)) {
      return false;
    }
  }
  return true;
}

const TableRow = React.memo(TableRowView, areRowPropsEqual);


/**
 * Promote a row-mutable table the classifier could not see as one.
 *
 * An EMPTY array classifies as a header, not a table (classify.ts) — so an
 * extraction that found no line items has no table, no columns and nowhere to
 * put "Add line". That is the case this feature exists for: the model found
 * nothing and the reviewer types it in.
 *
 * Done as a post-classification promotion driven by the SERVER's contract
 * rather than by changing the classifier, whose heuristics are shared with the
 * console and proven. The header the empty array produced is suppressed, or it
 * would render twice — once as "Line Items: []" and once as the table.
 */
export function withEmptyMutableTables(
  classified: ClassifiedData,
  tables: readonly RowMutableTable[],
): { tables: ClassifiedData['tables']; suppressed: ReadonlySet<string> } {
  if (tables.length === 0) {
    return { tables: classified.tables, suppressed: EMPTY_SUPPRESSED };
  }
  const promoted = [...classified.tables];
  const suppressed = new Set<string>();
  for (const table of tables) {
    if (classified.tables.some((candidate) => matchesTablePointer(table.pointer, candidate.pointer))) {
      continue;
    }
    const header = classified.headers.find(
      (candidate) => matchesTablePointer(table.pointer, candidate.pointer),
    );
    // The classifier normalises an empty array to `value: null`, so BOTH
    // spellings mean "no rows". Nothing else is promoted: a pointer that
    // resolved to real data is a contract mismatch, and inventing a table for
    // it would put row controls over data the scorer cannot align. The
    // server's own declaration is what makes this safe — the reviewer can only
    // ever add rows to a table the scorer knows how to align.
    const empty = header !== undefined
      && (header.value === null || (Array.isArray(header.value) && header.value.length === 0));
    if (!empty) {
      continue;
    }
    suppressed.add(header!.pointer);
    promoted.push({
      key: header!.key,
      pointer: header!.pointer,
      columns: [],
      rows: [],
      overallConfidence: null,
    });
  }
  return { tables: promoted, suppressed };
}

const EMPTY_SUPPRESSED: ReadonlySet<string> = new Set();

/** Table bucket: the console DataTable's column model without antd. */
function TableSection(props: {
  table: ClassifiedData['tables'][number];
  shared: SectionShared;
}): React.JSX.Element {
  const { table, shared } = props;
  const label = formatLabel(table.key);

  // Row editing is offered ONLY where the server declared it. Any wide array
  // of objects looks like a table to the classifier — custom_template's do —
  // and controls on one the scorer cannot align would mis-score permanently.
  const { mutable, columns } = React.useMemo(
    () => tableColumns(table, shared.rowMutableTables),
    [table, shared.rowMutableTables],
  );
  const planned = mutable ? shared.plannedTables.get(mutable.pointer) : undefined;

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
  // Column descriptions come from the server's declared columns, so they are
  // present even for a zero-row table — the case where a reviewer typing a
  // line in most needs to know what each column means.
  const columnDescriptions = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const column of mutable?.columns ?? []) {
      if (typeof column.key === 'string' && column.description) {
        map.set(column.key, column.description);
      }
    }
    return map;
  }, [mutable]);
  const rowCount = planned ? planned.length : table.rows.length;
  // `ConfidenceModel` is a closed high|medium|low, so the scale is total: a row
  // with no confidence at all is not "needing review", it is unmeasured.
  const needsReview = React.useMemo(
    () => table.rows.filter((row) => {
      const level = (row[ROW_META_KEY]?.confidence?.level ?? '').toLowerCase();
      return level === 'low' || level === 'medium';
    }).length,
    [table.rows],
  );
  const showControls = planned !== undefined && mutable !== undefined && !shared.readOnly
    && !shared.filterOn;

  // The review filter, applied to whichever collection actually renders. A
  // planned row is addressed by `entry.id` — already table-scoped by
  // initialRowPlan — and an unplanned one by its row pointer, which is exactly
  // what CellView.rowKey uses in each case.
  // `position` is the row's index in the UNFILTERED plan and travels with it:
  // onAddRow/onRemoveRow take a plan position, so renumbering after a filter
  // would target the wrong row. (Controls are hidden while filtering anyway —
  // this keeps the two facts independent rather than relying on that.)
  const visiblePlanned = planned
    ?.map((plannedRow, position) => ({ plannedRow, position }))
    .filter(({ plannedRow }) => !shared.hidden.rows.has(plannedRow.entry.id));
  // Empty rather than null when a plan exists: the two are mutually exclusive
  // by construction, and an always-array keeps the render below free of
  // non-null assertions that only restate that fact.
  const visibleRowIndices = planned
    ? []
    : table.rows.map((_row, index) => index)
      .filter((index) => !shared.hidden.rows.has(unplannedRowKey(table.pointer, index)));
  const visibleCount = visiblePlanned ? visiblePlanned.length : visibleRowIndices.length;
  // Never an empty <tbody>: say why the rows are gone, or a filtered table
  // reads as a table that lost its data.
  const allHidden = visibleCount === 0 && rowCount > 0;

  return (
    <section className="gemina-verification__section" aria-label={label}>
      <div className="gemina-verification__section-header">
        <span>
          {label} ({rowCount} rows{needsReview > 0 ? ` · ${needsReview} need review` : ''})
        </span>
        {/* Row controls vanish while filtering (insert-below is meaningless
            when the neighbour is hidden). Their absence has to be explained
            where it is noticed, and it cannot be explained on the controls
            themselves — a disabled button carries no reachable tooltip. */}
        {shared.filterOn && mutable !== undefined && !shared.readOnly ? (
          <span className="gemina-verification__filter-note">Row editing is off while filtering</span>
        ) : null}
        {table.overallConfidence ? (
          <span className="gemina-verification__overall-confidence">
            <span>Overall confidence</span>
            <ConfidenceDot confidence={table.overallConfidence} />
          </span>
        ) : null}
      </div>
      {allHidden ? (
        <p className="gemina-verification__all-scored">All {rowCount} rows scored high</p>
      ) : (
      <div className="gemina-verification__table-wrap">
        <table className="gemina-verification__table">
          <thead>
            <tr>
              {hasCoords ? <th aria-label="Show row on document" /> : null}
              {hasRowConfidence ? <th aria-label="Row confidence" /> : null}
              {columns.map((column) => (
                <th key={column}>
                  <FieldLabel
                    label={formatLabel(column)}
                    description={columnDescriptions.get(column)}
                  />
                </th>
              ))}
              {showControls ? <th aria-label="Row actions" /> : null}
            </tr>
          </thead>
          <tbody>
            {visiblePlanned
              ? visiblePlanned.map(({ plannedRow, position }) => (
                <TableRow
                  // Keyed by ROW ID, not position: a position key would make
                  // React reuse a deleted row's DOM (and its focus) for its
                  // successor.
                  key={plannedRow.entry.id}
                  row={plannedRow.entry.source === null ? undefined : table.rows[plannedRow.entry.source]}
                  rowIndex={position}
                  columns={columns}
                  tableLabel={label}
                  hasCoords={hasCoords}
                  hasRowConfidence={hasRowConfidence}
                  shared={shared}
                  planned={plannedRow}
                  tablePointer={mutable!.pointer}
                />
              ))
              : visibleRowIndices.map((rowIndex) => (
                <TableRow
                  key={rowIndex}
                  row={table.rows[rowIndex]}
                  rowIndex={rowIndex}
                  columns={columns}
                  tableLabel={label}
                  hasCoords={hasCoords}
                  hasRowConfidence={hasRowConfidence}
                  shared={shared}
                />
              ))}
          </tbody>
        </table>
      </div>
      )}
      {showControls ? (
        <div className="gemina-verification__table-footer">
          <button
            type="button"
            className="gemina-verification__add-row"
            onClick={() => shared.onAddRow(mutable!.pointer, rowCount - 1)}
          >
            Add line
          </button>
        </div>
      ) : null}
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
                pairError={shared.pairErrors.get(binding.key.raw)}
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
  const {
    classified, unmatched, bindingIndex, edits, onEdit, readOnly, onFlash,
    pairErrors, rowMutableTables, plannedTables, onAddRow, onRemoveRow,
    hidden, filterOn,
  } = props;
  const { tables: promotedTables, suppressed } = React.useMemo(
    () => withEmptyMutableTables(classified, rowMutableTables ?? NO_TABLES),
    [classified, rowMutableTables],
  );
  const shared: SectionShared = {
    bindingIndex, edits, onEdit, readOnly, onFlash,
    pairErrors: pairErrors ?? NO_PAIR_ERRORS,
    rowMutableTables: rowMutableTables ?? NO_TABLES,
    plannedTables: plannedTables ?? NO_PLANNED,
    onAddRow: onAddRow ?? NOOP_ROW,
    onRemoveRow: onRemoveRow ?? NOOP_ROW,
    hidden: hidden ?? NOTHING_HIDDEN,
    filterOn: filterOn ?? false,
  };
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
      {classified.overallConfidence ? (
        <div className="gemina-verification__confidence-summary">
          <span>Overall confidence</span>
          <ConfidenceDot confidence={classified.overallConfidence} />
        </div>
      ) : null}
      <HeaderSection
        headers={classified.headers.filter((header) => !suppressed.has(header.pointer))}
        simpleLists={classified.simpleLists}
        shared={shared}
      />
      {classified.entities.map((entity) => (
        <EntitySection key={entity.pointer} entity={entity} shared={shared} />
      ))}
      {promotedTables.map((table) => (
        <TableSection key={table.pointer} table={table} shared={shared} />
      ))}
      <FallbackSection fallback={classified.fallback} />
      <UnmatchedSection unmatched={unmatched} shared={shared} />
    </form>
  );
}
