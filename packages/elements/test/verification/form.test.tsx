/**
 * Form field primitives — Task 12: ConfidenceDot, EyeButton, FieldInput.
 *
 * Contract notes the tests pin down:
 * - The dot is a color signal PAIRED with text: role="img" + aria-label +
 *   a native title tooltip carrying the formatted reasons (WCAG 1.4.1).
 * - FieldInput prefills the RAW value string (`toInputString`), never the
 *   display-formatted one — a locale "1,500" round-tripped into a submission
 *   would score as a correction.
 * - Dirty is `edit !== undefined` (the PARENT owns revert-deletion); the
 *   dirty state has a non-color channel: a visible "edited" badge linked to
 *   the input via aria-describedby.
 * - `binding.editable === false` (container serverValues — the C1/C2
 *   amendment) renders read-only even when readOnly=false.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfidenceDot, EyeButton, FieldInput } from '../../src/verification/form';
import type { FieldBinding } from '../../src/verification/bindings';
import { NOT_FOUND } from '../../src/verification/pointer';

afterEach(cleanup);

// --- Fixtures ----------------------------------------------------------------

const RAW_KEY = 'label:Total Amount|ptr:/total_amount/value';

/** Editable scalar binding: schema pointer ends /value, so serverValue IS the
 * primitive (this is the only combination buildBindings emits as editable). */
function scalarBinding(over: Partial<FieldBinding> = {}): FieldBinding {
  return {
    key: { raw: RAW_KEY, label: 'Total Amount', pointer: '/total_amount/value' },
    serverValue: 1500,
    extracted: 1500,
    fieldPointer: '/totalAmount',
    editable: true,
    ...over,
  };
}

/** Wrapper binding: pointer hit the value-object itself → container
 * serverValue, unwrapped display value, editable false. */
function wrapperBinding(): FieldBinding {
  return {
    key: { raw: 'label:Total Amount|ptr:/total_amount', label: 'Total Amount', pointer: '/total_amount' },
    serverValue: { value: 1500 },
    extracted: 1500,
    fieldPointer: '/totalAmount',
    editable: false,
  };
}

/** Never-extracted binding: NOT_FOUND is editable (fill-in slot). */
function missedBinding(): FieldBinding {
  return {
    key: { raw: RAW_KEY, label: 'Total Amount', pointer: '/total_amount/value' },
    serverValue: NOT_FOUND,
    extracted: NOT_FOUND,
    fieldPointer: '/totalAmount',
    editable: true,
  };
}

interface FieldInputProps {
  binding: FieldBinding;
  edit: string | undefined;
  onEdit: (rawKey: string, value: string) => void;
  readOnly: boolean;
  ariaLabel: string;
}

function renderField(over: Partial<FieldInputProps> = {}) {
  const props: FieldInputProps = {
    binding: scalarBinding(),
    edit: undefined,
    onEdit: () => {},
    readOnly: false,
    ariaLabel: 'Total Amount',
    ...over,
  };
  return render(<FieldInput {...props} />);
}

/** Wires onEdit back into the edit prop the way the Task 14 parent will,
 * so typing exercises the real controlled-input flow. */
function Harness({ binding, onEditSpy }: {
  binding: FieldBinding;
  onEditSpy: (rawKey: string, value: string) => void;
}) {
  const [edit, setEdit] = useState<string | undefined>(undefined);
  return (
    <FieldInput
      binding={binding}
      edit={edit}
      onEdit={(rawKey, value) => {
        onEditSpy(rawKey, value);
        setEdit(value);
      }}
      readOnly={false}
      ariaLabel="Total Amount"
    />
  );
}

// --- ConfidenceDot -----------------------------------------------------------

