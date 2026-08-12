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
 */
import React from 'react';
import type { FieldBinding } from './bindings';
import { toInputString } from './bindings';
import { formatLabel, formatValue } from './classify';
import { NOT_FOUND } from './pointer';
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

  const title = [label, ...confidence.reasons.map(formatLabel)].join('\n');
  return (
    <span
      className={`gemina-verification__dot gemina-verification__dot--${variant}`}
      role="img"
      aria-label={label}
      title={title}
    />
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
    <button
      type="button"
      className="gemina-verification__eye"
      title="Show on document"
      aria-label="Show on document"
      onClick={(event) => {
        // Rows use click-to-flash (Task 13); the field eye must not double-fire it.
        event.stopPropagation();
        onFlash();
      }}
    >
      <IconEye />
    </button>
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
        <span className="gemina-verification__edited" id={editedBadgeId}>
          edited
        </span>
      ) : null}
    </>
  );
}
