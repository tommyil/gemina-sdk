/**
 * Form field primitives (Task 12) + shape sections (Task 13).
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
 *
 * VerificationForm contract (Task 13):
 * - Section order mirrors the console's FormView index.tsx: Details
 *   (headers + simple lists), entity cards, tables, fallback — then the
 *   SDK-only "Not detected" section. (The console puts entities BEFORE
 *   tables; the form follows the console, deliberately.)
 * - Fields render a FieldInput only when the classifier pointer has a
 *   binding; unbound fields are read-only display text.
 * - Row click-to-flash collects ALL the row's cell rects, and ignores
 *   clicks originating on interactive elements (inputs, buttons, ...).
 * - Cell/entity aria-labels carry row/card context — a bare "Description"
 *   announces ambiguously across rows.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfidenceDot, EyeButton, FieldInput, VerificationForm } from '../../src/verification/form';
import type { VerificationFormProps } from '../../src/verification/form';
import { buildBindings, countRowsAt, indexBindingsByFieldPointer } from '../../src/verification/bindings';
import type { FieldBinding } from '../../src/verification/bindings';
import { classifyData, ROW_META_KEY } from '../../src/verification/classify';
import { computeEmptyColumns } from '../../src/verification/empty-columns';
import { cellSchemaKey, readDescriptors, readRowMutableTables } from '../../src/verification/field-types';
import { declaredTableColumns, planTableCells } from '../../src/verification/row-cells';
import type { PlannedRow } from '../../src/verification/row-cells';
import { initialRowPlan, insertRowAfter } from '../../src/verification/row-plan';
import { NOT_FOUND } from '../../src/verification/pointer';
import { wideTableExtraction } from './empty-columns.fixture';

/**
 * The row-render probe (row-render-probe.ts), wired into this file because the
 * empty-column filter's whole reason for memoizing on a bitmask is a memo
 * bail-out that no DOM assertion can see. The mock CALLS have to live here —
 * mocking is per-file — but the wrapping is shared with
 * verification-edit.test.tsx rather than copied into it.
 *
 * Deliberately file-wide: the wrappers are pass-through, so the other ~80 tests
 * here see exactly what they saw before, and the counter resets in `afterEach`.
 */
const probe = vi.hoisted(() => ({ rowRenders: 0 }));

vi.mock('react/jsx-runtime', async (importOriginal) => {
  const { wrapJsxRuntime } = await import('./row-render-probe');
  return wrapJsxRuntime(await importOriginal<Record<string, (...args: unknown[]) => unknown>>(), probe);
});

vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const { wrapJsxDevRuntime } = await import('./row-render-probe');
  return wrapJsxDevRuntime(await importOriginal<Record<string, (...args: unknown[]) => unknown>>(), probe);
});

