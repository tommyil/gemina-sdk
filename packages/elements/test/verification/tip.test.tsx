/**
 * The tooltip primitive.
 *
 * It exists because `title=` cannot carry structure (the confidence reasons
 * are a heading plus a list), cannot be styled, cannot be reached by keyboard,
 * and is announced inconsistently by screen readers. Everything asserted here
 * is a property `title=` lacked.
 *
 * The portal is the load-bearing part: the console hosts this component inside
 * a modal body with `max-height` + `overflow-y: auto`, which clips any
 * in-flow tooltip at the scroll edges.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Tip } from '../../src/verification/tip';

afterEach(cleanup);

/** Render a trigger inside a themed root, the way the component always does. */
function renderTip(content: React.ReactNode = 'ISO 4217 code', rootClass = 'gemina-verification') {
  return render(
    <div className={rootClass}>
      <Tip content={content}>
        <button type="button" aria-label="Currency">Currency</button>
      </Tip>
    </div>,
  );
}

describe('Tip', () => {
  it('renders nothing until hovered or focused', () => {
    renderTip();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows on focus and links to the trigger via aria-describedby', async () => {
    renderTip();
    const trigger = screen.getByRole('button');
    fireEvent.focus(trigger);

    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain('ISO 4217 code');
    expect(trigger.getAttribute('aria-describedby')).toBe(tip.id);
    expect(tip.id).toBeTruthy();
  });

  it('shows on mouseenter and hides on mouseleave', async () => {
    renderTip();
    const trigger = screen.getByRole('button');

    fireEvent.mouseEnter(trigger);
    expect(await screen.findByRole('tooltip')).toBeTruthy();

    fireEvent.mouseLeave(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
    // The link is removed with the tip — a dangling aria-describedby points at
    // nothing and is announced as an empty description.
    expect(trigger.getAttribute('aria-describedby')).toBeNull();
  });

  it('hides on blur', async () => {
    renderTip();
    const trigger = screen.getByRole('button');
    fireEvent.focus(trigger);
    await screen.findByRole('tooltip');

    fireEvent.blur(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('dismisses on Escape without moving focus', async () => {
    renderTip();
    const trigger = screen.getByRole('button');
    trigger.focus();
    fireEvent.focus(trigger);
    await screen.findByRole('tooltip');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    // Escape dismisses the annotation, not the user's place in the form.
    expect(document.activeElement).toBe(trigger);
  });

  it('portals outside the component root so a scrolling host cannot clip it', async () => {
    const { container } = renderTip();
    fireEvent.focus(screen.getByRole('button'));
    const tip = await screen.findByRole('tooltip');

    expect(container.contains(tip)).toBe(false);
  });

  it('carries the root theme classes into the portal so custom properties resolve', async () => {
    renderTip('ISO 4217 code', 'gemina-verification gemina-verification--dark gemina-verification--rtl');
    fireEvent.focus(screen.getByRole('button'));
    const tip = await screen.findByRole('tooltip');

    // Outside the root, `--gemina-verification-*` would be undefined and the
    // tip would render unstyled on a transparent background.
    const themed = tip.closest('.gemina-verification');
    expect(themed).not.toBeNull();
    expect(themed?.classList.contains('gemina-verification--dark')).toBe(true);
    expect(themed?.classList.contains('gemina-verification--rtl')).toBe(true);
  });

  it('closes on scroll — a fixed tip does not follow a scrolling trigger', async () => {
    renderTip();
    fireEvent.focus(screen.getByRole('button'));
    await screen.findByRole('tooltip');

    fireEvent.scroll(document, {});
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('leaves the trigger accessible name alone', async () => {
    renderTip();
    const trigger = screen.getByRole('button');
    fireEvent.focus(trigger);
    await screen.findByRole('tooltip');

    // aria-label already carries the reason into the NAME; duplicating it into
    // the description would have a screen reader say it twice.
    expect(trigger.getAttribute('aria-label')).toBe('Currency');
  });

  it('renders structured content, not just a string', async () => {
    renderTip(
      <>
        <strong>Low confidence</strong>
        <ul><li>Blurry Region</li></ul>
      </>,
    );
    fireEvent.focus(screen.getByRole('button'));
    const tip = await screen.findByRole('tooltip');

    expect(tip.querySelector('strong')?.textContent).toBe('Low confidence');
    expect(tip.querySelectorAll('li')).toHaveLength(1);
  });

  it('renders no tip and no wrapper when content is empty', () => {
    renderTip('');
    fireEvent.focus(screen.getByRole('button'));
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-describedby')).toBeNull();
  });

  it('cleans its portal out of the body on unmount', async () => {
    const { unmount } = renderTip();
    fireEvent.focus(screen.getByRole('button'));
    await screen.findByRole('tooltip');

    unmount();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});
