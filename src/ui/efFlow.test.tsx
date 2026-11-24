// @vitest-environment jsdom
/**
 * The end-fire workflow as the user walks it (rebuilt 8.11.2026): select the
 * front row, End-fire… from the Sources panel or the right-click menu, one
 * dialog, and the block appears with its rows, their delays in the always-
 * present End-fire panel, and the EF column in the tables.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from './App';
import { makeSource, useStore } from '../state/store';
import { DEFAULT_SPEAKER_ID } from '../speakers/library';
import { EN } from '../i18n';

const st = () => useStore.getState();

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
        if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
        if (key === 'createImageData') return () => ({ data: new Uint8ClampedArray(4) });
        return () => undefined;
      },
      set: () => true,
    },
  );
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
});

beforeEach(() => {
  st().newProject();
  useStore.setState({ undoStack: [], toast: null, view3d: false, ctxMenu: null, endFireOpen: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The row of the source list (not the tree) that names this cabinet. */
function gpsRow(label: string): HTMLTableRowElement {
  const hit = screen
    .getAllByText(label)
    .map((el) => el.closest('tr'))
    .find((tr): tr is HTMLTableRowElement => !!tr);
  if (!hit) throw new Error(`no table row for ${label}`);
  return hit;
}

function frontRow() {
  const subs = [0, 1.5].map((x, i) => makeSource(DEFAULT_SPEAKER_ID, `EFS ${i + 1}`, { x, y: 0, z: 0.3 }));
  useStore.setState({ sources: subs, selectedSourceIds: [], showGps: true });
  return subs;
}

describe('End-fire, from the front row to the block', () => {
  it('is findable before it has been used: the panel says how', () => {
    render(<App />);
    expect(screen.getByText(EN['ef.none'])).toBeTruthy();
  });

  it('walks the whole path in the running interface', () => {
    const subs = frontRow();
    render(<App />);

    // the right-click menu on a row of the list selects it and offers End-fire
    act(() => st().selectSources(subs.map((x) => x.id)));
    fireEvent.contextMenu(gpsRow('EFS 1'));
    fireEvent.click(screen.getByRole('menuitem', { name: EN['ctx.makeEf'] }));

    // one row selected: the dialog says it builds the rows behind it
    expect(screen.getByText(EN['efd.build'].replace('{count}', '2'))).toBeTruthy();
    const rows = screen.getByLabelText(EN['efd.rows']);
    fireEvent.change(rows, { target: { value: '4' } });
    fireEvent.blur(rows);
    fireEvent.click(screen.getByRole('button', { name: EN['efd.createBuild'].replace('{rows}', '4') }));

    expect(st().sources).toHaveLength(8);
    expect(st().efArrays).toHaveLength(1);
    // the panel lists the rows front to rear, with the rear one at 0 ms
    expect(screen.getByText(EN['ef.rear'])).toBeTruthy();
    expect(screen.getAllByText('0.00 ms').length).toBeGreaterThan(0);
    // and the tables carry the row
    expect(screen.getAllByText('EF 1 R1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('EF 1 R4').length).toBeGreaterThan(0);

    // the menu takes a cabinet out again
    fireEvent.contextMenu(gpsRow('EFS 1'));
    fireEvent.click(screen.getByRole('menuitem', { name: EN['ctx.releaseEf'] }));
    expect(st().sources.find((x) => x.label === 'EFS 1')!.ef).toBeUndefined();
  });

  it('the Sources panel button opens the same dialog, and the frequency sets the spacing', () => {
    const subs = frontRow();
    render(<App />);
    act(() => st().selectSources([subs[0].id]));
    fireEvent.click(screen.getAllByRole('button', { name: EN['ef.newDots'] })[0]);
    const hz = screen.getByLabelText(EN['efd.tune']);
    fireEvent.change(hz, { target: { value: '86' } });
    fireEvent.blur(hz);
    const spacing = screen.getByLabelText(EN['efd.spacing']) as HTMLInputElement;
    expect(Number(spacing.value)).toBeCloseTo(st().sim.speedOfSound / 86 / 4, 2);
  });

  it('dissolving from the panel keeps the cabinets and drops the delays', () => {
    const subs = frontRow();
    act(() => {
      st().selectSources(subs.map((x) => x.id));
      st().createEndFire({ ids: subs.map((x) => x.id), aimDeg: 0, rows: 3, spacingM: 1, targetHz: null });
    });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: `EF 1: ${EN['ef.delete']}` }));
    expect(st().efArrays).toHaveLength(0);
    expect(st().sources).toHaveLength(6);
    expect(st().sources.every((x) => x.efDelayS === undefined)).toBe(true);
  });
});