afterEach(() => {
  cleanup();
  probe.rowRenders = 0;
});

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

  it('reasons reach AT through the accessible NAME, not only the tooltip', () => {
    render(
      <ConfidenceDot
        confidence={{ level: 'high', reasons: ['low_ocr_quality', 'blurry_scan'] }}
      />,
    );
    // The tooltip is the SIGHTED channel; the aria-label carries the reasons
    // too (formatted, comma-joined) so screen-reader users hear WHY.
    const dot = screen.getByRole('img', { name: 'High confidence: Low OCR Quality, Blurry Scan' });
    expect(dot.getAttribute('title')).toBeNull(); // retired — see tip.tsx
  });

  it('gives the dot a structured tooltip: level heading over a reasons list', async () => {
    render(
      <ConfidenceDot
        confidence={{ level: 'low', reasons: ['blurry_region', 'low_ocr_quality'] }}
      />,
    );
    fireEvent.mouseEnter(screen.getByRole('img', { name: /low confidence/i }));

    const tip = await screen.findByRole('tooltip');
    expect(tip.querySelector('strong')?.textContent).toBe('Low confidence');
    const items = [...tip.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toEqual(['Blurry Region', 'Low OCR Quality']);
  });

  it('without reasons the tooltip is the bare label — no empty list', async () => {
    render(<ConfidenceDot confidence={{ level: 'low', reasons: [] }} />);
    const dot = screen.getByRole('img', { name: 'Low confidence' });
    expect(dot.getAttribute('aria-label')).toBe('Low confidence');

    fireEvent.mouseEnter(dot);
    const tip = await screen.findByRole('tooltip');
    expect(tip.querySelector('strong')?.textContent).toBe('Low confidence');
    expect(tip.querySelector('ul')).toBeNull();
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
    expect(button.getAttribute('title')).toBeNull(); // retired — see tip.tsx
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

  it('the edited badge tooltip carries the ORIGINAL value', async () => {
    // Once the input holds the correction, the extracted value is otherwise
    // gone from the screen — the badge is where it belongs.
    render(<Harness binding={scalarBinding()} onEditSpy={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Total Amount' });
    fireEvent.change(input, { target: { value: '1600' } });

    fireEvent.mouseEnter(screen.getByText('edited'));
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain('Was:');
    expect(tip.textContent).toContain('1,500');
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

// --- VerificationForm (Task 13) ----------------------------------------------

const SUPPLIER_RECT = { points: [[0.1, 0.1], [0.3, 0.15]] as [number, number][] };
const DESC_RECT = { points: [[0.1, 0.5], [0.4, 0.55]] as [number, number][] };
const PRICE_RECT = { points: [[0.5, 0.5], [0.6, 0.55]] as [number, number][] };

/** One payload exercising every bucket: headers, simple list, entities,
 * a table (with per-cell coords, a row-meta row, and overall confidence),
 * and a fallback blob. */
const FORM_PAYLOAD = {
  supplier_name: { value: 'Acme Ltd', coordinates: { relative: SUPPLIER_RECT.points }, confidence: 'high' },
  total: 1500,
  notes: 'keep',
  overall_confidence: 'medium',
  tags: ['urgent', 'paid'],
  suppliers: [
    { name: { value: 'Acme' }, role: { value: 'seller' } },
    { name: { value: 'Beta' }, role: { value: 'buyer' } },
  ],
  line_items: [
    {
      description: { value: 'Widget', coordinates: { relative: DESC_RECT.points }, confidence: 'low' },
      qty: { value: 2 },
      unit_price: { value: 100, coordinates: { relative: PRICE_RECT.points } },
      line_total: { value: 200 },
      confidence: 'medium',
    },
    {
      description: { value: 'Gadget' },
      qty: { value: 1 },
      unit_price: { value: 300 },
      line_total: { value: 300 },
    },
  ],
  attachments: [[1, 2], [3, 4]],
};

/** Server-shaped schema keys: wrapped fields point at /value (the editable
 * combination), the last one resolves nowhere → the unmatched bucket. */
const FORM_SCHEMA = [
  'label:Supplier Name|ptr:/supplier_name/value',
  'label:Total|ptr:/total',
  'label:First Tag|ptr:/tags/0',
  'label:Supplier 1 Name|ptr:/suppliers/0/name/value',
  'label:Line 1 Description|ptr:/line_items/0/description/value',
  'label:Line 1 Qty|ptr:/line_items/0/qty/value',
  'label:PO Number|ptr:/po_number/value',
];

function formProps(over: Partial<VerificationFormProps> = {}): VerificationFormProps {
  const bindings = buildBindings(FORM_SCHEMA, FORM_PAYLOAD);
  return {
    classified: classifyData(FORM_PAYLOAD),
    bindingIndex: indexBindingsByFieldPointer(bindings),
    unmatched: bindings.filter((b) => b.serverValue === NOT_FOUND),
    edits: new Map<string, string>(),
    onEdit: () => {},
    readOnly: false,
    onFlash: () => {},
    ...over,
  };
}

function renderForm(over: Partial<VerificationFormProps> = {}) {
  return render(<VerificationForm {...formProps(over)} />);
}

describe('VerificationForm: headers', () => {
  it('renders formatted label, confidence dot, and an input bound by field pointer', () => {
    renderForm();
    const details = screen.getByRole('region', { name: 'Details' });
    expect(within(details).getByText('Supplier Name')).not.toBeNull();
    expect(within(details).getByRole('img', { name: 'High confidence' })).not.toBeNull();
    const input = within(details).getByRole('textbox', { name: 'Supplier Name' }) as HTMLInputElement;
    expect(input.value).toBe('Acme Ltd');
    const total = within(details).getByRole('textbox', { name: 'Total' }) as HTMLInputElement;
    expect(total.value).toBe('1500');
  });

  it('a field with NO binding renders read-only text — no input', () => {
    renderForm();
    const details = screen.getByRole('region', { name: 'Details' });
    expect(within(details).getByText('keep')).not.toBeNull();
    expect(within(details).queryByRole('textbox', { name: 'Notes' })).toBeNull();
  });

  it('header eye button flashes the field rect as a single-rect array', () => {
    const onFlash = vi.fn();
    renderForm({ onFlash });
    const details = screen.getByRole('region', { name: 'Details' });
    fireEvent.click(within(details).getByRole('button', { name: 'Show on document' }));
    expect(onFlash).toHaveBeenCalledTimes(1);
    expect(onFlash).toHaveBeenCalledWith([SUPPLIER_RECT]);
  });

  it('typing in a bound header calls onEdit with the FULL raw schema key', () => {
    const onEdit = vi.fn();
    renderForm({ onEdit });
    const total = screen.getByRole('textbox', { name: 'Total' });
    fireEvent.change(total, { target: { value: '1600' } });
    // A header's edit key IS its raw schema key — only row-mutable table cells
    // key by row id. The binding rides along so the parent's revert detection
    // never has to resolve a key back to a field (a cell key could not be).
    expect(onEdit).toHaveBeenCalledWith(
      'label:Total|ptr:/total',
      '1600',
      expect.objectContaining({ extracted: 1500 }),
    );
  });
});

describe('VerificationForm: simple lists', () => {
  it('renders per-item rows: bound items get inputs, unbound stay text', () => {
    renderForm();
    const details = screen.getByRole('region', { name: 'Details' });
    expect(within(details).getByText('Tags')).not.toBeNull();
    const item = within(details).getByRole('textbox', { name: 'Tags item 1' }) as HTMLInputElement;
    expect(item.value).toBe('urgent');
    expect(within(details).getByText('paid')).not.toBeNull();
    expect(within(details).queryByRole('textbox', { name: 'Tags item 2' })).toBeNull();
  });
});

describe('VerificationForm: entities', () => {
  it('renders singularized card headers and card-context aria-labels', () => {
    renderForm();
    const section = screen.getByRole('region', { name: 'Suppliers' });
    expect(within(section).getByText('Suppliers (2)')).not.toBeNull();
    expect(within(section).getByText('Supplier 1')).not.toBeNull();
    expect(within(section).getByText('Supplier 2')).not.toBeNull();
    const name = within(section).getByRole('textbox', { name: 'Supplier 1 — Name' }) as HTMLInputElement;
    expect(name.value).toBe('Acme');
    // Unbound entity fields render read-only display text.
    expect(within(section).getByText('seller')).not.toBeNull();
    expect(within(section).queryByRole('textbox', { name: 'Supplier 1 — Role' })).toBeNull();
  });
});

describe('VerificationForm: tables', () => {
  it('renders global confidence above the sections and one th per data column', () => {
    renderForm();
    const form = screen.getByRole('form', { name: 'Extraction fields' });
    const summary = form.querySelector('.gemina-verification__confidence-summary')!;
    expect(within(summary as HTMLElement).getByText('Overall confidence')).not.toBeNull();
    expect(within(summary as HTMLElement).getByRole('img', { name: 'Medium confidence' })).not.toBeNull();
    const section = screen.getByRole('region', { name: 'Line Items' });
    expect(within(section).getByText(/Line Items \(2 rows/)).not.toBeNull();
    const header = section.querySelector('.gemina-verification__section-header')!;
    expect(within(header as HTMLElement).queryByText('Overall confidence')).toBeNull();
    const ths = within(section).getAllByRole('columnheader');
    // eye column + row-confidence column + 4 data columns
    expect(ths.length).toBe(6);
    expect(ths.slice(2).map((th) => th.textContent)).toEqual([
      'Description', 'Qty', 'Unit Price', 'Line Total',
    ]);
    expect(section.querySelector('.gemina-verification__table-wrap')).not.toBeNull();
  });

  it('bound cells render inputs inside __cell wrappers, with the cell dot alongside', () => {
    renderForm();
    const input = screen.getByRole('textbox', { name: 'Line Items row 1 — Description' }) as HTMLInputElement;
    expect(input.value).toBe('Widget');
    const cell = input.closest('.gemina-verification__cell');
    expect(cell).not.toBeNull();
    expect(cell!.closest('td')).not.toBeNull();
    // The extraction-confidence dot stays visible next to the bound input.
    expect(cell!.querySelector('.gemina-verification__dot--low')).not.toBeNull();
    const qty = screen.getByRole('textbox', { name: 'Line Items row 1 — Qty' }) as HTMLInputElement;
    expect(qty.value).toBe('2');
  });

  it('unbound cells render read-only formatted text + dot', () => {
    renderForm();
    // line_total row 1 has no binding: plain text inside a __cell wrapper.
    const text = screen.getByText('200');
    expect(text.closest('.gemina-verification__cell')).not.toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Line Items row 1 — Line Total' })).toBeNull();
  });

  it('row dot column reflects ROW_META_KEY confidence per row', () => {
    const classified = classifyData(FORM_PAYLOAD);
    expect(classified.tables[0]!.rows[0]![ROW_META_KEY]).toBeDefined();
    renderForm({ classified });
    const row0 = screen.getByRole('textbox', { name: 'Line Items row 1 — Description' }).closest('tr')!;
    expect(within(row0 as HTMLElement).getByRole('img', { name: 'Medium confidence' })).not.toBeNull();
    const row1 = screen.getByText('Gadget').closest('tr')!;
    expect(within(row1 as HTMLElement).queryByRole('img', { name: 'Medium confidence' })).toBeNull();
  });

  it('row click flashes ALL the row cell rects', () => {
    const onFlash = vi.fn();
    renderForm({ onFlash });
    fireEvent.click(screen.getByText('200'));
    expect(onFlash).toHaveBeenCalledTimes(1);
    expect(onFlash).toHaveBeenCalledWith([DESC_RECT, PRICE_RECT]);
  });

  it('a click on a cell INPUT does not flash', () => {
    const onFlash = vi.fn();
    renderForm({ onFlash });
    fireEvent.click(screen.getByRole('textbox', { name: 'Line Items row 1 — Description' }));
    expect(onFlash).not.toHaveBeenCalled();
  });

  it('a row with no coordinates neither flashes nor renders an eye button', () => {
    const onFlash = vi.fn();
    renderForm({ onFlash });
    fireEvent.click(screen.getByText('Gadget'));
    expect(onFlash).not.toHaveBeenCalled();
    const section = screen.getByRole('region', { name: 'Line Items' });
    expect(within(section).getAllByRole('button', { name: 'Show on document' }).length).toBe(1);
  });

  it('the row eye button flashes all rects (and only once — no row-click double fire)', () => {
    const onFlash = vi.fn();
    renderForm({ onFlash });
    const section = screen.getByRole('region', { name: 'Line Items' });
    fireEvent.click(within(section).getByRole('button', { name: 'Show on document' }));
    expect(onFlash).toHaveBeenCalledTimes(1);
    expect(onFlash).toHaveBeenCalledWith([DESC_RECT, PRICE_RECT]);
  });
});

describe('VerificationForm: fallback', () => {
  it('renders inside a native <details> with pretty-printed JSON', () => {
    const { container } = renderForm();
    const section = screen.getByRole('region', { name: 'Additional Data' });
    const details = section.querySelector('details.gemina-verification__fallback');
    expect(details).not.toBeNull();
    expect(within(details as HTMLElement).getByText('Attachments')).not.toBeNull();
    const pre = container.querySelector('details.gemina-verification__fallback pre');
    expect(pre?.textContent).toBe(JSON.stringify([[1, 2], [3, 4]], null, 2));
  });
});

describe('VerificationForm: unmatched', () => {
  it('renders empty fill-in inputs under "Not detected" with VERBATIM schema labels', () => {
    renderForm();
    const section = screen.getByRole('region', { name: 'Not detected' });
    // "PO Number" stays verbatim — formatLabel would mangle it to "Po Number".
    const input = within(section).getByRole('textbox', { name: 'PO Number' }) as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.getAttribute('placeholder')).toBe('Not detected — fill in if present');
    expect(screen.queryByText('Po Number')).toBeNull();
  });
});

describe('VerificationForm: readOnly + ordering + empty buckets', () => {
  it('readOnly renders no inputs anywhere', () => {
    renderForm({ readOnly: true });
    expect(screen.queryAllByRole('textbox').length).toBe(0);
    expect(screen.getByText('Acme Ltd')).not.toBeNull();
    expect(screen.getByText('Widget')).not.toBeNull();
  });

  it('section order matches the console: Details, entities, tables, fallback, Not detected', () => {
    const { container } = renderForm();
    const headers = Array.from(
      container.querySelectorAll('.gemina-verification__section-header'),
    ).map((el) => el.textContent);
    expect(headers).toEqual([
      'Details',
      'Suppliers (2)',
      expect.stringMatching(/^Line Items \(2 rows/),
      'Additional Data',
      'Not detected',
    ]);
  });

  it('empty buckets render nothing — no empty section shells', () => {
    const { container } = renderForm({
      classified: classifyData({ supplier_name: { value: 'Acme' } }),
      bindingIndex: new Map(),
      unmatched: [],
    });
    expect(container.querySelectorAll('.gemina-verification__section').length).toBe(1);
    expect(container.querySelector('.gemina-verification__table')).toBeNull();
    expect(container.querySelector('.gemina-verification__card')).toBeNull();
    expect(screen.queryByText('Additional Data')).toBeNull();
    expect(screen.queryByText('Not detected')).toBeNull();
  });
});

// --- Typed rendering (Phase 6) -----------------------------------------------

describe('FieldInput — typed controls', () => {
  function typedBinding(field: FieldBinding['field'], extracted: unknown = 'USD'): FieldBinding {
    return { ...scalarBinding({ extracted, serverValue: extracted }), field };
  }

  it('renders a closed roster as a select carrying every option', () => {
    render(
      <FieldInput
        binding={typedBinding({ type: 'string', enum: ['UNIT', 'BOX'] }, 'BOX')}
        edit={undefined}
        onEdit={vi.fn()}
        readOnly={false}
        ariaLabel="Unit Of Measure"
      />,
    );
    const select = screen.getByRole('combobox', { name: 'Unit Of Measure' }) as HTMLSelectElement;
    expect(select.value).toBe('BOX');
    expect([...select.options].map((o) => o.value)).toEqual(['', 'UNIT', 'BOX']);
  });

  it('keeps an off-roster extracted value as a pinned option rather than destroying it', () => {
    // The model found CRATE; the roster does not list it. Opening the select
    // must not silently rewrite the extraction.
    render(
      <FieldInput
        binding={typedBinding({ type: 'string', enum: ['UNIT', 'BOX'] }, 'CRATE')}
        edit={undefined}
        onEdit={vi.fn()}
        readOnly={false}
        ariaLabel="Unit Of Measure"
      />,
    );
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('CRATE');
    expect(screen.getByRole('option', { name: /CRATE/ })).toBeTruthy();
  });

  it('offers ISO 4217 codes as suggestions without forcing membership', () => {
    render(
      <FieldInput
        binding={typedBinding({ type: 'string', format: 'iso4217' }, 'USD')}
        edit={undefined}
        onEdit={vi.fn()}
        readOnly={false}
        ariaLabel="Currency"
      />,
    );
    // A datalist-backed input is announced as a COMBOBOX, not a textbox —
    // attaching suggestions changes the control's role.
    const input = screen.getByRole('combobox', { name: 'Currency' });
    const listId = input.getAttribute('list')!;
    expect(listId).toBeTruthy();
    const datalist = document.getElementById(listId)!;
    expect(datalist.tagName.toLowerCase()).toBe('datalist');
    expect([...datalist.querySelectorAll('option')].map((o) => o.getAttribute('value')))
      .toContain('ILS');
  });

  it('hints a decimal keyboard for numeric fields without constraining the value', () => {
    render(
      <FieldInput
        binding={typedBinding({ type: 'number' }, 1500)}
        edit={undefined}
        onEdit={vi.fn()}
        readOnly={false}
        ariaLabel="Total Amount"
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Total Amount' });
    // type stays text: the server accepts "1,500", and type=number would not.
    expect(input.getAttribute('type')).toBe('text');
    expect(input.getAttribute('inputMode') ?? input.getAttribute('inputmode')).toBe('decimal');
  });

  it('renders a date field with the native picker', () => {
    const { container } = render(
      <FieldInput
        binding={typedBinding({ type: 'date' }, '2026-08-14')}
        edit={undefined}
        onEdit={vi.fn()}
        readOnly={false}
        ariaLabel="Issue Date"
      />,
    );
    expect(container.querySelector('input[type="date"]')).not.toBeNull();
  });

  it('shows an inline error naming the fix, and marks the control invalid', () => {
    render(
      <FieldInput
        binding={typedBinding({ type: 'string', format: 'iso4217' }, 'USD')}
        edit="dollars"
        onEdit={vi.fn()}
        readOnly={false}
        ariaLabel="Currency"
      />,
    );
    const input = screen.getByRole('combobox', { name: 'Currency' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const error = screen.getByRole('alert');
    expect(error.textContent).toBe('Use a 3-letter ISO 4217 code, e.g. USD');
    // Both descriptions survive — the edited badge AND the error.
    const describedBy = input.getAttribute('aria-describedby')!.split(' ');
    expect(describedBy).toContain(error.id);
    expect(describedBy.length).toBe(2);
  });

  it('does not flag an untouched field, however odd the extracted value', () => {
    // The model's output is not the reviewer's mistake, and blocking a
    // submission they never touched would be indefensible.
    render(
      <FieldInput
        binding={typedBinding({ type: 'number' }, 'not-a-number')}
        edit={undefined}
        onEdit={vi.fn()}
        readOnly={false}
        ariaLabel="Total Amount"
      />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBeNull();
  });

  it('falls back to a plain text input with no descriptor', () => {
    render(
      <FieldInput
        binding={typedBinding(undefined, 'anything')}
        edit={undefined}
        onEdit={vi.fn()}
        readOnly={false}
        ariaLabel="Total Amount"
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Total Amount' });
    expect(input.getAttribute('type')).toBe('text');
    expect(input.getAttribute('list')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

// --- Row editing (Phase 7) ---------------------------------------------------

describe('VerificationForm: review filter', () => {
  const hide = (fields: string[] = [], rows: string[] = []) => ({
    fields: new Set(fields),
    rows: new Set(rows),
  });

  it('hides a header the filter marked, keeps the rest', () => {
    renderForm({ filterOn: true, hidden: hide(['/supplier_name']) });
    const details = screen.getByRole('region', { name: 'Details' });
    expect(within(details).queryByText('Supplier Name')).toBeNull();
    expect(within(details).getByText('Total')).not.toBeNull();
  });

  it('hides nothing when the filter is off', () => {
    renderForm({ filterOn: false, hidden: hide([]) });
    expect(screen.getByRole('region', { name: 'Details' })).not.toBeNull();
    expect(within(screen.getByRole('region', { name: 'Details' })).getByText('Supplier Name')).not.toBeNull();
  });

  it('drops a simple-list item without dropping its siblings', () => {
    const values = { tags: ['alpha', 'beta'] };
    const bindings = buildBindings(
      ['label:Tag 1|ptr:/tags/0', 'label:Tag 2|ptr:/tags/1'],
      values,
    );
    render(<VerificationForm {...formProps({
      classified: classifyData(values),
      bindingIndex: indexBindingsByFieldPointer(bindings),
      unmatched: [],
      filterOn: true,
      hidden: hide(['/tags/0']),
    })} />);
    const inputs = screen.getAllByRole('textbox');
    expect(inputs).toHaveLength(1);
    expect((inputs[0] as HTMLInputElement).value).toBe('beta');
  });

  // Renumbering after a filter relabels the survivors: with card 1 hidden,
  // card 2 would announce itself as "Supplier 1" — in the heading and, worse,
  // in the aria-label a screen-reader user relies on to know which entity
  // they are editing.
  it('keeps original entity numbering when an earlier card is hidden', () => {
    const values = {
      suppliers: [
        { name: 'First Co' },
        { name: 'Second Co' },
      ],
    };
    const bindings = buildBindings(
      ['label:Supplier 1 Name|ptr:/suppliers/0/name', 'label:Supplier 2 Name|ptr:/suppliers/1/name'],
      values,
    );
    render(<VerificationForm {...formProps({
      classified: classifyData(values),
      bindingIndex: indexBindingsByFieldPointer(bindings),
      unmatched: [],
      filterOn: true,
      hidden: { fields: new Set(['/suppliers/0/name']), rows: new Set<string>() },
    })} />);

    // The surviving card is the SECOND one and must still say so.
    expect(screen.getByText('Supplier 2')).toBeTruthy();
    expect(screen.queryByText('Supplier 1')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Supplier 2 — Name' })).toBeTruthy();
    // The heading reports how many entities exist, which the filter never changes.
    expect(screen.getByText('Suppliers (2)')).toBeTruthy();
  });

  it('keeps an entity card that still has one visible cell', () => {
    renderForm({ filterOn: true, hidden: hide(['/suppliers/0/name']) });
    // The card survives because its other cell is untouched by the filter.
    expect(screen.queryByRole('region', { name: 'Suppliers' })).not.toBeNull();
  });
});

describe('VerificationForm: row-mutable tables', () => {
  const TEMPLATE = 'label:line_{index}_{field}|ptr:/line_items/{index}/{field}';
  // FOUR columns minimum: `isTableArray` requires >3 non-meta fields, so a
  // narrower array classifies as entity CARDS and never reaches TableSection.
  // Real line_items carry ~19 columns, so this is a fixture constraint rather
  // than a product limit — but a row-mutable table of 3 columns or fewer would
  // get no row controls, which is worth knowing.
  const COLS = ['description', 'unit_of_measure', 'quantity', 'item_code'];
  const MUTABLE = {
    pointer: '/line_items',
    keyTemplate: TEMPLATE,
    columns: [
      { key: 'description', label: 'description', type: 'string' as const },
      { key: 'unit_of_measure', label: 'unit_of_measure', type: 'string' as const, enum: ['UNIT', 'BOX'] },
      { key: 'quantity', label: 'quantity', type: 'number' as const },
      { key: 'item_code', label: 'item_code', type: 'string' as const },
    ],
  };

  function renderTable(descriptions: string[], extra: Partial<VerificationFormProps> = {}) {
    const values = {
      line_items: descriptions.map((description) => ({
        description, unit_of_measure: 'UNIT', quantity: 1, item_code: 'X',
      })),
    };
    const schema = descriptions.flatMap((_v, i) => COLS.map(
      (c) => `label:line_${i}_${c}|ptr:/line_items/${i}/${c}`,
    ));
    const fields = descriptions.flatMap((_v, i) => MUTABLE.columns.map((column) => ({
      key: `label:line_${i}_${column.key}|ptr:/line_items/${i}/${column.key}`,
      label: column.key,
      type: column.type,
      enum: column.enum ?? null,
    })));
    const bindings = buildBindings(schema, values, fields);
    const byRaw = new Map(bindings.map((b) => [b.key.raw, b]));
    const plan = initialRowPlan(descriptions.length);
    const planned = new Map([[MUTABLE.pointer, planTableCells(MUTABLE, plan, COLS, byRaw)]]);
    const base = {
      classified: classifyData(values),
      bindingIndex: indexBindingsByFieldPointer(bindings),
      rowMutableTables: [MUTABLE],
      plannedTables: planned,
      ...extra,
    };
    const view = render(<VerificationForm {...formProps(base)} />);
    return {
      ...view,
      plan,
      rerenderWith: (more: Partial<VerificationFormProps>) =>
        view.rerender(<VerificationForm {...formProps({ ...base, ...more })} />),
    };
  }

  it('offers per-row insert and remove controls, numbered for a screen reader', () => {
    renderTable(['A', 'B']);
    // Row-numbered: "Remove line" repeated N times is unusable with AT.
    expect(screen.getByRole('button', { name: 'Remove line 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove line 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Insert line below line 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /add line/i })).toBeTruthy();
  });

  // §F4: the row memo compares an explicit whitelist of `shared` fields, so a
  // new flag that rows must react to has to join it. `filterOn` is a stable
  // boolean, which is why it may — unlike the edits-derived `hidden` set,
  // which would re-render every row on every keystroke.
  it('drops row controls on already-rendered rows when the filter turns on', () => {
    const { rerenderWith } = renderTable(['A', 'B']);
    expect(screen.getByRole('button', { name: 'Insert line below line 1' })).toBeTruthy();
    rerenderWith({ filterOn: true });
    expect(screen.queryByRole('button', { name: 'Insert line below line 1' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove line 1' })).toBeNull();
  });

  it('replaces a fully-hidden table with a summary instead of an empty grid', () => {
    // renderTable builds its plan with initialRowPlan(n) — unscoped — so the
    // ids are `#row-0`, `#row-1`. Hidden rows are keyed by entry.id verbatim.
    const rowIds = initialRowPlan(2).map((entry) => entry.id);
    renderTable(['A', 'B'], {
      filterOn: true,
      hidden: { fields: new Set<string>(), rows: new Set(rowIds) },
    });
    expect(screen.getByText('All 2 rows scored high')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  // The table analogue of the entity-card numbering case above, and the reason
  // the shared row traversal carries a `position` rather than letting the
  // caller re-index: a row's position is its index in the UNFILTERED plan and
  // travels with it through the filter. Renumbering the survivors 1..n would
  // relabel line 3 as line 2 under a screen reader, and — the moment row
  // editing and row hiding ever coexist — point onAddRow/onRemoveRow, which
  // take a plan position, at the wrong line.
  it('keeps original row numbering when an earlier row is hidden', () => {
    // renderTable builds its plan with initialRowPlan(n) — unscoped — so the
    // ids are `#row-0`, `#row-1`, `#row-2`.
    const rowIds = initialRowPlan(3).map((entry) => entry.id);
    renderTable(['A', 'B', 'C'], {
      filterOn: true,
      hidden: { fields: new Set<string>(), rows: new Set([rowIds[0]!]) },
    });
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + B + C
    expect(screen.getByLabelText('Line Items row 2 — Description')).toBeTruthy();
    expect(screen.getByLabelText('Line Items row 3 — Description')).toBeTruthy();
    expect(screen.queryByLabelText('Line Items row 1 — Description')).toBeNull();
  });

  // §R2 — an added row is NOT in table.rows, so a filter written over that
  // collection would hide the reviewer's own new row behind the summary.
  it('keeps an added row visible when every extracted row is hidden', () => {
    const values = { line_items: [{ description: 'A', unit_of_measure: 'UNIT', quantity: 1, item_code: 'X' }] };
    const bindings = buildBindings(
      COLS.map((c) => `label:line_0_${c}|ptr:/line_items/0/${c}`),
      values,
    );
    const plan = insertRowAfter(initialRowPlan(1), 0);
    const planned = new Map([[MUTABLE.pointer, planTableCells(
      MUTABLE, plan, COLS, new Map(bindings.map((b) => [b.key.raw, b])),
    )]]);
    render(<VerificationForm {...formProps({
      classified: classifyData(values),
      bindingIndex: indexBindingsByFieldPointer(bindings),
      rowMutableTables: [MUTABLE],
      plannedTables: planned,
      filterOn: true,
      // Only the EXTRACTED row is hidden; the added row has no confidence.
      hidden: { fields: new Set<string>(), rows: new Set([plan[0]!.id]) },
    })} />);
    expect(screen.queryByText(/All \d+ rows scored high/)).toBeNull();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(2); // header + the added row
  });

  // The controls' absence has to be explained where it is noticed. It cannot
  // be explained ON them: Tip binds hover/focus handlers to its child and a
  // disabled button dispatches neither, so a tooltip there is unreachable.
  it('explains in the section header why row editing is unavailable', () => {
    renderTable(['A', 'B'], { filterOn: true });
    expect(screen.getByText('Row editing is off while filtering')).toBeTruthy();
  });

  it('shows no such note when the filter is off', () => {
    renderTable(['A', 'B']);
    expect(screen.queryByText('Row editing is off while filtering')).toBeNull();
  });

  it('reports the removal to the parent with the SERVER pointer and the position', () => {
    const onRemoveRow = vi.fn();
    renderTable(['A', 'B', 'C'], { onRemoveRow });
    fireEvent.click(screen.getByRole('button', { name: 'Remove line 2' }));
    expect(onRemoveRow).toHaveBeenCalledWith('/line_items', 1);
  });

  it('appends via Add line at the end of the table', () => {
    const onAddRow = vi.fn();
    renderTable(['A', 'B'], { onAddRow });
    fireEvent.click(screen.getByRole('button', { name: /add line/i }));
    expect(onAddRow).toHaveBeenCalledWith('/line_items', 1);
  });

  it('renders an added row with the SAME typed controls as an extracted one', () => {
    const values = {
      line_items: [{ description: 'A', unit_of_measure: 'UNIT', quantity: 1, item_code: 'X' }],
    };
    const bindings = buildBindings(
      COLS.map((c) => `label:line_0_${c}|ptr:/line_items/0/${c}`),
      values,
    );
    const plan = insertRowAfter(initialRowPlan(1), 0);
    const planned = new Map([[MUTABLE.pointer, planTableCells(
      MUTABLE, plan, COLS, new Map(bindings.map((b) => [b.key.raw, b])),
    )]]);
    render(<VerificationForm {...formProps({
      classified: classifyData(values),
      bindingIndex: indexBindingsByFieldPointer(bindings),
      rowMutableTables: [MUTABLE],
      plannedTables: planned,
    })} />);

    // Row 2 is the added one: its UoM cell is a select, exactly like row 1's,
    // and its description is an empty fill-in rather than a missing binding.
    const uom = screen.getByRole('combobox', { name: 'Line Items row 2 — Unit Of Measure' });
    expect([...(uom as HTMLSelectElement).options].map((o) => o.value)).toContain('BOX');
    const description = screen.getByRole('textbox', {
      name: 'Line Items row 2 — Description',
    }) as HTMLInputElement;
    expect(description.value).toBe('');
  });

  it('offers no row controls when the server did not declare the table mutable', () => {
    const values = {
      line_items: [{ description: 'A', unit_of_measure: 'UNIT', quantity: 1, item_code: 'X' }],
    };
    const bindings = buildBindings(
      COLS.map((c) => `label:line_0_${c}|ptr:/line_items/0/${c}`), values,
    );
    render(<VerificationForm {...formProps({
      classified: classifyData(values),
      bindingIndex: indexBindingsByFieldPointer(bindings),
    })} />);
    expect(screen.queryByRole('button', { name: /add line/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove line/i })).toBeNull();
  });

  it('offers no row controls in read-only mode', () => {
    renderTable(['A'], { readOnly: true });
    expect(screen.queryByRole('button', { name: /add line/i })).toBeNull();
  });

  it('promotes a ZERO-row mutable table, which the classifier calls a header', () => {
    // The case the feature exists for: the model found no lines at all.
    const values = { line_items: [] };
    render(<VerificationForm {...formProps({
      classified: classifyData(values),
      bindingIndex: new Map(),
      rowMutableTables: [MUTABLE],
      plannedTables: new Map([[MUTABLE.pointer, planTableCells(MUTABLE, [], COLS, new Map())]]),
    })} />);

    expect(screen.getByRole('columnheader', { name: 'Description' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /add line/i })).toBeTruthy();
    // ...and it does NOT also render as an empty header field.
    expect(screen.queryByRole('textbox', { name: 'Line Items' })).toBeNull();
  });
});

/**
 * The SECOND review filter, at the point where it actually removes something.
 *
 * `emptyColumns` is a render filter and nothing else: the payload is composed
 * from bindings and edits, never from the DOM, so a hidden column submits
 * exactly what it would have submitted visible. What these tests pin is the
 * part that IS observable — which cells leave the grid, which cells may never
 * leave it, and that filtering does not cost a re-render per row per keystroke.
 */
describe('VerificationForm: empty columns', () => {
  const TEMPLATE = 'label:line_{index}_{field}|ptr:/line_items/{index}/{field}/value';
  // FOUR columns minimum — isTableArray wants >3 non-meta fields — and
  // `discount` is the one nothing was extracted into, which is the normal
  // state of real line items rather than an edge case: a real
  // invoice_line_items table declares 19 columns and leaves 5 to 16 of them
  // blank in every row.
  const COLS = ['description', 'quantity', 'discount', 'item_code'];
  const MUTABLE = {
    pointer: '/line_items',
    keyTemplate: TEMPLATE,
    columns: COLS.map((key) => ({ key, label: key, type: 'string' as const, enum: null })),
  };
  /** The rendered table pointer — the key `TableSection` looks `emptyColumns`
   *  up with, and the only spelling a hand-written map may use. */
  const POINTER = '/line_items';

  // Blanks are bare `null` with the key present, which is what every blank
  // cell of every real extraction sampled looked like. Row 1 carries cell
  // coordinates and a row-level confidence so the eye cell and the row-dot
  // cell exist to be preserved (F12).
  const VALUES = {
    line_items: [
      {
        description: { value: 'Widget', coordinates: { relative: DESC_RECT.points }, confidence: 'low' },
        quantity: { value: 2 },
        discount: null,
        item_code: { value: 'X' },
        confidence: 'medium',
      },
      {
        description: { value: 'Gadget' },
        quantity: { value: 1 },
        discount: null,
        item_code: { value: 'Y' },
      },
    ],
  };

  /** Every column blank in every row — §D4's case, built as data so the RULE
   *  gets to decide, rather than by hand-writing a map it would never emit. */
  const ALL_BLANK = {
    line_items: [
      { description: null, quantity: null, discount: null, item_code: null, confidence: 'medium' },
      { description: null, quantity: null, discount: null, item_code: null },
    ],
  };

  function tableProps(
    values: { line_items: unknown[] },
    extra: Partial<VerificationFormProps> = {},
  ): VerificationFormProps {
    const schema = values.line_items.flatMap(
      (_row, index) => COLS.map((column) => cellSchemaKey(TEMPLATE, index, column)),
    );
    const bindings = buildBindings(schema, values);
    const byRaw = new Map(bindings.map((binding) => [binding.key.raw, binding]));
    const plan = initialRowPlan(values.line_items.length);
    return formProps({
      classified: classifyData(values),
      bindingIndex: indexBindingsByFieldPointer(bindings),
      unmatched: [],
      rowMutableTables: [MUTABLE],
      plannedTables: new Map([[MUTABLE.pointer, planTableCells(MUTABLE, plan, COLS, byRaw)]]),
      ...extra,
    });
  }

  /** What the root passes when the switch is on and `discount` qualified. */
  const hideDiscount = () => new Map([[POINTER, new Set(['discount'])]]);

  /** The <th>s that name a data column — the eye, row-dot and row-action
   *  headers are deliberately empty (they carry aria-labels instead). */
  function dataHeaders(section: HTMLElement): string[] {
    return within(section)
      .getAllByRole('columnheader')
      .map((th) => th.textContent ?? '')
      .filter((text) => text !== '');
  }

  it('drops the <th> and every matching <td> for a hidden column', () => {
    render(<VerificationForm {...tableProps(VALUES, { emptyColumns: hideDiscount() })} />);
    const section = screen.getByRole('region', { name: 'Line Items' });

    expect(within(section).queryByRole('columnheader', { name: 'Discount' })).toBeNull();
    expect(dataHeaders(section)).toEqual(['Description', 'Quantity', 'Item Code']);
    // Both sides, or a <thead>-only filter leaves every row one cell wider
    // than its header and the grid shears.
    expect(screen.queryByLabelText('Line Items row 1 — Discount')).toBeNull();
    expect(screen.queryByLabelText('Line Items row 2 — Discount')).toBeNull();

    // The surviving columns still carry their values, in both rows.
    expect(
      screen.getByLabelText<HTMLInputElement>('Line Items row 1 — Description').value,
    ).toBe('Widget');
    expect(
      screen.getByLabelText<HTMLInputElement>('Line Items row 2 — Item Code').value,
    ).toBe('Y');
  });

  // F12: the document-eye, the confidence dot and the insert/remove controls
  // are <td>s OF THE ROW. They are the reason there is no "everything is
  // hidden" branch anywhere in this feature — a stand-in for the grid takes
  // all three down with it.
  it('keeps the eye, confidence and row-action cells', () => {
    render(<VerificationForm {...tableProps(VALUES, { emptyColumns: hideDiscount() })} />);
    const row = screen.getByLabelText('Line Items row 1 — Description').closest('tr') as HTMLElement;

    expect(within(row).getByRole('button', { name: 'Show on document' })).toBeTruthy();
    expect(within(row).getByRole('img', { name: 'Medium confidence' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Insert line below line 1' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Remove line 1' })).toBeTruthy();
    // An EXACT count, not "at least": eye + row confidence + three visible
    // data columns + row actions. A filter applied to the <thead> alone, or a
    // row still handed the unfiltered `columns`, reads 7 here.
    expect(row.querySelectorAll('td')).toHaveLength(6);
  });

  // §D4 END TO END — the rule and the renderer against one fixture, which is
  // what this pins and all it pins. The rule's own §D4 coverage (including a
  // two-table world, where the neighbour still reports its blank column) is
  // empty-columns.test.ts; what cannot be asserted there is that the grid the
  // rule protected actually renders whole, with the affordances F12 names.
  it('runs the real rule over an all-blank table and renders every column, dot and control', () => {
    const props = tableProps(ALL_BLANK);
    const emptyColumns = computeEmptyColumns({
      tables: props.classified.tables,
      plannedTables: props.plannedTables!,
      rowMutableTables: props.rowMutableTables!,
      bindingIndex: props.bindingIndex,
      touchedEver: new Set<string>(),
      pairErrors: new Map<string, string>(),
    });
    // Every one of the four columns is blank in every row, and the rule still
    // hands the table nothing to hide.
    expect(emptyColumns.size).toBe(0);

    render(<VerificationForm {...props} emptyColumns={emptyColumns} />);
    const section = screen.getByRole('region', { name: 'Line Items' });
    expect(dataHeaders(section)).toEqual(['Description', 'Quantity', 'Discount', 'Item Code']);
    expect(within(section).getByRole('table')).toBeTruthy();
    expect(within(section).getByRole('img', { name: 'Medium confidence' })).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Remove line 1' })).toBeTruthy();
    expect(within(section).getByRole('button', { name: /add line/i })).toBeTruthy();
  });

  /**
   * The two-table world, built from the shared F16 fixture through the
   * component's own derivation chain (index.tsx: classifyData / buildBindings
   * / seedRowPlans / declaredTableColumns + planTableCells). 19 declared
   * line-item columns with 11 blank in every row, beside a 5-column `/taxes`
   * whose `base` is blank — the real production shape, invented content.
   */
  function fixtureProps(extra: Partial<VerificationFormProps> = {}): VerificationFormProps {
    const view = wideTableExtraction({ withTaxes: true });
    const values = view.values as Record<string, unknown>;
    const feedback = (view.meta as { validationFeedback: Record<string, unknown> }).validationFeedback;
    const rowMutableTables = readRowMutableTables(feedback.rowMutableTables);
    const classified = classifyData(values);
    const bindings = buildBindings(
      feedback.validationSchema as string[],
      values,
      readDescriptors(feedback.validationFields),
    );
    const byRaw = new Map(bindings.map((binding) => [binding.key.raw, binding]));
    const plannedTables = new Map<string, PlannedRow[]>();
    for (const table of rowMutableTables) {
      const plan = initialRowPlan(countRowsAt(values, table.pointer), table.pointer);
      plannedTables.set(
        table.pointer,
        planTableCells(table, plan, declaredTableColumns(table, classified.tables), byRaw),
      );
    }
    return formProps({
      classified,
      bindingIndex: indexBindingsByFieldPointer(bindings),
      unmatched: [],
      rowMutableTables,
      plannedTables,
      ...extra,
    });
  }

  // THE POINTER IS THE LOOKUP. `emptyColumns` is keyed by the rendered table
  // pointer and every table reads its OWN entry — with one table on screen
  // nothing distinguishes that from grabbing whatever the map happens to hold,
  // and a build that applied one table's blank columns to its neighbour would
  // ship green. Two tables, two different entries, and the assertions cross:
  // the taxes grid must lose `base` and nothing else, which no line-items
  // entry can do for it (their column names do not overlap at all).
  it('reads each table\'s own entry — a neighbour\'s hidden columns are not applied', () => {
    const props = fixtureProps();
    const emptyColumns = computeEmptyColumns({
      tables: props.classified.tables,
      plannedTables: props.plannedTables!,
      rowMutableTables: props.rowMutableTables!,
      bindingIndex: props.bindingIndex,
      touchedEver: new Set<string>(),
      pairErrors: new Map<string, string>(),
    });
    // Both tables qualified, separately — the premise of the test.
    expect([...emptyColumns.keys()].sort()).toEqual(['/line_items', '/taxes']);

    render(<VerificationForm {...props} emptyColumns={emptyColumns} />);

    // 19 declared columns, 11 blank in every row: the 8 populated survive, in
    // server order, and the sparsely-populated one is among them.
    expect(dataHeaders(screen.getByRole('region', { name: 'Line Items' }))).toEqual([
      'Line Number', 'Description', 'Item Code', 'Quantity',
      'Unit Of Measure', 'Unit Price', 'Discount Percentage', 'Line Total',
    ]);
    // ...and the neighbour dropped ITS blank column, which is the assertion a
    // pointer-blind lookup cannot satisfy: `base` is in no other table's set.
    expect(dataHeaders(screen.getByRole('region', { name: 'Taxes' }))).toEqual([
      'Type', 'Name', 'Rate', 'Amount',
    ]);
    expect(screen.queryByLabelText('Taxes row 1 — Base')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Taxes row 1 — Amount').value).toBe('44.03');
  });

  /**
   * The §D2 note. It goes on each table rather than into the footer's
   * "Showing X of Y", which counts review UNITS — fields and rows. A column is
   * not a unit, and folding it in would make one number mean two things.
   *
   * The note reads `.gemina-verification__filter-note`, shared with the row-
   * editing note AND with the *Add line* note in the table footer, so read it
   * by CONTAINER: the class alone names three different statements, and two of
   * them can be on a header at once.
   */
  function filterNotes(section: HTMLElement): string[] {
    return [...section.querySelectorAll(
      '.gemina-verification__section-header .gemina-verification__filter-note',
    )].map((node) => node.textContent ?? '');
  }

  /** The §D1 note that sits beside *Add line*, in the table footer. */
  function addLineNotes(section: HTMLElement): string[] {
    return [...section.querySelectorAll(
      '.gemina-verification__table-footer .gemina-verification__filter-note',
    )].map((node) => node.textContent ?? '');
  }

  it('states the hidden-column count on each affected table', () => {
    const props = fixtureProps();
    const emptyColumns = computeEmptyColumns({
      tables: props.classified.tables,
      plannedTables: props.plannedTables!,
      rowMutableTables: props.rowMutableTables!,
      bindingIndex: props.bindingIndex,
      touchedEver: new Set<string>(),
      pairErrors: new Map<string, string>(),
    });
    render(<VerificationForm {...props} emptyColumns={emptyColumns} />);

    // Per table, and the two numbers differ — one note copied to both headers,
    // or a single count summed across tables, reads the same on one table and
    // wrong here. Plural and singular in the same render, because "1 columns
    // hidden" is the kind of thing that ships.
    //
    // The trailing clause is load-bearing, not decoration, and it is the ONE
    // claim that survives every state: the columns counted here are blank
    // across the whole row plan, and the plan rows are a superset of the rows
    // on screen. "N empty columns" unqualified invites a check against the
    // grid, where the confidence filter can make it read false; "empty in this
    // extraction" is false the moment a row is REMOVED, because the plan drops
    // that row and a column populated only in it then qualifies.
    expect(filterNotes(screen.getByRole('region', { name: 'Line Items' })))
      .toEqual(['11 columns hidden — blank in every row']);
    expect(filterNotes(screen.getByRole('region', { name: 'Taxes' })))
      .toEqual(['1 column hidden — blank in every row']);
  });

  it('states nothing on a table with no hidden columns', () => {
    // The same two-table world, with only the NEIGHBOUR filtered. A note
    // rendered unconditionally would say "0 columns hidden" on a full table —
    // a report of an absence that is not there.
    render(
      <VerificationForm
        {...fixtureProps()}
        emptyColumns={new Map([['/taxes', new Set(['base'])]])}
      />,
    );

    expect(filterNotes(screen.getByRole('region', { name: 'Line Items' }))).toEqual([]);
    expect(filterNotes(screen.getByRole('region', { name: 'Taxes' })))
      .toEqual(['1 column hidden — blank in every row']);
  });

  it('counts the columns actually dropped, not the size of the host’s set', () => {
    // `emptyColumns` is a PUBLIC prop. A host may hand over a name that is not
    // a column of this table at all — a stale set, or one keyed in the wrong
    // casing — and then `hiddenColumns.size` and `columns.length -
    // visibleColumns.length` disagree. Only the subtraction can be right: it
    // counts what left the grid. The rule's own output can never trigger this,
    // so nothing but this test stands between the two.
    render(
      <VerificationForm
        {...tableProps(VALUES)}
        emptyColumns={new Map([[POINTER, new Set(['discount', 'no_such_column'])]])}
      />,
    );
    const section = screen.getByRole('region', { name: 'Line Items' });

    expect(dataHeaders(section)).toEqual(['Description', 'Quantity', 'Item Code']);
    expect(filterNotes(section)).toEqual(['1 column hidden — blank in every row']);
  });

  it('keeps row add/remove available while columns are hidden', () => {
    // §D1. The confidence filter turns row editing OFF because hiding rows
    // renumbers them, so "insert below line 3" stops meaning anything. Rows
    // keep their identity under THIS filter, so that rationale does not
    // transfer and the controls stay — along with the note explaining their
    // absence, which must not appear when they are not absent.
    render(<VerificationForm {...tableProps(VALUES, { emptyColumns: hideDiscount() })} />);
    const section = screen.getByRole('region', { name: 'Line Items' });

    expect(within(section).getByRole('button', { name: 'Insert line below line 1' })).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Remove line 1' })).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Remove line 2' })).toBeTruthy();
    expect(within(section).getByRole('button', { name: /add line/i })).toBeTruthy();
    expect(filterNotes(section)).toEqual(['1 column hidden — blank in every row']);
    // The column really is hidden while all of that is true.
    expect(screen.queryByLabelText('Line Items row 1 — Discount')).toBeNull();
  });

  /* §D1's accepted consequence and its way out (Task 7's copy pass).
   *
   * Keeping row editing on means a line added now has no input for the hidden
   * columns. That is a limit on *Add line*, not a fact about the extraction,
   * so it is stated in the table footer beside the button rather than folded
   * into the header's count — one job per element, and this one is met where
   * the button is. These pin the placement, not just the words: a note that
   * drifted into the header would still pass a text-only assertion. */
  it('states the added-line limit beside Add line, and the way out of it', () => {
    render(<VerificationForm {...tableProps(VALUES, { emptyColumns: hideDiscount() })} />);
    const section = screen.getByRole('region', { name: 'Line Items' });

    expect(addLineNotes(section)).toEqual([
      'New lines can only fill the visible columns'
        + ' — turn off “Hide empty columns” to reach the rest.',
    ]);
    // The header's note keeps its one job: the count, and nothing about rows.
    expect(filterNotes(section)).toEqual(['1 column hidden — blank in every row']);
    // The way out names the switch it names in the footer — an action keeps
    // one name everywhere it is spoken about — and it is a SENTENCE, not a
    // second control: a per-table button flipping the one global switch would
    // claim a scope it does not have on a multi-table extraction.
    expect(within(section).queryByRole('button', { name: /empty columns/i })).toBeNull();
  });

  it('says nothing beside Add line when the table lost no columns', () => {
    render(<VerificationForm {...tableProps(VALUES)} />);
    const section = screen.getByRole('region', { name: 'Line Items' });

    expect(within(section).getByRole('button', { name: /add line/i })).toBeTruthy();
    expect(addLineNotes(section)).toEqual([]);
  });

  it('says nothing beside Add line in read-only mode — there is no Add line', () => {
    // §D5: the switch stays available on a validated extraction, so columns
    // are hidden there too. Nothing can be added, so the limit does not exist
    // and stating it would be an instruction with no action behind it.
    render(
      <VerificationForm
        {...tableProps(VALUES, { emptyColumns: hideDiscount(), readOnly: true })}
      />,
    );
    const section = screen.getByRole('region', { name: 'Line Items' });

    expect(within(section).queryByRole('button', { name: /add line/i })).toBeNull();
    expect(addLineNotes(section)).toEqual([]);
    expect(filterNotes(section)).toEqual(['1 column hidden — blank in every row']);
  });

  // The optional-prop contract the row props already have: a host — or a test
  // — rendering the form directly need not know this filter exists.
  it('renders unchanged when emptyColumns is omitted', () => {
    render(<VerificationForm {...tableProps(VALUES)} />);
    const section = screen.getByRole('region', { name: 'Line Items' });
    expect(dataHeaders(section)).toEqual(['Description', 'Quantity', 'Discount', 'Item Code']);
    expect(screen.getByLabelText('Line Items row 1 — Discount')).toBeTruthy();
    expect(screen.getByLabelText('Line Items row 2 — Discount')).toBeTruthy();
  });

  // The reason the visible-column array is memoized on a positional bitmask
  // instead of being filtered inline: `columns` IS compared by
  // `areRowPropsEqual`, and `emptyColumns` is derived from `edits`, so a fresh
  // Map and a fresh Set arrive on every keystroke. A new array per render
  // re-renders all 169 rows of a real line-items table per character typed —
  // with byte-identical DOM, which is why this counts renders instead.
  it('does not re-render an untouched row on a keystroke while filtering', () => {
    // Built ONCE: `formProps` mints a fresh `classified` and `bindingIndex`
    // per call, and either one rebuilt per render defeats every row bail-out
    // on its own — the assertion would then fail for the wrong reason.
    const base = tableProps(VALUES);

    function Harness() {
      const [edits, setEdits] = useState<ReadonlyMap<string, string>>(new Map());
      const onEdit = useCallback((editKey: string, value: string) => {
        setEdits((previous) => new Map(previous).set(editKey, value));
      }, []);
      // A fresh Map AND a fresh Set on every render — exactly what the root's
      // `computeEmptyColumns` memo produces, since it re-runs on `edits`.
      const emptyColumns = new Map([[POINTER, new Set(['discount'])]]);
      return (
        <VerificationForm {...base} edits={edits} onEdit={onEdit} emptyColumns={emptyColumns} />
      );
    }

    render(<Harness />);
    // Probe wired: the first commit rendered both rows.
    expect(probe.rowRenders).toBe(2);

    probe.rowRenders = 0;
    const cell = screen.getByLabelText<HTMLInputElement>('Line Items row 1 — Description');
    fireEvent.change(cell, { target: { value: 'WidgetX' } });

    expect(cell.value).toBe('WidgetX');
    // Row 2 shares nothing with the edit — and never re-rendered.
    expect(
      screen.getByLabelText<HTMLInputElement>('Line Items row 2 — Description').value,
    ).toBe('Gadget');
    expect(probe.rowRenders).toBe(1);
    // ...and the filter is still doing its job while that is true.
    expect(screen.queryByLabelText('Line Items row 1 — Discount')).toBeNull();
  });
});

describe('VerificationForm: low-confidence rows', () => {
  const COLS = ['description', 'unit_of_measure', 'quantity', 'item_code'];
  function renderRows(levels: Array<string | null>) {
    const values = {
      line_items: levels.map((level, i) => ({
        description: `Row ${i}`, unit_of_measure: 'UNIT', quantity: 1, item_code: 'X',
        ...(level ? { confidence: level } : {}),
      })),
    };
    const bindings = buildBindings([], values);
    return render(<VerificationForm {...formProps({
      classified: classifyData(values),
      bindingIndex: indexBindingsByFieldPointer(bindings),
      unmatched: [],
    })} />);
  }

  it('marks a row whose confidence is not high', () => {
    const { container } = renderRows(['low', 'high']);
    const rows = container.querySelectorAll('tbody tr');
    expect(rows[0]!.classList.contains('gemina-verification__row--low')).toBe(true);
    expect(rows[1]!.className).not.toMatch(/--(low|medium)/);
  });

  it('marks medium as well as low — the scale is closed, so it is total', () => {
    const { container } = renderRows(['medium']);
    expect(container.querySelector('tbody tr')!.classList
      .contains('gemina-verification__row--medium')).toBe(true);
  });

  it('leaves an unmeasured row unmarked — no confidence is not low confidence', () => {
    const { container } = renderRows([null]);
    expect(container.querySelector('tbody tr')!.className).not.toMatch(/--(low|medium)/);
  });

  it('counts the rows needing review in the section header', () => {
    renderRows(['low', 'medium', 'high']);
    expect(screen.getByText(/3 rows · 2 need review/)).toBeTruthy();
  });

  it('says nothing about review when every row is confident', () => {
    renderRows(['high', 'high']);
    expect(screen.queryByText(/need review/)).toBeNull();
  });
});

describe('VerificationForm: field descriptions', () => {
  it('shows the model\'s field description as a tooltip on the label', async () => {
    const values = { currency: { value: 'USD' } };
    const bindings = buildBindings(
      ['label:currency|ptr:/currency/value'], values,
      [{ key: 'label:currency|ptr:/currency/value', label: 'currency', type: 'string',
         description: 'ISO 4217 code of the invoice currency' }],
    );
    render(<VerificationForm {...formProps({
      classified: classifyData(values),
      bindingIndex: indexBindingsByFieldPointer(bindings),
      unmatched: [],
    })} />);

    fireEvent.mouseEnter(screen.getByText('Currency'));
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe('ISO 4217 code of the invoice currency');
  });

  it('leaves a label with no description as plain text — no empty tooltip', () => {
    const values = { currency: { value: 'USD' } };
    const bindings = buildBindings(['label:currency|ptr:/currency/value'], values);
    render(<VerificationForm {...formProps({
      classified: classifyData(values),
      bindingIndex: indexBindingsByFieldPointer(bindings),
      unmatched: [],
    })} />);

    const label = screen.getByText('Currency');
    expect(label.className).not.toMatch(/label-described/);
    fireEvent.mouseEnter(label);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('makes a described label keyboard-reachable, so the tooltip is not mouse-only', () => {
    const values = { currency: { value: 'USD' } };
    const bindings = buildBindings(
      ['label:currency|ptr:/currency/value'], values,
      [{ key: 'label:currency|ptr:/currency/value', label: 'currency', type: 'string',
         description: 'ISO 4217 code' }],
    );
    render(<VerificationForm {...formProps({
      classified: classifyData(values),
      bindingIndex: indexBindingsByFieldPointer(bindings),
      unmatched: [],
    })} />);
    expect(screen.getByText('Currency').getAttribute('tabIndex')).toBe('0');
  });
});
