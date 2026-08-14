/**
 * A tooltip primitive, portalled and themed.
 *
 * Replaces `title=`, which could not do any of the four things this component
 * needs: carry structure (the confidence annotation is a heading plus a list
 * of reasons), be styled to match the surface it floats over, appear on
 * keyboard focus, or be announced predictably.
 *
 * WHY A PORTAL. The console hosts `<GeminaVerification>` inside a modal body
 * with `max-height` + `overflow-y: auto`. Any in-flow tooltip is clipped at
 * that scroll edge, and the fields most likely to carry one — the low-
 * confidence rows — are exactly the ones a reviewer scrolls to. So the tip
 * renders into `document.body` and positions itself `fixed`.
 *
 * The cost of leaving the root is that `--gemina-verification-*` no longer
 * resolves, so the portal wraps its content in a div carrying the root's own
 * class list, read off the nearest `.gemina-verification` ancestor when the
 * tip opens. That keeps theme, dark mode and RTL correct without duplicating
 * a single value.
 *
 * Being `fixed`, it cannot follow a trigger that scrolls away — so it closes
 * on scroll rather than detaching from what it describes.
 */

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ReactElement, ReactNode, RefCallback } from 'react';
import { createPortal } from 'react-dom';

/** Distance between the trigger and the tip, in px. */
const GAP = 8;
/** Minimum breathing room from the viewport edge, in px. */
const MARGIN = 8;

export interface TipProps {
  /** Rich content — a fragment, a list, anything. Empty renders no tip. */
  content: ReactNode;
  /** The trigger. Receives handlers, a ref and `aria-describedby`. */
  children: ReactElement;
}

interface Position {
  top: number;
  left: number;
}

/** `content` that would produce an empty bubble. */
function isEmpty(content: ReactNode): boolean {
  return content == null || content === '' || content === false;
}

/**
 * The theme classes to reproduce outside the root.
 *
 * Copies the ancestor's whole class list rather than sniffing for known
 * modifiers, so a host that adds its own scoping class keeps working and this
 * never needs updating when a new modifier is introduced.
 */
function rootClassesOf(node: Element | null): string {
  const root = node?.closest('.gemina-verification');
  return root ? root.className : 'gemina-verification';
}

/** Attach our ref without dropping one the child already had. */
function mergeRefs<T>(ours: RefCallback<T>, theirs: unknown): RefCallback<T> {
  return (value: T) => {
    ours(value);
    if (typeof theirs === 'function') {
      (theirs as RefCallback<T>)(value);
    } else if (theirs && typeof theirs === 'object') {
      (theirs as { current: T | null }).current = value;
    }
  };
}

export function Tip({ content, children }: TipProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const [rootClasses, setRootClasses] = useState('gemina-verification');
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const id = useId();

  const empty = isEmpty(content);

  const show = useCallback(() => {
    if (empty) {
      return;
    }
    setRootClasses(rootClassesOf(triggerRef.current));
    setPosition(null); // re-measure; a stale position would flash in the wrong place
    setOpen(true);
  }, [empty]);

  const hide = useCallback(() => setOpen(false), []);

  // Measure AFTER paint but BEFORE the browser shows it: the tip renders
  // hidden until it has a position, so it never flashes at the origin.
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const trigger = triggerRef.current;
    const tip = tipRef.current;
    if (!trigger || !tip) {
      return;
    }
    const anchor = trigger.getBoundingClientRect();
    const bubble = tip.getBoundingClientRect();
    const viewportWidth = window.innerWidth || 0;
    const viewportHeight = window.innerHeight || 0;

    // Prefer above; flip below only when there is genuinely no room, so the
    // tip does not cover the control the pointer is already on.
    const fitsAbove = anchor.top - bubble.height - GAP >= MARGIN;
    const fitsBelow = anchor.bottom + bubble.height + GAP <= viewportHeight - MARGIN;
    const top = fitsAbove || !fitsBelow
      ? anchor.top - bubble.height - GAP
      : anchor.bottom + GAP;

    // Centre on the trigger, then clamp so a tip near either edge stays whole.
    const centred = anchor.left + anchor.width / 2 - bubble.width / 2;
    const rightLimit = Math.max(MARGIN, viewportWidth - bubble.width - MARGIN);
    const left = Math.min(Math.max(centred, MARGIN), rightLimit);

    setPosition({ top: Math.max(top, MARGIN), left });
  }, [open, content]);

  // Escape dismisses the annotation without disturbing focus; scroll closes
  // because a fixed tip would otherwise drift away from its trigger.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        hide();
      }
    };
    const onScrollOrResize = () => hide();
    document.addEventListener('keydown', onKeyDown);
    // Capture phase: scrolls inside the host's overflow container do not
    // bubble to document, and that container is the common case here.
    document.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, hide]);

  if (!isValidElement(children)) {
    return children;
  }

  const childProps = children.props as Record<string, unknown>;
  const call = (name: string, event: unknown) => {
    const handler = childProps[name];
    if (typeof handler === 'function') {
      (handler as (arg: unknown) => void)(event);
    }
  };

  const trigger = cloneElement(children, {
    ref: mergeRefs<HTMLElement>((node) => {
      triggerRef.current = node;
    }, (children as unknown as { ref?: unknown }).ref),
    // The tip is a DESCRIPTION. `aria-label` stays untouched — it already
    // carries the reason into the accessible NAME, and duplicating it here
    // would have a screen reader announce it twice.
    'aria-describedby': open && !empty ? id : undefined,
    onMouseEnter: (event: unknown) => { call('onMouseEnter', event); show(); },
    onMouseLeave: (event: unknown) => { call('onMouseLeave', event); hide(); },
    onFocus: (event: unknown) => { call('onFocus', event); show(); },
    onBlur: (event: unknown) => { call('onBlur', event); hide(); },
  } as Record<string, unknown>);

  const canPortal = typeof document !== 'undefined' && document.body;

  return (
    <>
      {trigger}
      {open && !empty && canPortal
        ? createPortal(
            <div className={rootClasses}>
              <div
                ref={tipRef}
                id={id}
                role="tooltip"
                className="gemina-verification__tip"
                style={{
                  top: position ? `${position.top}px` : '0px',
                  left: position ? `${position.left}px` : '0px',
                  visibility: position ? 'visible' : 'hidden',
                }}
              >
                {content}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
