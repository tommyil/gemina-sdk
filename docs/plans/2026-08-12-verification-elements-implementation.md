# GeminaVerification Elements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship `<GeminaVerification>` — a zero-UI-dependency React human-verification component in `@gemina/elements` at the new subpath `@gemina/elements/verification` — plus the gated SDK regen/pin work that gives it runtime bearer auth. The component self-fetches one extraction (image URLs, values, `validated`, `validationFeedback` schema), renders a zoomable document viewer next to shape-classified editable fields, and submits one-shot feedback via `PUT /api/v1/documents/extractions/{id}/feedback`, handing the corrected payload to the host via `onComplete`.

**Architecture:** One new source directory `packages/elements/src/verification/` split by responsibility: pure logic first (`pointer.ts` RFC-6901 + schema-key parsing, `classify.ts` ported shape classifier with pointer tracking, `bindings.ts` field↔key binder + submission composer, `viewer-math.ts` rotation-aware zoom math), then presentation (`styles.ts` injected scoped CSS, `viewer.tsx` zoomable image viewer, `form.tsx` shape renderers), then the stateful root (`index.tsx` — fetch/state machine/submit). Auth flows only through the existing `GeminaTokenManager`; HTTP through `GeminaClient.withSessionToken` from `@gemina/sdk`, error-matched by shape (never `instanceof`). Everything follows the `<GeminaChat>` house style: scoped-CSS injection (`ensureStylesInjected`, one `<style data-gemina-verification>` tag), `--gemina-verification-*` CSS variables with `--dark`/`--auto` theming, `dir` auto/RTL via logical properties, SSR-safe (no `window`/`document` at import time), 401 invalidate+single-retry.

**Tech Stack:** React 18 (peer), TypeScript strict, tsup (esm+cjs+dts), vitest + @testing-library/react + happy-dom, `@gemina/sdk` (types available today at the pinned 0.2.0; runtime bearer wiring arrives with the gated regen). No antd, no CSS files, no new dependencies.

---

## Context for a zero-context engineer

**Repos and paths (all absolute):**

- This repo: `/home/chronic/gemina/gemina-sdk`. Component lives in `packages/elements`.
- House-style reference (READ BEFORE CODING): `packages/elements/src/chat.tsx` (styles/injection/theming/RTL/error-shape/401 patterns), `packages/elements/src/token-manager.ts`, `packages/elements/test/chat.test.tsx` (test idioms: `vi.hoisted` + `vi.mock('@gemina/sdk')`, `httpError()` response-shaped rejections).
- Console source being ported (read-only; logic reference): `/home/chronic/gemina/gemina-console/src/components/viewers/ZoomableImageViewer.tsx` and `/home/chronic/gemina/gemina-console/src/pages/extractions/components/FormView/{utils.ts,index.tsx,DataTable.tsx,HeaderFields.tsx,EntityCard.tsx,FieldValue.tsx,FallbackJson.tsx}`.
- Backend source (read-only; semantics reference): `/mnt/c/gem/gemina-api-v2/src/app/common/validator/data_validator.py`, `.../common/validator/utils.py` (`json_pointer_get`), `.../components/documents/utils.py`, `router.py`.
- Design doc: `/home/chronic/gemina/gemina-console/docs/plans/2026-08-12-verification-component-design.md`.

**Verified facts this plan relies on (checked against source, 2026-08-12):**

1. **The design doc overstates the SDK gap.** `@gemina/sdk@0.2.0` (what `packages/elements` resolves today) ALREADY exports every type and method the component needs: `ExtractionPrimaryViewOutDTO`, `ExtractionViewMetaOutDTO` (with `validated?: boolean` and `validationFeedback?: ValidationSchemaModel | null`), `ExtractionValidationInDTO`, `ExtractionValidationResultOutDTO`, `ComparisonSummaryModel`, `documents.getDocumentExtraction({ documentExtractionId })`, `documents.validateDocumentExtraction({ targetDocumentExtractionId, extractionValidationInDTO })`, and `GeminaClient.withSessionToken`. What is missing until the backend ships + spec regen (Task 20): (a) the generated request builders for those two document operations attach only `X-API-Key`, never the `Authorization` bearer header; (b) `SessionTokenInDTO` has no `extractionIds`; (c) the live API does not yet populate `validationFeedback` on the view GET (the DTO field exists but is left null — see `build_document_extraction_view_response`, `documents/utils.py:1008-1065`). **Therefore: all component tasks build and test NOW against real `@gemina/sdk` types with a mocked client, exactly like `chat.test.tsx`. Only Tasks 20–22 are blocked.**
2. **Schema key format** (backend `data_validator.py:10`): `^label:([^|]+)\|ptr:(/.*)$`. Real templates: `label:supplier_name|ptr:/supplier_name/value` (headers — pointer targets the `.value` INSIDE a `{value, coordinates, confidence}` wrapper), `label:line_0_description|ptr:/line_items/0/description` (tables — row-indexed, no `/value` suffix), `label:taxes_vat_amount|ptr:/taxes/0/amount`.
3. **Backend pointer resolution** (`validator/utils.py:13-45`): segments unescape `~1` then `~0`; list segments must be all digits; unresolvable → `NOT_FOUND` sentinel. Our resolver must mirror this exactly.
4. **Scoring semantics** (`data_validator.py:30-200`): every submitted `data` key becomes an "expected" label; the server re-resolves the pointer against its stored extraction; `NOT_FOUND` on the server side → "missing"; equal → "correct"; different → "incorrect" (with `coerce_like` type coercion of our value toward the extracted type, so submitting the string `"1500"` against an extracted number `1500` scores correct). Consequence for the composer: **untouched fields must submit the raw extracted JSON value (original type), not the input's display string**, and **keys that resolve to nothing and were left blank are omitted** (submitting `null` there would force a bogus "missing").
5. **Purged/edge semantics on `GET /documents/extractions/{id}`**: purged extractions still return 200 with `meta.purgedAt`/`meta.purgeReason` set (no purge filter in `get_document_extraction_by_ids`, `documents/service.py:356-366`); wrong tenant / nonexistent → 404. `meta.processingStatus` is one of `pending | in_process | failed | success | partial | empty`.
6. **Release gotcha:** `release.yml` verifies EVERY manifest + both `version.ts` files against the tag, and the `npm-elements` job `needs: [verify, npm]` and runs `npm ci` — so the elements lockfile must reference an `@gemina/sdk` version that is already on npm. You cannot bump the pin and release in one tag. Task 22 spells out the required two-tag sequence.

**Working conventions for every task below:**

- Work on branch `feature/verification-elements` (create in Task 1). Do not push until Task 22's sequencing says so.
- All commands run from `/home/chronic/gemina/gemina-sdk/packages/elements` unless stated.
- TDD loop per step: write the failing test → `npx vitest run <file>` → see FAIL → implement → `npx vitest run <file>` → see PASS → commit. Expected-output snippets show the vitest summary line only; exact counts will grow as tests accumulate.
- Before EVERY commit that claims green: `npm run typecheck` must print nothing (exit 0).
- No emojis, no new deps, no `window`/`document` at module top level, no persistence of tokens.

---

### Task 1: Branch, subpath plumbing, and the props contract

**Files:**
- Create: `packages/elements/src/verification/types.ts`
- Create: `packages/elements/src/verification/index.tsx` (stub)
- Modify: `packages/elements/tsup.config.ts`
- Modify: `packages/elements/package.json` (exports map only — NOT the version, NOT the `@gemina/sdk` pin)
- Modify: `packages/elements/src/index.ts`
- Test: `packages/elements/test/verification/exports.test.ts`

1. Create the branch: `git -C /home/chronic/gemina/gemina-sdk checkout -b feature/verification-elements`
2. Write the failing test `test/verification/exports.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('verification subpath', () => {
  it('exports the component and its prop types compile', async () => {
    const mod = await import('../../src/verification/index');
    expect(typeof mod.GeminaVerification).toBe('function');
  });
});
```

3. Run: `npx vitest run test/verification/exports.test.ts` → expect `FAIL` (cannot resolve `../../src/verification/index`).
4. Create `src/verification/types.ts` — complete code:

