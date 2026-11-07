// @vitest-environment jsdom
/**
 * The end-fired workflow as the user walks it: the EF Array box when creating
 * an array (with the warning past 3 rows), the right-click menu over a row of
 * the source list, the assign dialog with its occupied rows, the EF column,
 * and the panel that releases a row again.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from './App';
import { ArrayDialog } from './ArrayDialog';
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
  useStore.setState({ undoStack: [], toast: null, view3d: false, ctxMenu: null, efAssignOpen: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** NumField commits on blur or Enter, not on each keystroke. */
function typeNumber(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

/** The row of the source list (not the tree) that names this cabinet. */
function gpsRow(label: string): HTMLTableRowElement {
  const hit = screen
    .getAllByText(label)
    .map((el) => el.closest('tr'))
    .find((tr): tr is HTMLTableRowElement => !!tr);
  if (!hit) throw new Error(`no table row for ${label}`);
  return hit;
}

function seed() {
  const id = st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
  st().selectSources([id]);
  return id;
}

describe('the EF Array box in Create array', () => {
  it('shows the rows only when ticked, and creates the container', () => {
    seed();
    const { unmount } = render(<ArrayDialog onClose={() => undefined} />);
    expect(screen.queryByLabelText(EN['arr.efRows'])).toBeNull();
    fireEvent.click(screen.getByLabelText('EF Array'));
    typeNumber(screen.getByLabelText(EN['arr.efRows']), '2');
    fireEvent.click(screen.getByText(/Create 8/));
    expect(st().efArrays).toEqual([expect.objectContaining({ name: 'EF 1', rows: 2 })]);
    expect(st().sources).toHaveLength(8);
    unmount();
  });

  it('past 3 rows it warns in the given words and waits for the acceptance', () => {
    seed();
    render(<ArrayDialog onClose={() => undefined} />);
    fireEvent.click(screen.getByLabelText('EF Array'));
    typeNumber(screen.getByLabelText(EN['arr.efRows']), '4');
    expect(screen.getByText(EN['arr.efWarn'])).toBeTruthy();
    const create = screen.getByText(/Create 8/).closest('button')!;
    expect(create.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(EN['arr.efAccept']));
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    expect(st().efArrays[0].rows).toBe(4);
  });
});

describe('right click, assign, column, release', () => {
  function project() {
    const subs = [0, -2].map((y, i) => makeSource(DEFAULT_SPEAKER_ID, `EFS ${i + 1}`, { x: 0, y, z: 0.3 }));
    useStore.setState({
      sources: subs,
      efArrays: [{ id: 'ef1', name: 'EF 1', rows: 2 }],
      selectedSourceIds: [],
      showGps: true,
      showGroups: true,
    });
    return subs;
  }

  it('walks the whole path in the running interface', () => {
    const subs = project();
    render(<App />);

    // right click on a row of the source list selects it and opens the menu
    fireEvent.contextMenu(gpsRow('EFS 1'));
    expect(st().selectedSourceIds).toEqual([subs[0].id]);
    fireEvent.click(screen.getByRole('menuitem', { name: EN['ctx.assignEf'] }));

    // the dialog assigns row 1
    fireEvent.click(screen.getByRole('button', { name: EN['ef.assign'] }));
    expect(st().sources[0].ef).toEqual({ arrayId: 'ef1', row: 1 });

    // the EF column now says so
    expect(screen.getAllByText('EF 1 R1').length).toBeGreaterThan(0);

    // for the second cabinet, row 1 is listed but cannot be chosen
    fireEvent.contextMenu(gpsRow('EFS 2'));
    fireEvent.click(screen.getByRole('menuitem', { name: EN['ctx.assignEf'] }));
    const taken = screen.getByRole('option', { name: 'Row 1: taken, 1 cab.' }) as HTMLOptionElement;
    expect(taken.disabled).toBe(true);
    act(() => st().setEfAssignOpen(false));

    // the End-fired panel releases the row again
    fireEvent.click(screen.getByRole('button', { name: 'EF 1: Release row 1' }));
    expect(st().sources[0].ef).toBeUndefined();
  });

  it('the menu releases an assigned selection', () => {
    const subs = project();
    st().assignToEf([subs[0].id], 'ef1', 1);
    render(<App />);
    fireEvent.contextMenu(gpsRow('EFS 1'));
    fireEvent.click(screen.getByRole('menuitem', { name: EN['ctx.releaseEf'] }));
    expect(st().sources[0].ef).toBeUndefined();
    expect(st().ctxMenu).toBeNull();
  });
});
