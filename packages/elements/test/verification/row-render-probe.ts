/**
 * The TableRowView render probe, as shared infrastructure.
 *
 * WHAT IT COUNTS. Every `TableRowView` render creates exactly one clickable
 * `<tr>` — row click-to-flash — while the `<thead>` row carries no `onClick`
 * and nothing else in the verification tree creates table rows. A row React
 * skips renders nothing at all, so a tally of clickable-`<tr>` creations is a
 * tally of real row renders.
 *
 * WHY A PROBE AT ALL. The thing under test is a memo bail-out, and a bail-out
 * is invisible in the DOM: re-rendering all 169 rows of a real line-items
 * table on every keystroke produces byte-identical markup. A DOM assertion
 * passes either way, which is exactly the failure `areRowPropsEqual` exists to
 * prevent.
 *
 * WHY IT LIVES HERE. Two files need it — verification-edit.test.tsx (the row
 * memo itself) and form.test.tsx (the visible-column array that memo compares)
 * — and it is ~30 lines of subtle jsx-runtime wrapping. Copied, the two copies
 * drift and the second one quietly stops counting. The `vi.mock` CALLS must
 * still live in each test file (mocking is per-file, and vitest hoists those
 * calls above the imports), so each file passes in its own counter:
 *
 *     const probe = vi.hoisted(() => ({ rowRenders: 0 }));
 *     vi.mock('react/jsx-runtime', async (importOriginal) => {
 *       const { wrapJsxRuntime } = await import('./row-render-probe');
 *       return wrapJsxRuntime(await importOriginal(), probe);
 *     });
 *
 * The counter is the caller's — hoisted, per file, and reset in that file's
 * `afterEach` — so nothing is shared across files but the wrapping itself.
 * Both automatic-runtime entry points must be wrapped: vitest's esbuild may
 * emit either. The wrappers are pass-through; they add a tally and nothing else.
 */

/** A caller-owned tally. Declared as an interface so the field stays writable. */
export interface RowRenderProbe {
  rowRenders: number;
}

type JsxModule = Record<string, (...args: unknown[]) => unknown>;

function countClickableTr(type: unknown, props: unknown, probe: RowRenderProbe): void {
  if (type === 'tr' && typeof (props as { onClick?: unknown } | null)?.onClick === 'function') {
    probe.rowRenders += 1;
  }
}

/** The production automatic runtime, tallying row renders on the way through. */
export function wrapJsxRuntime(actual: JsxModule, probe: RowRenderProbe): JsxModule {
  return {
    ...actual,
    jsx: (type: unknown, props: unknown, key?: unknown) => {
      countClickableTr(type, props, probe);
      return actual.jsx!(type, props, key);
    },
    jsxs: (type: unknown, props: unknown, key?: unknown) => {
      countClickableTr(type, props, probe);
      return actual.jsxs!(type, props, key);
    },
  };
}

/** The development automatic runtime — the one vitest actually emits by default. */
export function wrapJsxDevRuntime(actual: JsxModule, probe: RowRenderProbe): JsxModule {
  return {
    ...actual,
    jsxDEV: (type: unknown, props: unknown, ...rest: unknown[]) => {
      countClickableTr(type, props, probe);
      return actual.jsxDEV!(type, props, ...rest);
    },
  };
}