```ts
import type { ComparisonSummaryModel } from '@gemina/sdk';

/** Visual theme. `"auto"` follows `prefers-color-scheme`. */
export type GeminaVerificationTheme = 'light' | 'dark' | 'auto';

/**
 * Text direction. `"auto"` flips to RTL when the extraction's field values
 * contain Hebrew (U+0590–U+05FF), mirroring the chat widget's autodetect.
 */
export type GeminaVerificationDirection = 'ltr' | 'rtl' | 'auto';

/** Stable reasons handed to onError. Matched from HTTP status + meta, never from error text. */
export type VerificationErrorReason =
  | 'purged'                    // meta.purgedAt set — retention policy
  | 'not-available'             // 404: nonexistent OR out of token scope (no existence leak)
  | 'not-completed'             // processingStatus !== 'success'
  | 'verification-unavailable'  // SUCCESS but validationFeedback is null/empty (backend delta not live)
  | 'session-expired'           // 401 after the one mandated retry
  | 'load-failed'               // network/5xx on the initial GET
  | 'submit-failed';            // network/5xx on PUT (edits preserved, inline retry offered)

export interface VerificationErrorDetail {
  status?: number;
  errorCode?: string;
  description?: string;
}

export interface VerificationCompletion {
  /**
   * Every submitted entry keyed by its human label (e.g. `supplier_name`,
   * `line_0_description`) — the raw `label:...|ptr:...` key format never
   * reaches the host app.
   */
  correctedValues: Record<string, unknown>;
  /** Gemina's scoring response for the submission. */
  summary: ComparisonSummaryModel;
}

export interface GeminaVerificationProps {
  /** The extraction to verify. Must be inside the session token's scope. */
  extractionId: string;
  /** Token source. Required — see GeminaTokenManager. */
  tokenManager: import('../token-manager').GeminaTokenManager;
  /** Gemina API base URL (default `https://api.gemina.co`). */
  baseUrl?: string;
  /** Visual theme (default `"auto"`). */
  theme?: GeminaVerificationTheme;
  /** Text direction (default `"auto"`). */
  dir?: GeminaVerificationDirection;
  /** Called exactly once, after a successful feedback submission. */
  onComplete?: (result: VerificationCompletion) => void;
  /** Called when the component lands in a terminal error/edge state. */
  onError?: (reason: VerificationErrorReason, detail?: VerificationErrorDetail) => void;
  /** Extra class name(s) for the root element (e.g. to override CSS vars). */
  className?: string;
}
```

5. Create `src/verification/index.tsx` as a minimal stub (replaced in Task 14):

```tsx
import type * as React from 'react';
import type { GeminaVerificationProps } from './types';

export type {
  GeminaVerificationProps,
  GeminaVerificationTheme,
  GeminaVerificationDirection,
  VerificationErrorReason,
  VerificationErrorDetail,
  VerificationCompletion,
} from './types';

export function GeminaVerification(_props: GeminaVerificationProps): React.JSX.Element {
  throw new Error('not implemented');
}
```

6. Run: `npx vitest run test/verification/exports.test.ts` → expect `Test Files  1 passed (1)`.
7. Wire the subpath. In `tsup.config.ts` add to `entry` (and update the comment listing entry points):

```ts
    verification: 'src/verification/index.tsx',
```

   In `package.json` `exports` add (after `"./chat"`):

```json
    "./verification": {
      "types": "./dist/verification.d.ts",
      "import": "./dist/verification.js",
      "require": "./dist/verification.cjs"
    }
```

   (`"files": ["dist"]` already covers it.) In `src/index.ts` append:

```ts
// Verification UI (React — also available as `@gemina/elements/verification`).
export { GeminaVerification } from './verification/index';
export type {
  GeminaVerificationProps,
  GeminaVerificationTheme,
  GeminaVerificationDirection,
  VerificationErrorReason,
  VerificationErrorDetail,
  VerificationCompletion,
} from './verification/index';
```

8. Verify the build produces the new artifacts: `npm run build` → expect `dist/verification.js`, `dist/verification.cjs`, `dist/verification.d.ts` in the output listing. Then `npm run typecheck` (silent) and `npm test` (all existing chat/token tests still green).
9. Commit: `git -C /home/chronic/gemina/gemina-sdk add -A && git -C /home/chronic/gemina/gemina-sdk commit -m "feat(elements): verification subpath skeleton — props contract, tsup entry, exports map"`

---

### Task 2: `pointer.ts` — schema-key parsing and RFC-6901 resolution

Pure logic, complete code, mirrors the backend byte-for-byte so client-side resolution predicts server-side scoring.

**Files:**
- Create: `packages/elements/src/verification/pointer.ts`
- Test: `packages/elements/test/verification/pointer.test.ts`

1. Write the failing tests:

```ts
import { describe, expect, it } from 'vitest';
import { NOT_FOUND, parseSchemaKey, resolvePointer } from '../../src/verification/pointer';

describe('parseSchemaKey', () => {
  it('parses label and pointer', () => {
    expect(parseSchemaKey('label:supplier_name|ptr:/supplier_name/value')).toEqual({
      raw: 'label:supplier_name|ptr:/supplier_name/value',
      label: 'supplier_name',
      pointer: '/supplier_name/value',
    });
  });
  it('parses row-indexed table keys', () => {
    expect(parseSchemaKey('label:line_2_total|ptr:/line_items/2/total')?.pointer).toBe(
      '/line_items/2/total',
    );
  });
  it('rejects malformed keys (returns null, mirroring the backend skip)', () => {
    expect(parseSchemaKey('supplier_name')).toBeNull();
    expect(parseSchemaKey('label:a|b|ptr:/x')).toBeNull(); // '|' not allowed in label
    expect(parseSchemaKey('label:a|ptr:x')).toBeNull();    // pointer must start with '/'
  });
});

describe('resolvePointer', () => {
  const doc = {
    supplier_name: { value: 'Acme', confidence: 'high' },
    line_items: [{ total: 100 }, { total: 250.5 }],
    'weird/key': { '~tilde': 7 },
    nothing: null,
  };
  it('resolves object paths and array indices', () => {
    expect(resolvePointer(doc, '/supplier_name/value')).toBe('Acme');
    expect(resolvePointer(doc, '/line_items/1/total')).toBe(250.5);
  });
  it('unescapes ~1 then ~0 per RFC 6901', () => {
    expect(resolvePointer(doc, '/weird~1key/~0tilde')).toBe(7);
  });
  it('distinguishes a real null from NOT_FOUND', () => {
    expect(resolvePointer(doc, '/nothing')).toBeNull();
    expect(resolvePointer(doc, '/missing')).toBe(NOT_FOUND);
    expect(resolvePointer(doc, '/line_items/9/total')).toBe(NOT_FOUND);
    expect(resolvePointer(doc, '/line_items/x')).toBe(NOT_FOUND);   // non-digit list segment
    expect(resolvePointer(doc, '/supplier_name/value/deeper')).toBe(NOT_FOUND); // through a primitive
  });
  it('empty pointer returns the doc; non-slash pointer is NOT_FOUND (backend strictness)', () => {
    expect(resolvePointer(doc, '')).toBe(doc);
    expect(resolvePointer(doc, 'supplier_name')).toBe(NOT_FOUND);
  });
});
```

2. Run: `npx vitest run test/verification/pointer.test.ts` → FAIL (module missing).
3. Implement `src/verification/pointer.ts` — complete code:

```ts
/**
 * Server-generated submission keys and JSON-pointer resolution.
 *
 * Mirrors the backend exactly (gemina-api-v2 `data_validator.py` /
 * `validator/utils.py`) so that what the component resolves client-side is
 * what the server will resolve when it scores the submission:
 * - key regex `^label:([^|]+)\|ptr:(/.*)$`
 * - `~1` unescaped before `~0`
 * - list segments must be all digits
 * - unresolvable paths are a sentinel, distinct from a stored `null`.
 */

export interface SchemaKey {
  /** The raw key — submitted verbatim as a property name in the feedback body. */
  raw: string;
  /** Human-meaningful label; the only key format the host app ever sees. */
  label: string;
  /** JSON pointer into the extraction values payload. */
  pointer: string;
}

const KEY_RE = /^label:([^|]+)\|ptr:(\/.*)$/;

/** Parse one schema key, or null for a malformed entry (the backend skips those quietly too). */
export function parseSchemaKey(raw: string): SchemaKey | null {
  const match = KEY_RE.exec(raw);
  if (match === null) {
    return null;
  }
  return { raw, label: match[1] as string, pointer: match[2] as string };
}

/** "Path did not resolve" — deliberately distinct from a stored null value. */
export const NOT_FOUND: unique symbol = Symbol('gemina-verification-not-found');
export type NotFound = typeof NOT_FOUND;

