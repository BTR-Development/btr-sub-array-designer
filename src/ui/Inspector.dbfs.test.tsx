// @vitest-environment jsdom
/**
 * Poziomy w Inspektorze są w dBFS — na wewnętrznej skali programu, nie
 * w zmierzonych dB SPL. Goły "dB" czytał się jak pomiar, którym
 * nie jest.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Inspector } from './Inspector';
import { useStore } from '../state/store';
import { DEFAULT_SPEAKER_ID } from '../speakers/library';

const st = () => useStore.getState();

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // jsdom nie ma układu, a Inspektor dosuwa widok do zaznaczenia
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => st().newProject());
afterEach(() => cleanup());

describe('the point readout unit', () => {
  it('says dBFS, and never a bare dB that reads as measured SPL', () => {
    st().createSubArray({ speakerId: DEFAULT_SPEAKER_ID, count: 2, spacingM: 2, axis: 'x' });
    st().addMeasurementPoint({ x: 0, y: 20, z: 1.7 }, 'FOH');
    st().selectPoint(st().measurementPoints[0].id);
    render(<Inspector />);

    const spl = screen.getByText(/SPL @/).parentElement!;
    expect(spl.textContent).toMatch(/dBFS/);
  });
});