describe('ConfidenceDot', () => {
  it.each([
    ['high', 'gemina-verification__dot--high', 'High confidence'],
    ['medium', 'gemina-verification__dot--medium', 'Medium confidence'],
    ['low', 'gemina-verification__dot--low', 'Low confidence'],
    ['HIGH', 'gemina-verification__dot--high', 'High confidence'],
  ])('level %s → variant class + aria-label', (level, className, label) => {
    render(<ConfidenceDot confidence={{ level, reasons: [] }} />);
    const dot = screen.getByRole('img', { name: label });
    expect(dot.classList.contains('gemina-verification__dot')).toBe(true);
    expect(dot.classList.contains(className)).toBe(true);
  });

  it('unrecognized level → --unknown variant, labeled with the raw level', () => {
    render(<ConfidenceDot confidence={{ level: 'Verified', reasons: [] }} />);
    const dot = screen.getByRole('img', { name: 'Verified confidence' });
    expect(dot.classList.contains('gemina-verification__dot--unknown')).toBe(true);
  });

  it('renders nothing for null confidence', () => {
    const { container } = render(<ConfidenceDot confidence={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for an empty level (table _rowMeta placeholder)', () => {
    const { container } = render(<ConfidenceDot confidence={{ level: '', reasons: ['x'] }} />);
    expect(container.firstChild).toBeNull();
  });

  it('title tooltip = label line + one formatted reason per line', () => {
    render(
      <ConfidenceDot
        confidence={{ level: 'high', reasons: ['low_ocr_quality', 'blurry_scan'] }}
      />,
    );
    const dot = screen.getByRole('img', { name: 'High confidence' });
    expect(dot.getAttribute('title')).toBe('High confidence\nLow OCR Quality\nBlurry Scan');
  });

  it('title without reasons is the bare label — no trailing newline', () => {
    render(<ConfidenceDot confidence={{ level: 'low', reasons: [] }} />);
    const dot = screen.getByRole('img', { name: 'Low confidence' });
    expect(dot.getAttribute('title')).toBe('Low confidence');
  });
});

// --- EyeButton ---------------------------------------------------------------

describe('EyeButton', () => {
  const COORDS = { points: [[0.1, 0.1], [0.3, 0.2]] as [number, number][] };

  it('renders nothing without coordinates', () => {
    const { container } = render(<EyeButton coordinates={null} onFlash={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a labeled non-submitting button with the eye icon', () => {
    render(<EyeButton coordinates={COORDS} onFlash={() => {}} />);
    const button = screen.getByRole('button', { name: 'Show on document' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('title')).toBe('Show on document');
    expect(button.querySelector('svg')).not.toBeNull();
  });

  it('click fires onFlash and does NOT propagate to the parent (row click)', () => {
    const onFlash = vi.fn();
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <EyeButton coordinates={COORDS} onFlash={onFlash} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show on document' }));
    expect(onFlash).toHaveBeenCalledTimes(1);
    expect(parentClick).not.toHaveBeenCalled();
  });
});

// --- FieldInput --------------------------------------------------------------

describe('FieldInput', () => {
  it('prefills the RAW value — 1500, never the display-formatted string', () => {
    renderField();
    const input = screen.getByRole('textbox', { name: 'Total Amount' }) as HTMLInputElement;
    expect(input.value).toBe('1500');
    expect(input.value).not.toBe((1500).toLocaleString());
    expect(input.classList.contains('gemina-verification__input')).toBe(true);
    expect(input.classList.contains('gemina-verification__input--dirty')).toBe(false);
    expect(input.classList.contains('gemina-verification__input--missed')).toBe(false);
  });

  it('pristine input carries no edited badge and no aria-describedby', () => {
    renderField();
    const input = screen.getByRole('textbox', { name: 'Total Amount' });
    expect(input.getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByText('edited')).toBeNull();
  });

  it('typing calls onEdit with the FULL raw key and marks dirty (class + badge)', () => {
    const onEditSpy = vi.fn();
    render(<Harness binding={scalarBinding()} onEditSpy={onEditSpy} />);
    const input = screen.getByRole('textbox', { name: 'Total Amount' }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '1600' } });

    expect(onEditSpy).toHaveBeenCalledWith(RAW_KEY, '1600');
    expect(input.value).toBe('1600');
    expect(input.classList.contains('gemina-verification__input--dirty')).toBe(true);
    const badge = screen.getByText('edited');
    expect(badge.id).not.toBe('');
    expect(input.getAttribute('aria-describedby')).toBe(badge.id);
  });

  it('edit of empty string is still dirty — cleared is an assertion, not a revert', () => {
    renderField({ edit: '' });
    const input = screen.getByRole('textbox', { name: 'Total Amount' }) as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.classList.contains('gemina-verification__input--dirty')).toBe(true);
    expect(screen.queryByText('edited')).not.toBeNull();
  });

  it('missed field renders the fill-in placeholder and --missed styling', () => {
    renderField({ binding: missedBinding() });
    const input = screen.getByRole('textbox', { name: 'Total Amount' }) as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.getAttribute('placeholder')).toBe('Not detected — fill in if present');
    expect(input.classList.contains('gemina-verification__input--missed')).toBe(true);
    expect(input.classList.contains('gemina-verification__input--dirty')).toBe(false);
  });

  it('missed + dirty coexist — the badge is the visible dirty channel', () => {
    renderField({ binding: missedBinding(), edit: '42' });
    const input = screen.getByRole('textbox', { name: 'Total Amount' }) as HTMLInputElement;
    expect(input.classList.contains('gemina-verification__input--missed')).toBe(true);
    expect(input.classList.contains('gemina-verification__input--dirty')).toBe(true);
    expect(screen.queryByText('edited')).not.toBeNull();
  });

  it('readOnly renders display-formatted text, not an input', () => {
    renderField({ readOnly: true });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText((1500).toLocaleString())).not.toBeNull();
  });

  it('editable:false (container serverValue) renders read-only despite readOnly=false', () => {
    renderField({ binding: wrapperBinding(), readOnly: false });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText((1500).toLocaleString())).not.toBeNull();
  });

  it('readOnly + NOT_FOUND shows the dash placeholder — never a Symbol leak', () => {
    renderField({ binding: missedBinding(), readOnly: true });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('-')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Symbol');
  });
});