/** Resolve a JSON pointer against a document, backend-compatible (see module docs). */
export function resolvePointer(doc: unknown, pointer: string): unknown | NotFound {
  if (pointer === '') {
    return doc;
  }
  if (!pointer.startsWith('/')) {
    return NOT_FOUND;
  }
  let current: unknown = doc;
  for (const rawSegment of pointer.slice(1).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) {
        return NOT_FOUND;
      }
      const index = Number(segment);
      if (index >= current.length) {
        return NOT_FOUND;
      }
      current = current[index];
    } else if (current !== null && typeof current === 'object') {
      if (!(segment in (current as Record<string, unknown>))) {
        return NOT_FOUND;
      }
      current = (current as Record<string, unknown>)[segment];
    } else {
      return NOT_FOUND;
    }
  }
  return current;
}
```

4. Run: `npx vitest run test/verification/pointer.test.ts` → `Test Files  1 passed (1)`.
5. Commit: `git -C /home/chronic/gemina/gemina-sdk add -A && git -C /home/chronic/gemina/gemina-sdk commit -m "feat(elements): verification pointer parsing + backend-mirroring RFC-6901 resolver"`

---

### Task 3: `classify.ts` — ported shape classifier, now pointer-aware

Port of the console's `FormView/utils.ts` (all 468 lines are the reference; the shape predicates and `classifyData` walk port essentially verbatim). ONE structural addition: every emitted leaf carries the JSON pointer at which it lives in the ORIGINAL payload, so Task 4 can bind fields to schema keys. One trap the port must not lose: the console strips a root `{ data: ... }` wrapper before walking — the pointer for fields under the wrapper must still include the `/data` prefix, because server pointers resolve against the payload root.

**Files:**
- Create: `packages/elements/src/verification/classify.ts`
- Test: `packages/elements/test/verification/classify.test.ts`

**Port map (console `FormView/utils.ts` → `classify.ts`):**

| Console source (lines) | Ported as | Change |
|---|---|---|
| `formatLabel` (1–36) | `formatLabel` | verbatim (also strips a leading `label:`-less snake/camel; used for labels AND confidence-reason tokens) |
| `formatValue` (41–79) | `formatValue` | verbatim — DISPLAY ONLY; never feeds inputs or submissions |
| `isValueObject`/`isPrimitiveArray`/`isSimpleValueArray`/`isTableArray`/`isEntityArray` (84–153) | same names | verbatim |
| `extractValue`/`extractCoordinates`/`extractConfidence` (158–189) | same names | verbatim (`coordinates.relative` → `{points}`) |
| `ClassifiedData` (194–231) | `ClassifiedData` | every leaf gains `pointer: string`; `simpleLists`/`entities`/`tables` items gain per-item/cell pointers |
| `classifyData` + `processField` (233–468) | `classifyData` + internal walk | `processField` gains a `basePointer` argument; the `{data:...}` unwrap (248–254) passes `'/data'` as the prefix for inner fields; table rows emit `${tablePointer}/${rowIndex}/${col}`, entities `${entityPointer}/${index}/${fieldKey}`, simple lists `${listPointer}/${index}`, nested small objects `${parentPointer}/${nestedKey}` (label stays `key.nested`); `{key}_confidence` / `overall_confidence` table-level resolution (338–357) ports verbatim |

The classifier stays PURE and dependency-free. Export the leaf shape:

```ts
export interface ClassifiedField {
  key: string;                                   // display label source (formatLabel applied at render)
  pointer: string;                               // pointer to this field in the ORIGINAL payload
  value: unknown;                                // unwrapped raw value
  coordinates: { points: [number, number][] } | null;
  confidence: { level: string; reasons: string[] } | null;
}
```

1. Write failing tests covering, at minimum:
   - a headers-shaped payload with value-object wrappers → `headers[i].pointer === '/supplier_name'` (the WRAPPER pointer; `/value` normalization happens in Task 4), value unwrapped, confidence + coordinates extracted;
   - a `{ data: {...}, overall_confidence: 'high' }` wrapped payload → inner header pointer `'/data/invoice_number'` (the trap test);
   - a line-items table (array of >3-field flat objects) → `tables[0].rows[1]['total'].pointer === '/line_items/1/total'`, columns exclude meta fields, `_rowMeta` row confidence, and `line_items_confidence`/`overall_confidence` sibling resolution into `overallConfidence`;
   - an entity array (few fields) → `entities[0].items[0]['name'].pointer === '/parties/0/name'`;
   - a primitive array → simpleList with `'/tags/0'` pointers;
   - an unrecognized nested blob → `fallback` (no pointer needed);
   - `formatLabel('vat_amount') === 'VAT Amount'`, `formatValue(1234.5) === '1,234.5'`, `formatValue('2026-01-05')` is a locale date.
2. Run: `npx vitest run test/verification/classify.test.ts` → FAIL.
3. Implement the port per the table above (roughly 400 lines; copy the console file and apply the pointer threading — do not "improve" the heuristics, they are battle-tested against every extraction type).
4. Run: `npx vitest run test/verification/classify.test.ts` → PASS. Also `npx vitest run` (whole suite) → all green.
5. Commit: `git -C /home/chronic/gemina/gemina-sdk add -A && git -C /home/chronic/gemina/gemina-sdk commit -m "feat(elements): port console shape classifier with JSON-pointer tracking"`

---

### Task 4: `bindings.ts` — schema↔field binder and submission composer

The heart of correctness. Complete code. Encodes the verified scoring semantics (fact 4 in the context section).

**Files:**
- Create: `packages/elements/src/verification/bindings.ts`
- Test: `packages/elements/test/verification/bindings.test.ts`

1. Write failing tests:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildBindings, composeSubmission, indexBindingsByFieldPointer, toInputString,
} from '../../src/verification/bindings';
import { NOT_FOUND } from '../../src/verification/pointer';

const values = {
  supplier_name: { value: 'Acme Ltd', confidence: 'high' },
  total_amount: { value: 1500, confidence: 'low', confidence_reasons: ['blurry_region'] },
  due_date: { value: null },
  line_items: [{ description: 'Widget', total: 100 }],
};
const schema = [
  'label:supplier_name|ptr:/supplier_name/value',
  'label:total_amount|ptr:/total_amount/value',
  'label:due_date|ptr:/due_date/value',
  'label:vat_number|ptr:/vat_number/value',          // never extracted
  'label:line_0_description|ptr:/line_items/0/description',
  'label:line_0_total|ptr:/line_items/0/total',
  'not-a-valid-key',                                  // must be skipped quietly
];

describe('buildBindings', () => {
  const bindings = buildBindings(schema, values);
  it('resolves /value pointers to the raw primitive', () => {
    expect(bindings.find((b) => b.key.label === 'supplier_name')?.extracted).toBe('Acme Ltd');
    expect(bindings.find((b) => b.key.label === 'total_amount')?.extracted).toBe(1500);
  });
  it('keeps real nulls distinct from never-extracted', () => {
    expect(bindings.find((b) => b.key.label === 'due_date')?.extracted).toBeNull();
    expect(bindings.find((b) => b.key.label === 'vat_number')?.extracted).toBe(NOT_FOUND);
  });
  it('resolves row-indexed pointers and skips malformed keys', () => {
    expect(bindings.find((b) => b.key.label === 'line_0_total')?.extracted).toBe(100);
    expect(bindings).toHaveLength(6);
  });
  it('unwraps a value-object when the pointer stops at the wrapper', () => {
    // table cells stored as {value: ...} but pointer has no /value suffix
    const wrapped = { line_items: [{ total: { value: 42, confidence: 'high' } }] };
    const [b] = buildBindings(['label:line_0_total|ptr:/line_items/0/total'], wrapped);
    expect(b?.extracted).toBe(42);
  });
  it('falls back to the wrapper when /value does not resolve but the parent does', () => {
    const bare = { supplier_name: 'Acme' }; // no wrapper at all
    const [b] = buildBindings(['label:supplier_name|ptr:/supplier_name/value'], bare);
    expect(b?.extracted).toBe('Acme');
  });
});

describe('indexBindingsByFieldPointer', () => {
  it('maps classifier field pointers (wrapper-level) to bindings for both pointer styles', () => {
    const map = indexBindingsByFieldPointer(buildBindings(schema, values));
    expect(map.get('/supplier_name')?.key.label).toBe('supplier_name');      // /value stripped
    expect(map.get('/line_items/0/total')?.key.label).toBe('line_0_total'); // exact
  });
});

describe('toInputString', () => {
  it('prefills inputs from RAW values, never display formatting', () => {
    expect(toInputString(1500)).toBe('1500');           // not "1,500"
    expect(toInputString('2026-01-05')).toBe('2026-01-05'); // not a locale date
    expect(toInputString(null)).toBe('');
    expect(toInputString(NOT_FOUND)).toBe('');
    expect(toInputString(true)).toBe('true');
  });
});

describe('composeSubmission', () => {
  const bindings = buildBindings(schema, values);
  it('untouched extracted fields submit the raw value with its original type', () => {
    const result = composeSubmission(bindings, new Map());
    expect(result.data['label:total_amount|ptr:/total_amount/value']).toBe(1500); // number, not "1500"
    expect(result.data['label:due_date|ptr:/due_date/value']).toBeNull();          // real null kept
    expect(result.confirmed).toBe(5);
    expect(result.corrected).toBe(0);
  });
  it('untouched never-extracted keys are omitted (no bogus "missing")', () => {
    const result = composeSubmission(bindings, new Map());
    expect('label:vat_number|ptr:/vat_number/value' in result.data).toBe(false);
  });
  it('edited fields submit the typed string (server coerces types)', () => {
    const edits = new Map([['label:total_amount|ptr:/total_amount/value', '1600']]);
    const result = composeSubmission(bindings, edits);
    expect(result.data['label:total_amount|ptr:/total_amount/value']).toBe('1600');
    expect(result.corrected).toBe(1);
    expect(result.confirmed).toBe(4);
  });
  it('a filled-in never-extracted key is submitted; a cleared extracted field submits null', () => {
    const edits = new Map([
      ['label:vat_number|ptr:/vat_number/value', 'IL-5150'],
      ['label:supplier_name|ptr:/supplier_name/value', '   '],
    ]);
    const result = composeSubmission(bindings, edits);
    expect(result.data['label:vat_number|ptr:/vat_number/value']).toBe('IL-5150');
    expect(result.data['label:supplier_name|ptr:/supplier_name/value']).toBeNull();
  });
  it('exposes the same entries keyed by label for onComplete', () => {
    const result = composeSubmission(bindings, new Map());
    expect(result.byLabel['supplier_name']).toBe('Acme Ltd');
    expect('vat_number' in result.byLabel).toBe(false);
  });
});
```

2. Run: `npx vitest run test/verification/bindings.test.ts` → FAIL.
3. Implement `src/verification/bindings.ts` — complete code:

