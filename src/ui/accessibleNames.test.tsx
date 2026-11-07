// @vitest-environment jsdom
/**
 * Every control in the panels has to say what it is. The form rows set a label
 * beside a field rather than around it, so nothing in the markup catches a field
 * that has lost its name, and a table cell has no label to begin with.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from './App';
import { useStore } from '../state/store';
import { OFFERED_SPEAKER_IDS } from '../speakers/library';

function unnamed(root: ParentNode = document) {
  return Array.from(root.querySelectorAll<HTMLElement>('button, select, input, textarea'))
    .filter((el) => {
      if ((el as HTMLInputElement).type === 'hidden') return false;
      const labelled = (el as HTMLInputElement).labels?.length;
      return !(el.textContent?.trim() || el.getAttribute('aria-label') || el.title || labelled);
    })
    .map((el) => el.outerHTML.slice(0, 120));
}

// jsdom has neither layout nor a canvas raster: stubs of the platform, as in smoke.test.tsx.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const ctx = new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === 'canvas') return undefined;
        if (key === 'measureText') return () => ({ width: 0 });
        if (key === 'getImageData' || key === 'createImageData') return () => ({ data: new Uint8ClampedArray(4) });
        return () => undefined;
      },
      set: () => true,
    },
  );
  globalThis.ImageData ??= class {
    data: Uint8ClampedArray;
    constructor(a: Uint8ClampedArray | number, b: number) {
      this.data = typeof a === 'number' ? new Uint8ClampedArray(a * b * 4) : a;
    }
  } as unknown as typeof ImageData;
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
});

describe('names of the controls', () => {
  beforeEach(() => {
    cleanup();
    const st = useStore.getState();
    st.newProject();
    st.createSubArray({ speakerId: OFFERED_SPEAKER_IDS[0], count: 3, spacingM: 2, axis: 'x' });
  });

  it('leaves no field or button in the main window without one', () => {
    useStore.setState({ showSteering: true, showGroups: true, showGps: true, showPolar: true });
    render(<App />);
    expect(unnamed()).toEqual([]);
  });

  it('says which way a collapsible section stands', () => {
    useStore.setState({ showSteering: false, showGroups: false });
    render(<App />);
    const sources = screen.getAllByRole('button', { expanded: true })[0];
    fireEvent.click(sources);
    expect(sources.getAttribute('aria-expanded')).toBe('false');
  });

  it('lets the keyboard pick a row of the source tree', () => {
    useStore.setState({ showSteering: false, showGroups: false });
    useStore.getState().selectSources([]);
    useStore.getState().selectGroup(null);
    render(<App />);
    const row = document.querySelector<HTMLElement>('.tree-row:not(.group)')!;
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(useStore.getState().selectedSourceIds.length).toBe(1);
  });
});