```ts
import { isValueObject } from './classify';
import { NOT_FOUND, parseSchemaKey, resolvePointer } from './pointer';
import type { NotFound, SchemaKey } from './pointer';

/** One server-mandated submission slot, bound to whatever was extracted there. */
export interface FieldBinding {
  key: SchemaKey;
  /** Raw extracted JSON value (unwrapped from `{value,...}`), or NOT_FOUND. */
  extracted: unknown | NotFound;
}

/**
 * Resolve a schema pointer the way the server will, then unwrap.
 * Two payload-shape mismatches are normalized here:
 * - pointer ends in `/value` but the payload stores a bare primitive → resolve the parent;
 * - pointer stops at a `{value, coordinates?, confidence?}` wrapper → take `.value`.
 */
export function resolveSchemaValue(values: unknown, pointer: string): unknown | NotFound {
  let node = resolvePointer(values, pointer);
  if (node === NOT_FOUND && pointer.endsWith('/value')) {
    node = resolvePointer(values, pointer.slice(0, -'/value'.length));
  }
  if (node !== NOT_FOUND && isValueObject(node)) {
    return node.value;
  }
  return node;
}

/** Parse + resolve every schema key. Malformed entries are skipped (backend parity). */
export function buildBindings(validationSchema: string[], values: unknown): FieldBinding[] {
  const bindings: FieldBinding[] = [];
  for (const raw of validationSchema) {
    const key = parseSchemaKey(raw);
    if (key === null) {
      continue;
    }
    bindings.push({ key, extracted: resolveSchemaValue(values, key.pointer) });
  }
  return bindings;
}

/**
 * Index bindings by the pointer the CLASSIFIER reports for a field (which is
 * always the wrapper-level pointer): a schema pointer `P/value` and a
 * classifier pointer `P` are the same field.
 */
export function indexBindingsByFieldPointer(bindings: FieldBinding[]): Map<string, FieldBinding> {
  const map = new Map<string, FieldBinding>();
  for (const binding of bindings) {
    const pointer = binding.key.pointer;
    const fieldPointer = pointer.endsWith('/value')
      ? pointer.slice(0, -'/value'.length)
      : pointer;
    map.set(fieldPointer, binding);
  }
  return map;
}

/**
 * What an editable input is prefilled with. RAW value stringification only —
 * display formatting (`formatValue`) must never round-trip into a submission
 * (a locale-formatted "1,500" or date would score as a correction).
 */
export function toInputString(extracted: unknown | NotFound): string {
  if (extracted === NOT_FOUND || extracted === null || extracted === undefined) {
    return '';
  }
  if (typeof extracted === 'object') {
    return JSON.stringify(extracted);
  }
  return String(extracted);
}

export interface SubmissionResult {
  /** Body for `ExtractionValidationInDTO.data` — raw schema keys, ALL asserted fields. */
  data: Record<string, unknown>;
  /** The same entries keyed by human label — handed to `onComplete`. */
  byLabel: Record<string, unknown>;
  confirmed: number;
  corrected: number;
}

/**
 * Compose the one-shot feedback body.
 *
 * `edits` holds ONLY dirty keys (raw schema key → current input string; the
 * UI removes an entry when the input returns to its initial string).
 *
 * Rules (verified against the backend DataValidator):
 * - untouched + extracted (even extracted-null): submit the raw value as-is
 *   → server compares equal → scored a confirmation;
 * - untouched + never extracted: OMIT — the user asserted nothing, and
 *   submitting null would force a false "missing";
 * - dirty, non-empty: submit the trimmed string (server `coerce_like`
 *   adopts the extracted value's type before comparing);
 * - dirty, cleared: the user asserts the field is absent/wrong → null;
 *   unless nothing was extracted either, in which case there is nothing
 *   to assert → OMIT.
 */
export function composeSubmission(
  bindings: FieldBinding[],
  edits: ReadonlyMap<string, string>,
): SubmissionResult {
  const data: Record<string, unknown> = {};
  const byLabel: Record<string, unknown> = {};
  let confirmed = 0;
  let corrected = 0;

  for (const binding of bindings) {
    const edit = edits.get(binding.key.raw);
    if (edit !== undefined) {
      const trimmed = edit.trim();
      if (trimmed === '' && binding.extracted === NOT_FOUND) {
        continue;
      }
      const value = trimmed === '' ? null : trimmed;
      data[binding.key.raw] = value;
      byLabel[binding.key.label] = value;
      corrected += 1;
    } else {
      if (binding.extracted === NOT_FOUND) {
        continue;
      }
      data[binding.key.raw] = binding.extracted;
      byLabel[binding.key.label] = binding.extracted;
      confirmed += 1;
    }
  }
  return { data, byLabel, confirmed, corrected };
}
```

4. Run: `npx vitest run test/verification/bindings.test.ts` → PASS; `npm run typecheck` silent.
5. Commit: `git -C /home/chronic/gemina/gemina-sdk add -A && git -C /home/chronic/gemina/gemina-sdk commit -m "feat(elements): verification binder + submission composer with raw-value round-trip"`

**Note (deliberate, documented deviation):** the design doc's shorthand says the body carries "ALL keys". The composer omits keys that are simultaneously never-extracted and left blank, because the backend scores any submitted-but-unresolvable key as "missing" (`data_validator.py:150-163`), which would punish accuracy for fields that genuinely aren't on the document. Confirm during the console integration test; if product wants strict all-keys, delete the two `continue` branches and their two tests.

---

### Task 5: `viewer-math.ts` — pure zoom/rotation math

The console viewer's math, extracted into pure functions so it is testable under happy-dom (no ResizeObserver, no image loading there). Port sources: `ZoomableImageViewer.tsx` lines 142–172 (fit + rotated box), 198–229 (clamp + zoom-at-point), 459–509 (flash-zoom target).

**Files:**
- Create: `packages/elements/src/verification/viewer-math.ts`
- Test: `packages/elements/test/verification/viewer-math.test.ts`

1. Write failing tests: fit scale for a 1000×2000 image in a 500×500 box is 0.25, and 0.5 after a 90° rotation; `rotatedBox` extents for all four rotations (port the console's switch at lines 153–169 as the expected values); `zoomAtPoint` keeps the image point under the cursor invariant (assert by transforming back); clamping to `[fitScale, 8]`; `flashZoomTarget` centers the rect bbox and clamps scale to `[fitScale, 1.8]` with the 100px target size (lines 493–509).
2. Run → FAIL.
3. Implement. Signatures (complete — bodies are direct ports of the cited lines):

```ts
export interface Size { w: number; h: number }
export interface Transform { scale: number; tx: number; ty: number }

/** Scale that fits a (possibly rotated) natural size into a container. Lines 142-149. */
export function fitScaleFor(natural: Size, container: Size, rotationDeg: number): number;

/** Rotated bounding box extents; minX/minY compensate rotation offsets. Lines 152-172. */
export function rotatedBox(natural: Size, scale: number, rotationDeg: number):
  { W: number; H: number; minX: number; minY: number };

/** Translation that centers the rotated image. Lines 174-183. */
export function centeredTranslation(natural: Size, container: Size, scale: number, rotationDeg: number):
  { tx: number; ty: number };

export function clampScale(s: number, fitScale: number, max?: number): number; // Lines 198-201, max=8

/** New transform after zooming by `factor` anchored at container point (px,py). Lines 203-229. */
export function zoomAtPoint(current: Transform, factor: number, px: number, py: number,
  rotationDeg: number, fitScale: number): Transform;

/** Target transform for the flash-zoom travel: center the rects' bbox at a
 * comfortable size (100px target, scale clamped to [fitScale, 1.8]). Lines 470-509. */
export function flashZoomTarget(rects: Array<{ points: [number, number][] }>, natural: Size,
  container: Size, rotationDeg: number, fitScale: number): Transform;

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3); // Line 523
```

4. Run → PASS. Commit: `git -C /home/chronic/gemina/gemina-sdk add -A && git -C /home/chronic/gemina/gemina-sdk commit -m "feat(elements): pure rotation-aware viewer math ported from console"`

---

### Task 6: `styles.ts` — scoped CSS, theming tokens, injection

**Files:**
- Create: `packages/elements/src/verification/styles.ts`
- Test: `packages/elements/test/verification/styles.test.ts`

1. Failing test: calling `ensureVerificationStylesInjected()` twice under happy-dom leaves exactly one `style[data-gemina-verification]` in `document.head`, whose text contains `.gemina-verification` and `--gemina-verification-bg`; calling it with `document` undefined (simulate via a plain function-scope check — just assert the module can be imported in isolation without touching `document` at import time by checking `typeof` guards exist through a direct call after `vi.stubGlobal`-free import).
2. Run → FAIL.
3. Implement following `chat.tsx` lines 316–570 exactly (module-level CSS string, `DARK_VARS` block, `--auto` media query, idempotent injector stamped with `VERSION`). Complete token list — light values on `.gemina-verification`, `DARK_VARS` mirrored:

```
--gemina-verification-bg: #ffffff;            /* dark: #101418 */
--gemina-verification-fg: #1a1d21;            /* dark: #e6e9ee */
--gemina-verification-border: #d9dce1;        /* dark: #2a323c */
--gemina-verification-accent: #2f6fed;        /* dark: #4c8dff */
--gemina-verification-accent-fg: #ffffff;     /* dark: #ffffff */
--gemina-verification-surface: #f2f4f7;       /* section headers, viewer canvas; dark: #1c232b */
--gemina-verification-muted: #667085;         /* dark: #98a2b3 */
--gemina-verification-error: #b42318;         /* dark: #f97066 */
--gemina-verification-input-bg: #ffffff;      /* dark: #12171d */
--gemina-verification-input-border: #d0d5e2;  /* dark: #2a323c */
--gemina-verification-dirty: #b54708;         /* edited-field marker; dark: #f7b27a */
--gemina-verification-confidence-high: #52c41a;
--gemina-verification-confidence-medium: #faad14;
--gemina-verification-confidence-low: #ff4d4f;
--gemina-verification-confidence-unknown: #d9d9d9;
--gemina-verification-overlay-rgb: 24, 144, 255;  /* rect/flash tint, composed with alpha */
--gemina-verification-radius: 10px;
--gemina-verification-font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
```

   Class namespace: `.gemina-verification`, `.gemina-verification--dark`, `.gemina-verification--auto`, `.gemina-verification--rtl`, `.gemina-verification--stacked`, and BEM children `.gemina-verification__viewer`, `__toolbar`, `__toolbar-btn`, `__toolbar-btn--active`, `__canvas`, `__rect`, `__flash-rect`, `__panes`, `__form`, `__section`, `__section-header`, `__dl`, `__dt`, `__dd`, `__input`, `__input--dirty`, `__input--missed`, `__dot`, `__eye`, `__table`, `__table-wrap` (`overflow-x:auto`), `__card`, `__fallback`, `__banner`, `__banner--error`, `__progress`, `__confirm`, `__confirm-dialog`, `__footer`, `__submit`, `__retry`, `__state` (centered edge-state message). Layout rules: `__panes` is a 2-column grid (`minmax(0,1fr) minmax(0,1fr)`, gap 16px); `.gemina-verification--stacked .gemina-verification__panes` collapses to one column with the viewer pane `position: sticky; top: 0` header behavior; all inline-start/end spacing uses logical properties (`margin-inline-start`, `padding-inline`), never left/right, so RTL works for free. Include a `@media (prefers-reduced-motion: reduce)` block that disables the flash/travel animations (the component also checks it in JS before animating).
4. Run → PASS. Commit: `git -C /home/chronic/gemina/gemina-sdk add -A && git -C /home/chronic/gemina/gemina-sdk commit -m "feat(elements): verification scoped stylesheet + theming tokens"`

---

### Task 7: `viewer.tsx` part 1 — static image, toolbar, fit/100%/zoom/rotate

**Files:**
- Create: `packages/elements/src/verification/viewer.tsx`
- Test: `packages/elements/test/verification/viewer.test.tsx`

**Console → house-style transformation table (applies to Tasks 7–11 and 12–15):**

| Console (antd / SCSS) | Elements replacement |
|---|---|
| `<Tooltip title=...>` wrapping a control | `title` attribute + `aria-label` on the control itself (native tooltip; a11y label preserved) |
| `<Button shape="circle" icon={<ZoomInOutlined/>}>` | `<button type="button" class="gemina-verification__toolbar-btn">` with an inline `<svg>` (16×16, `stroke="currentColor"`, `aria-hidden="true"`) |
| `@ant-design/icons` (`ZoomIn/ZoomOut/Compress/RotateRight/Border/Eye/Expand`) | hand-drawn inline SVGs defined once in `viewer.tsx`/`form.tsx` as tiny components (`IconZoomIn`, etc.). Magnifying-glass ±, arrows-inward, circular arrow, dashed square, eye. Keep each ≤ 6 path segments |
| `<Switch>` (magnifier toggle) | `<button type="button" role="switch" aria-checked={on}>` styled as `__toolbar-btn`, `--active` modifier when on |
| antd `<Table>` | plain `<table class="gemina-verification__table">` inside `__table-wrap`; same column model (see Task 13) |
| antd `<Modal>` (expand table / confirm) | table-expand modal: CUT (YAGNI — `__table-wrap` scrolls). Confirm dialog: in-component overlay, Task 17 |
| `Modal`+`setTimeout` flash handoff (DataTable 43–49) | not needed — no modal |
| SCSS module classes (`css.confidenceDot` …) | `.gemina-verification__*` classes from Task 6 |
| Inline style palettes (viewer lines 62–121) | CSS classes + variables; NO inline colors |
| antd pagination (DataTable 212–220) | CUT — render all rows; `__table-wrap` scrolls (revisit only if a real payload proves painful) |
| `NodeJS.Timeout` ref type | `ReturnType<typeof setTimeout>` |

Viewer props (complete):

```tsx
export interface RelativeRect { points: [number, number][] }

export interface VerificationViewerProps {
  src: string;
  alt?: string;
  relativeRects?: RelativeRect[];
  flashRects?: RelativeRect[] | null;
  onFlashComplete?: () => void;
  /** Fired when the <img> errors AFTER at least one successful load (URL expiry). */
  onImageExpired?: () => void;
}
```

1. Failing tests (component-level, happy-dom): stub `ResizeObserver` once for the whole file:

```ts
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {} unobserve(): void {} disconnect(): void {}
  };
});
```

   Then: renders an `img` with the given src/alt; renders toolbar buttons accessible as `Zoom in`, `Zoom out`, `Actual size (100%)`, `Fit to screen`, `Rotate 90 degrees`, `Toggle detection overlays`, `Magnifier`; overlay toggle is `disabled` when no `relativeRects`. To exercise load-dependent logic, set natural dimensions manually before firing load:

```ts
const img = container.querySelector('img')!;
Object.defineProperty(img, 'naturalWidth', { value: 1000 });
Object.defineProperty(img, 'naturalHeight', { value: 2000 });
fireEvent.load(img);
```

2. Run → FAIL.
3. Implement: port `ZoomableImageViewer.tsx` state/refs/effects skeleton (lines 21–60, 124–201, 251–278, 583–740) replacing all math with Task 5 imports and all styling with Task 6 classes. Guard `typeof ResizeObserver === 'undefined'` (skip observation; container size falls back to a one-shot `getBoundingClientRect` on mount). The transform div is identical: `left: tx; top: ty; transform: rotate(...) scale(...); transform-origin: top left`.
4. Run → PASS. Commit: `git -C /home/chronic/gemina/gemina-sdk add -A && git -C /home/chronic/gemina/gemina-sdk commit -m "feat(elements): verification viewer skeleton — toolbar, fit/zoom/rotate"`

---

### Task 8: `viewer.tsx` part 2 — wheel zoom, mouse pan, double-click

**Files:**
- Modify: `packages/elements/src/verification/viewer.tsx`
- Test: `packages/elements/test/verification/viewer.test.tsx` (extend)

1. Failing tests: `fireEvent.wheel` with `deltaY < 0` on the canvas increases the content transform scale (read the transform div's `style.transform`); `mouseDown`+`mouseMove` after zooming in changes `left`/`top` (pan); double-click toggles between fit and 100%.
2. Run → FAIL.
3. Port lines 232–249 (non-passive wheel listener via `addEventListener` — REQUIRED, React's `onWheel` is passive), 281–322 (pan handlers, cursor states `zoom-in`/`grab`/`grabbing`), 265–294 (fit/100%/double-click). Note: happy-dom delivers `wheel` through the manual listener; if `{ passive: false }` throws under happy-dom, feature-detect options support the standard way.
4. Run → PASS. Commit: `git -C /home/chronic/gemina/gemina-sdk add -A && git -C /home/chronic/gemina/gemina-sdk commit -m "feat(elements): viewer wheel zoom + pan + double-click"`

---

### Task 9: `viewer.tsx` part 3 — touch pan and pinch zoom

**Files:**
- Modify: `packages/elements/src/verification/viewer.tsx`
- Test: `packages/elements/test/verification/viewer.test.tsx` (extend)

1. Failing tests: two-finger `touchStart`/`touchMove` (synthesize `touches` arrays) scales up when fingers spread; one-finger drag pans only when zoomed beyond fit; `touchEnd` with zero touches resets the gesture state (a following move does nothing).
2. Run → FAIL.
3. Port lines 324–369 verbatim (`touchState` ref union, `touch-action: none` on the canvas — set it in the Task 6 CSS, not inline).
4. Run → PASS. Commit: `git -C /home/chronic/gemina/gemina-sdk add -A && git -C /home/chronic/gemina/gemina-sdk commit -m "feat(elements): viewer touch pan + pinch zoom"`

---

### Task 10: `viewer.tsx` part 4 — coordinate overlays, flash-zoom, expiry hook

**Files:**
- Modify: `packages/elements/src/verification/viewer.tsx`
- Test: `packages/elements/test/verification/viewer.test.tsx` (extend)

1. Failing tests: with `relativeRects` and the overlay toggle clicked, `.gemina-verification__rect` boxes render with `left/top/width/height` proportional to the fake natural size (port the min-size ratio 0.008 and the numbered `#1` badge, lines 742–792); setting `flashRects` renders `.gemina-verification__flash-rect` and eventually calls `onFlashComplete` (drive with `vi.useFakeTimers()` + a rAF shim: `vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 16))`, advance past 1500ms); an `img` error BEFORE any successful load does NOT call `onImageExpired`, an error AFTER a load does.
2. Run → FAIL.
3. Port lines 43–57 and 452–581 (flash state, bbox computation, rAF travel animation using `flashZoomTarget` + `easeOutCubic` from Task 5, parallel opacity fade `1 - p*p`, cleanup canceling both animations on unmount). Honor reduced motion: if `matchMedia('(prefers-reduced-motion: reduce)').matches`, jump straight to the target transform and show the rect at full opacity for 800ms, no travel. Replace the console's `fallbackSrc` img-error handler (374–378) with the expiry hook: track `hasLoadedRef`; on error with `hasLoadedRef.current === true`, call `onImageExpired?.()`.
4. Run → PASS. Full suite `npx vitest run` green. Commit: `git -C /home/chronic/gemina/gemina-sdk add -A && git -C /home/chronic/gemina/gemina-sdk commit -m "feat(elements): viewer overlays + flash-zoom animation + image-expiry hook"`

---

### Task 11 (OPTIONAL — CUTTABLE): `viewer.tsx` part 5 — magnifier loupe

If schedule pressure exists, skip this task entirely and remove the Magnifier toolbar toggle; nothing else depends on it.

**Files:**
- Modify: `packages/elements/src/verification/viewer.tsx`
- Test: `packages/elements/test/verification/viewer.test.tsx` (extend)

1. Failing test: with the magnifier switch on and a `mouseMove` over the canvas, a `.gemina-verification__magnifier` element renders containing a second `img` with the same src; switch off → gone.
2. Run → FAIL.
3. Port lines 36–38, 59–61, 380–448 (rotation-aware loupe math, 150px radius, 2.5× zoom). Class-based styling; keep `pointer-events: none`.
4. Run → PASS. Commit: `git -C /home/chronic/gemina/gemina-sdk add -A && git -C /home/chronic/gemina/gemina-sdk commit -m "feat(elements): viewer magnifier loupe"`

---

### Task 12: `form.tsx` part 1 — field primitives (input, confidence dot, eye button)

**Files:**
- Create: `packages/elements/src/verification/form.tsx`
- Test: `packages/elements/test/verification/form.test.tsx`

Primitives (complete interfaces; bodies follow `FieldValue.tsx` 1–101 + the transformation table):

```tsx
/** Colored dot + native tooltip. Absent confidence renders nothing. */
export function ConfidenceDot(props: {
  confidence: { level: string; reasons: string[] } | null;
}): React.JSX.Element | null;
// level → class + label: high/medium/low/other → the four --confidence-* tokens;
// title = `${label} confidence` + '\n' + reasons.map(formatLabel).join('\n');
// markup: <span class="gemina-verification__dot gemina-verification__dot--high"
//               role="img" aria-label="High confidence" title="..."/>

/** Eye button that flashes the field's rects on the document. */
export function EyeButton(props: {
  coordinates: { points: [number, number][] } | null;
  onFlash: () => void;
}): React.JSX.Element | null;
// <button type="button" class="gemina-verification__eye" title="Show on document"
//         aria-label="Show on document" onClick={stopPropagation + onFlash}><IconEye/></button>

/** One editable field: input prefilled with the RAW value, dirty + missed states. */
export function FieldInput(props: {
  binding: FieldBinding;
  /** Current value if dirty, else undefined (input falls back to initial). */
  edit: string | undefined;
  onEdit: (rawKey: string, value: string) => void;   // parent deletes entry when value === initial
  readOnly: boolean;
  ariaLabel: string;                                  // formatLabel(label)
}): React.JSX.Element;
// initial = toInputString(binding.extracted);
// className gains --dirty when edit !== undefined, --missed when extracted === NOT_FOUND
// (missed also gets placeholder "Not detected — fill in if present");
// readOnly renders a plain <span> with formatValue(...) instead of an input.
```

1. Failing tests: dot color class + aria-label per level, nothing when confidence null; eye button appears only with coordinates and fires `onFlash`; `FieldInput` prefills `1500` (raw) for an extracted `1500` number even though display formatting would say `1,500`; typing marks dirty (class check) and calls `onEdit`; reverting to the initial string is exercised at the parent level in Task 14 (here just assert `onEdit` receives the raw key + new string); `readOnly` renders text, no input.
2. Run → FAIL. 3. Implement. 4. Run → PASS.
5. Commit: `git -C /home/chronic/gemina/gemina-sdk add -A && git -C /home/chronic/gemina/gemina-sdk commit -m "feat(elements): verification field primitives — input, confidence dot, eye button"`

---

### Task 13: `form.tsx` part 2 — the five shape sections

**Files:**
- Modify: `packages/elements/src/verification/form.tsx`
- Test: `packages/elements/test/verification/form.test.tsx` (extend)

One component per bucket, all fed classified data + the binding index + the shared edit state. Port sources: `HeaderFields.tsx` (labels via `formatLabel`, description-list layout → `__dl/__dt/__dd` grid), `EntityCard.tsx` (singularized card headers), `DataTable.tsx` (column model), `FallbackJson.tsx` (collapsible raw JSON — render with `<pre>{JSON.stringify(data, null, 2)}</pre>` inside a native `<details>` element; the console's syntax-highlighted `JsonViewer` is console-domain, do not port it).

Table column model (port of `DataTable.tsx` 52–209, minus antd): leading eye column when any row has coordinates (row eye flashes ALL the row's cell rects — multi-rect flash); row-confidence dot column when any `_rowMeta` present; then one `<th>` per data column (`formatLabel`); cells render `FieldInput` when the cell's pointer has a binding, else read-only `formatValue` text + `ConfidenceDot`; table header row shows `formatLabel(tableKey)`, row count, and the table-level `overallConfidence` dot. Row click = row flash (port 198–209).

The form root (complete interface):

```tsx
export interface VerificationFormProps {
  classified: ClassifiedData;
  bindingIndex: Map<string, FieldBinding>;
  /** Bindings whose pointer matched NO rendered field — the "model missed the
   *  whole field" case; rendered as an extra "Not detected" section of empty inputs. */
  unmatched: FieldBinding[];
  edits: ReadonlyMap<string, string>;
  onEdit: (rawKey: string, value: string) => void;
  readOnly: boolean;
  onFlash: (rects: Array<{ points: [number, number][] }>) => void;
}
export function VerificationForm(props: VerificationFormProps): React.JSX.Element;
```

1. Failing tests — one render test per bucket using small fixtures (reuse Task 3 fixtures): headers section shows label + input bound by pointer; simple list renders per-item rows; entity cards render "Party 1" style headers; table renders eye column, row dots, cell inputs, table-level dot, and row-click fires `onFlash` with every cell rect; fallback renders inside `<details>`; unmatched bindings render in a "Not detected" section as empty inputs; a field with NO binding renders read-only text (no input); everything renders read-only when `readOnly`.
2. Run → FAIL. 3. Implement. 4. Run → PASS.
5. Commit: `git -C /home/chronic/gemina/gemina-sdk add -A && git -C /home/chronic/gemina/gemina-sdk commit -m "feat(elements): shape-driven verification form — headers, lists, tables, cards, fallback"`

---

### Task 14: root component part 1 — fetch, state machine, edge states

**Files:**
- Modify: `packages/elements/src/verification/index.tsx` (replace the stub)
- Create: `packages/elements/src/internal/response-like.ts`
- Modify: `packages/elements/src/chat.tsx` (import the extracted helpers — behavior-identical refactor)
- Test: `packages/elements/test/verification/verification-load.test.tsx`

First, DRY the error-shape helpers: move `getResponseLike`, `httpStatus`, and the `ResponseLike` interface from `chat.tsx` (lines 109–130) verbatim into `src/internal/response-like.ts`; `chat.tsx` imports them. Run `npx vitest run test/chat.test.tsx` → still `passed` before touching anything else. Also add `readErrorEnvelope` there (generalization of chat's `readChatError` minus the Retry-After handling): returns `{ status, errorCode, description }` from the `{errors:[{error_code, description}]}` envelope with the defensive `clone()`/`json()` dance.

State model (complete code for the plan's heart):

```tsx
type Phase =
  | { name: 'loading' }
  | { name: 'unavailable'; reason: VerificationErrorReason; message: string; canRetry: boolean }
  | { name: 'review'; readOnly: boolean; alreadyValidated: boolean }
  | { name: 'confirming' }                       // confirm dialog open over review
  | { name: 'submitting' }
  | { name: 'submit-error'; message: string }    // edits preserved; inline retry
  | { name: 'done'; confirmed: number; corrected: number };
```

Load flow (in a `loadExtraction` callback, run on mount and by every refetch path):

```tsx
const fetchOnce = useCallback(async () => {
  const token = await tokenManager.getToken();
  return GeminaClient.withSessionToken(token, baseUrl).documents.getDocumentExtraction({
    documentExtractionId: extractionId,
  });
}, [tokenManager, baseUrl, extractionId]);

/** The chat widget's mandated 401 pattern: invalidate + retry exactly once. */
const fetchWithRetry = useCallback(async () => {
  try {
    return await fetchOnce();
  } catch (error) {
    if (httpStatus(error) !== 401) throw error;
    tokenManager.invalidate();
    return await fetchOnce();
  }
}, [fetchOnce, tokenManager]);
```

Result mapping (exact order matters — purge before status, validated before schema):

| Observation | Phase | Copy shown | onError |
|---|---|---|---|
| throw, status 401 (post-retry) | unavailable/`session-expired` | "Session expired — please reload the page or sign in again." | yes |
| throw, status 404 | unavailable/`not-available` | "This extraction is not available." (neutral — covers nonexistent AND out-of-scope, no existence leak) | yes |
| throw, anything else | unavailable/`load-failed`, `canRetry: true` | "Couldn't load the extraction." + Retry button | yes |
| `meta.purgedAt != null` | unavailable/`purged` | "Document no longer available (retention policy)." | yes |
| `meta.processingStatus !== 'success'` | unavailable/`not-completed` | "This extraction did not complete, so there is nothing to verify." | yes |
| `meta.validated === true` | review, `readOnly: true`, `alreadyValidated: true` | Banner: "Already verified — showing the original extraction." (MUST NOT imply the data shown is the verified/corrected data; corrections are not retrievable) | no |
| `validationFeedback?.validationSchema` missing or empty | unavailable/`verification-unavailable` | "Verification isn't available for this extraction." | yes |
| else | review, editable | — | no |

On a successful load also derive once (memoized): `classified = classifyData(values)`, `bindings = buildBindings(schema, values)`, `bindingIndex`, `unmatched` (bindings whose field pointer matches no classified leaf). Store `document.imageUrl` in state (Task 15 refreshes it).

1. Failing tests, mocking `@gemina/sdk` exactly like `chat.test.tsx` (reuse its `httpError` helper — copy it into a shared `test/verification/helpers.ts`):

```ts
const { getDocumentExtraction, validateDocumentExtraction, withSessionToken } = vi.hoisted(() => {
  const getDocumentExtraction = vi.fn();
  const validateDocumentExtraction = vi.fn();
  const withSessionToken = vi.fn((_t: string, _b?: string) => ({
    documents: { getDocumentExtraction, validateDocumentExtraction },
  }));
  return { getDocumentExtraction, validateDocumentExtraction, withSessionToken };
});
vi.mock('@gemina/sdk', () => ({ GeminaClient: { withSessionToken } }));
```

   Plus a fixture builder `extraction(overrides)` returning a realistic `ExtractionPrimaryViewOutDTO`-shaped object (status success, `meta: { processingStatus: 'success', validated: false, purgedAt: null, validationFeedback: { validationSchema: [...] }, ... }`, `document: { imageUrl: 'https://img.test/1.png', ... }`, `values: {...}`). Tests: loading state visible initially; happy load renders the form and the viewer img; each row of the mapping table above renders its copy and fires (or doesn't) `onError` with the right reason; a 401-then-success sequence loads fine with `fetchToken` called twice and no error UI; 401-twice shows session-expired; load-failed Retry refetches.
2. Run → FAIL. 3. Implement (also `ensureVerificationStylesInjected()` in the mount effect, `mountedRef` guard on every async setState — chat lines 608–622 pattern).
4. Run: `npx vitest run test/verification/verification-load.test.tsx test/chat.test.tsx` → both PASS.
5. Commit: `git -C /home/chronic/gemina/gemina-sdk add -A && git -C /home/chronic/gemina/gemina-sdk commit -m "feat(elements): GeminaVerification fetch + state machine + edge states; extract shared response-like helpers"`

---

### Task 15: root component part 2 — layout, flash wiring, RTL/theme, image expiry

**Files:**
- Modify: `packages/elements/src/verification/index.tsx`
- Test: `packages/elements/test/verification/verification-load.test.tsx` (extend)

1. Failing tests:
   - root carries `gemina-verification gemina-verification--auto` classes and honors `theme="dark"` / `className`;
   - `dir="auto"` + Hebrew in any bound extracted string value → root `dir="rtl"` + `--rtl` class; explicit `dir="ltr"` wins (mirror chat's direction tests; detection = `HEBREW_RE.test` over the bindings' `toInputString` values, computed once per load);
   - clicking a field's eye button flashes: the viewer receives `flashRects` (assert the flash rect appears), and `onFlashComplete` clears them;
   - image expiry: after a successful load, fire `error` on the img → `getDocumentExtraction` called again (fresh signed URL swapped in, no visible error); a second img error 5 seconds later does NOT refetch (throttle: at most one refetch per 60s — use fake timers); an img error when nothing ever loaded shows no refetch loop.
2. Run → FAIL.
3. Implement: two-pane `__panes` layout (viewer left, form right — grid handles RTL flip automatically); root-level `ResizeObserver` toggles `--stacked` below 860px root width (guarded for SSR/test); flash state `flashRects` + `handleFlash` passed down; expiry handler = throttled silent `fetchWithRetry()` that ONLY swaps `document.imageUrl` (and refreshed values/meta) without touching phase or edits. The expiry refresh must swallow its own errors (`catch` → do nothing): no phase change, no retry loop — the stale image simply stays broken until the next throttled attempt. Add a test: refetch rejecting on expiry leaves the review UI intact and produces no unhandled rejection.
4. Run → PASS. Commit: `git -C /home/chronic/gemina/gemina-sdk add -A && git -C /home/chronic/gemina/gemina-sdk commit -m "feat(elements): verification layout, flash wiring, RTL/theming, silent image-URL refresh"`

---

### Task 16: root component part 3 — edit state and progress summary

**Files:**
- Modify: `packages/elements/src/verification/index.tsx`
- Test: `packages/elements/test/verification/verification-load.test.tsx` (extend)

1. Failing tests: typing into a bound input updates the progress line to "N confirmed · 1 corrected" (N = bindings with extracted values minus dirty ones — read counts straight from `composeSubmission(bindings, edits)`); reverting the input text to its initial string returns the count to "0 corrected" (the edits map entry is DELETED when the new value equals `toInputString(binding.extracted)` — this is the dirty-tracking contract from Task 4); edits survive a re-render.
2. Run → FAIL.
3. Implement: `const [edits, setEdits] = useState<Map<string, string>>(new Map())`; `handleEdit(rawKey, value)` deletes-or-sets per the revert rule; progress footer `__progress` renders the two counts + the Submit button (disabled in readOnly; label "Submit feedback").
4. Run → PASS. Commit: `git -C /home/chronic/gemina/gemina-sdk add -A && git -C /home/chronic/gemina/gemina-sdk commit -m "feat(elements): verification edit tracking + progress summary"`

---

### Task 17: root component part 4 — confirm dialog and submit flow

**Files:**
- Modify: `packages/elements/src/verification/index.tsx`
- Test: `packages/elements/test/verification/verification-submit.test.tsx`

Submit sequence: Submit button → `confirming` (in-component overlay `role="dialog" aria-modal="true"`, text: "Submit verification? This is final — feedback can be submitted only once and cannot be changed.", buttons Confirm submission / Cancel) → `submitting` → `PUT` via:

```tsx
const submitOnce = async () => {
  const token = await tokenManager.getToken();
  const body = composeSubmission(bindings, edits);
  const result = await GeminaClient.withSessionToken(token, baseUrl)
    .documents.validateDocumentExtraction({
      targetDocumentExtractionId: extractionId,
      extractionValidationInDTO: { data: body.data },
    });
  return { body, result };
};
```

with the same 401 invalidate-retry-once wrapper as the GET. Outcomes:

- success → phase `done` (checkmark state, recap "N confirmed · M corrected"), then `onComplete({ correctedValues: body.byLabel, summary: result.data })` — exactly once (`completedRef` guard);
- 409 (someone verified concurrently; feedback is one-shot with a unique constraint) → silent refetch via `loadExtraction()` → lands in the already-validated read-only banner state; no `onError`;
- 401 after retry → `submit-error` with the session-expired copy (edits kept — a fresh sign-in in another tab plus Retry can still succeed);
- anything else (network, 5xx, 422) → phase `submit-error` with the server `description` when present else "Submission failed — your corrections are still here.", inline Retry button, `onError('submit-failed', detail)`. **Edits state is never cleared on failure.**

1. Failing tests: confirm dialog appears and Cancel returns to review with edits intact; Confirm fires the PUT with the EXACT composed body (assert `validateDocumentExtraction` called with untouched raw values + edited strings, omitted blank-missing keys — the Task 4 rules, now end-to-end); success renders the done state and `onComplete` receives `byLabel` + the mocked `summary`; 409 → refetch → "Already verified" banner, no error callback; 500 → submit-error, inputs still show the user's edits, Retry re-PUTs and succeeds; 401-then-success on submit re-mints and passes; double-click on Confirm does not double-submit (button disabled while `submitting`).
2. Run → FAIL. 3. Implement. 4. Run → PASS.
5. Commit: `git -C /home/chronic/gemina/gemina-sdk add -A && git -C /home/chronic/gemina/gemina-sdk commit -m "feat(elements): verification confirm-final submit flow with 409/failure recovery"`

---

### Task 18: suite sweep, a11y pass, build gate

**Files:**
- Modify: whatever the sweep flags
- Test: all of `packages/elements/test/`

1. Run the design §8 checklist against the test files and add anything missed: one rendering test per shape bucket (Task 13), editing round-trip incl. raw-value round-trip (Tasks 4/16/17), every edge state (Task 14 table + submit outcomes), 401-retry on BOTH verbs, RTL, confirm-is-final. Add an a11y assertions test: viewer canvas has `role="img"` + `aria-label="Document image"`; the form is a `<form>` or region labeled "Extraction fields"; every input has an aria-label; the progress line is `aria-live="polite"`; edge states use `role="status"` (neutral) or `role="alert"` (errors).
2. `npx vitest run` → everything green (expect ~9 test files). `npm run typecheck` silent. `npm run build` succeeds and `ls dist/` shows the three `verification.*` artifacts.
3. Commit: `git -C /home/chronic/gemina/gemina-sdk add -A && git -C /home/chronic/gemina/gemina-sdk commit -m "test(elements): verification suite sweep + a11y assertions"`

---

### Task 19: demo page

**Files:**
- Create: `packages/elements/demo/verification.html`
- Create: `packages/elements/demo/verification-demo.tsx`

1. Mirror the chat demo exactly (`demo/index.html` + `demo/demo.tsx` are the template): paste-a-token flow (the mint curl comment must show the NEW body once the backend ships: `-d '{"ttlSeconds": 900, "extractionIds": ["<extraction-uuid>"]}'` — include it commented as "requires backend >= the verification release"), inputs for base URL + extraction id + token, a Mount button, and `<GeminaVerification>` wired with `onComplete`/`onError` logging via `window.alert`/`console.log`. Build line in the html comment:

```
npx esbuild demo/verification-demo.tsx --bundle --outfile=demo/verification-demo.js \
  --jsx=automatic --define:process.env.NODE_ENV='"production"'
```

2. Build it once locally to prove it bundles: run the esbuild line → exit 0. (Do not commit `demo/verification-demo.js`; `.gitignore` check — the chat demo's `demo.js` is untracked, follow suit.)
3. Commit: `git -C /home/chronic/gemina/gemina-sdk add packages/elements/demo/verification.html packages/elements/demo/verification-demo.tsx && git -C /home/chronic/gemina/gemina-sdk commit -m "docs(elements): manual demo page for GeminaVerification"`

---

### Task 20: SDK spec refreeze + regen — **BLOCKED on backend**

> **GATE: do not start until the gemina-api-v2 changes (extraction-scoped tokens, dual auth on the two documents routes, populated `validationFeedback` on the view GET) are MERGED AND DEPLOYED to production.** `SessionTokenInDTO` is `extra="forbid"` — nothing may send `extractionIds` before then, and the spec served at `/openapi.json` will not contain the changes until the deploy. Everything before this task runs against mocks and is NOT blocked.

**Files:**
- Create: `specs/gemina-<new-version>.json` (via tool)
- Modify: `specs/CURRENT` (via tool)
- Modify: `sdks/{typescript,python,csharp,java,php}/…/generated…` (via tool)

1. From the repo root `/home/chronic/gemina/gemina-sdk`:
   `python3 tools/fetch_spec.py --base-url https://api.gemina.co`
   → expect `froze specs/gemina-<X.Y.Z>.json (<n> operations) and updated specs/CURRENT`. The tool validates operationIds/tags; a failure here means the backend spec-hardening regressed — stop and report.
2. Sanity-check the delta before generating:
   `python3 - <<'EOF'` … load the new snapshot and assert: `SessionTokenInDTO.properties.extractionIds` exists; `paths['/api/v1/documents/extractions/{document_extraction_id}'].get.security` and the feedback `put.security` both list the bearer scheme alongside `APIKeyHeader`. `EOF`
   If any assertion fails, the backend change is incomplete — stop and report.
3. Regenerate all five SDKs (Docker required): `python3 tools/generate.py` → per-language `=== name ===` blocks, no errors.
4. Verify the generated TS picked up the auth: `grep -n "accessToken" sdks/typescript/src/generated/apis/DocumentApi.ts` must now show `Authorization` handling inside `getDocumentExtractionRequestOpts` AND `validateDocumentExtractionRequestOpts`; `grep -n "extractionIds" sdks/typescript/src/generated/models/SessionTokenInDTO.ts` non-empty.
5. Reproducibility: `python3 tools/generate.py --check` → `regeneration reproducible: zero diff under sdks/`.
6. TS SDK gate: `cd sdks/typescript && npm ci && npm run build && npm test` → green.
7. Commit (on `main`, not the feature branch — the regen is independently releasable):
   `git -C /home/chronic/gemina/gemina-sdk add specs sdks && git -C /home/chronic/gemina/gemina-sdk commit -m "feat(sdk): regen from gemina-<X.Y.Z> — extraction-scoped tokens + dual auth on documents read/feedback"`

---

### Task 21: elements README + integration docs — gated with Task 20

**Files:**
- Modify: `packages/elements/README.md`

1. Add a `## <GeminaVerification>` section: the 5-line integration snippet from the design doc (`tokenManager` whose `fetchToken` POSTs `{ extractionId }` to the client's own mint endpoint; `extractionId + tokenManager + onComplete`), the subpath-table row (`@gemina/elements/verification` / `<GeminaVerification>` / React: yes), the props table, the edge-state behavior summary, and — verbatim requirement from design §4 — the **shared-responsibility warning**: "Your mint endpoint MUST authorize the requested `extractionIds` against the requesting end-user before minting. Gemina enforces the claim; you enforce who gets the claim." Also state the one-shot semantics ("submission is final; corrections are delivered to your `onComplete` and to Gemina's accuracy scoring — they are not retrievable afterwards").
2. Note for post-release: `tools/sync_console_docs.sh` copies this README into the console (`README_sdk_elements.md`) — run it AFTER the release (Task 22), per that script's header comment.
3. Commit: `git -C /home/chronic/gemina/gemina-sdk add packages/elements/README.md && git -C /home/chronic/gemina/gemina-sdk commit -m "docs(elements): GeminaVerification integration guide + shared-responsibility note"`

---

### Task 22: lockstep release — **gated; requires human sign-off on the two-tag sequence**

**Files:**
- Modify: every version manifest listed below (twice — see sequence)
- Modify: `packages/elements/package.json` + `packages/elements/package-lock.json` (pin bump, second tag only)

**Why two tags (do not "simplify" this):** `release.yml`'s `npm-elements` job runs `npm ci`, so `packages/elements/package-lock.json` must resolve `@gemina/sdk` to a version that ALREADY exists on npm — you cannot know the integrity hash of an unpublished tarball. And the component must not ship with the old pin (`^0.2.0` resolves to a generated client that never attaches the bearer header → verification would 401 at runtime for every consumer). Therefore:

**Tag A — SDK regen release (e.g. v0.6.0; use the actual next version):**
1. On `main` WITHOUT the feature branch merged (main holds Task 20's regen only). Bump the version EVERYWHERE `release.yml` greps — this is the lockstep sweep that has been missed before (the workflow gates it): `sdks/typescript/package.json`, `sdks/typescript/src/version.ts`, `sdks/python/pyproject.toml`, `sdks/python/src/gemina/_version.py`, `sdks/csharp/src/Gemina.Sdk/Gemina.Sdk.csproj`, `sdks/csharp/src/Gemina.Sdk/Helpers/SdkVersion.cs`, `sdks/java/pom.xml`, `sdks/java/src/main/java/co/gemina/sdk/SdkVersion.java`, `sdks/java/README.md`, `sdks/php/src/SdkVersion.php`, `packages/elements/package.json` (version only — pin stays `^0.2.0`), `packages/elements/src/version.ts`.
2. Commit `chore(release): bump versions to 0.6.0`, tag `v0.6.0`, push tag → CI publishes `@gemina/sdk@0.6.0` to npm (and the other registries).
3. WAIT for the `npm` job to succeed (`npm view @gemina/sdk@0.6.0 version` returns).

**Tag B — elements verification release (e.g. v0.7.0):**
4. Merge `feature/verification-elements` into `main`.
5. In `packages/elements`: change `"@gemina/sdk": "^0.2.0"` → `"^0.6.0"`, then `npm install` (updates `package-lock.json` against the now-published version), then `npm run typecheck && npm test && npm run build` → all green against the REAL new SDK (this is the first time the component compiles against the regen — fix any drift here, e.g. renamed generated params).
6. Repeat the full version sweep from step 1 to `0.7.0` (all twelve locations).
7. Commit `chore(release): bump versions to 0.7.0 — GeminaVerification + @gemina/sdk pin`, tag `v0.7.0`, push `main` + tag.
8. After CI is green: run `tools/sync_console_docs.sh` and commit the refreshed `README_sdk_elements.md` in the console repo. The console "Verify" button showcase is a separate console-repo plan (design §7) and starts only now.

---

## Explicitly cut (YAGNI — do not add)

- Table pagination, page-size pickers, and the expand-to-modal table (console-domain conveniences).
- Word/PDF/print export, cost display, toasts (design §3 v1 cuts).
- Payload-as-props mode, render-prop customization, per-field callbacks, resubmission/drafts (design §10).
- Webhooks (`extraction.verified` is future backend work).
- The console's syntax-highlighted `JsonViewer` (fallback JSON is a `<details>` + `<pre>`).
