// @vitest-environment jsdom
/**
 * Does the interface actually run?
 *
 * WHY THIS FILE EXISTS
 *
 * Before it, 206 tests covered the physics, the file formats and the state,
 * and NOT ONE covered the 4686 lines of `src/ui`. Every defect found in this
 * project during the week of 24 August lived in exactly that untested half:
 * a side view that probed the wrong point, a preset aiming out of its own
 * section, a measurement list contradicting the canvas, and a render that
 * threw `planeAxes is not defined` because a usage landed before its import.
 * The suite stayed green through all of them.
 *
 * This is not a substitute for looking at the app. It is the cheap floor
 * underneath it: mount the real component tree, drive the controls a person
 * drives, and fail on any error or any React warning. A test that only checks
 * "it rendered something" would have passed during every one of those bugs, so
 * the console assertions are the point, not the decoration.
 *
 * The prediction worker does not exist in jsdom. That is deliberate and useful:
 * PredictionClient falls back to solving on this thread, so the map is really
 * computed here rather than mocked away.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { App } from './App';
import { makeSource, useStore } from '../state/store';
import { EXAMPLE_RIGS } from '../state/exampleRigs';
import { builtinProvider } from '../speakers/provider';
import { EN, translate, type Lang, type MessageKey } from '../i18n';

/**
 * jsdom has no layout and no canvas raster, so two browser facilities have to
 * be stood in for. Both are stubs of the PLATFORM, never of our own code: the
 * moment a test stubs a module of ours it stops being able to fail for the
 * reasons this file exists.
 */
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

  // Every 2D context call is accepted and does nothing; property reads return
  // a benign value. Drawing is verified by eye and by screenshot, not here.
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

  globalThis.URL.createObjectURL ??= () => 'blob:test';
  globalThis.URL.revokeObjectURL ??= () => undefined;
});

/** Anything the app writes to console.error or console.warn fails the test. */
let noise: string[] = [];

beforeEach(() => {
  noise = [];
  const capture = (...a: unknown[]) => {
    noise.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
  };
  vi.spyOn(console, 'error').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  useStore.getState().newProject();
  // The VIEW is deliberately not part of the document, so `newProject` leaves
  // it alone — which means a test that turns the 3D viewport on hands it to
  // every test after it, and they then exercise Canvas3D while their names say
  // CanvasStage. Reset here rather than in the product.
  useStore.setState({ view3d: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Fails with the actual message rather than "expected 0 to be 0". */
function expectQuiet() {
  expect(noise.join('\n---\n')).toBe('');
}

const TABS = [
  'Plan view, X/Y',
  'Section along the room, Y/Z',
  'The rig as a solid, with the prediction plane where it actually sits',
  'Array module: layout and steering',
  'Free and far field polar pattern',
  "Source GPS: every cabinet's coordinates and polarity",
];

describe('the app runs', () => {
  it('mounts without complaint', () => {
    render(<App />);
    expect(screen.getByTitle('Plan view, X/Y')).toBeTruthy();
    expectQuiet();
  });

  it('opens on an EMPTY project, not on somebody else\'s array', () => {
    // The application used to mount a sixteen-cabinet demo, so every session
    // began by deleting a rig nobody asked for.
    render(<App />);
    expect(useStore.getState().sources).toHaveLength(0);
    expect(useStore.getState().groups).toHaveLength(0);
    expectQuiet();
  });

  it('opens every tab', () => {
    // The crash that started this hunt only appeared once a particular panel
    // rendered, so visiting all of them is the whole test.
    render(<App />);
    for (const title of TABS) {
      fireEvent.click(screen.getByTitle(title));
      expectQuiet();
    }
  });

  it('survives the side view, which is where the projection bugs lived', () => {
    render(<App />);
    fireEvent.click(screen.getByTitle('Section along the room, Y/Z'));
    expect(screen.getByText(/side view Y\/Z/)).toBeTruthy();
    expectQuiet();
  });

  it('draws the 3D viewport, orbits it, and comes back to a 2D view', () => {
    // A third projection of the same world is exactly where the old plane
    // bugs lived, and this one paints solids rather than sprites: a bad
    // normal, a missing model or an empty prediction all throw inside the
    // paint loop, where nothing but the console would say so.
    render(<App />);
    fireEvent.click(
      screen.getByTitle('The rig as a solid, with the prediction plane where it actually sits'),
    );
    // The 2D stage draws a canvas in a .canvas-wrap too, so the hint is what
    // says WHICH view is on screen. Without it this test passes against a
    // button that does nothing.
    expect(screen.getByText(/Drag to orbit/)).toBeTruthy();
    const canvas = document.querySelector('.canvas-wrap canvas');
    if (!canvas) throw new Error('the 3D viewport drew no canvas');
    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(canvas, { clientX: 160, clientY: 70 });
    fireEvent.pointerUp(canvas);
    fireEvent.wheel(canvas, { deltaY: -120 });
    fireEvent.doubleClick(canvas);
    expectQuiet();

    // and the plane buttons take you back out of it. The plot HEADING is drawn
    // by the chrome around the canvas and says "top view" in both views, so it
    // cannot tell them apart: the hint can, because only Canvas3D renders it.
    fireEvent.click(screen.getByTitle('Plan view, X/Y'));
    expect(screen.queryByText(/Drag to orbit/)).toBeNull();
    expect(screen.getByText(/top view X\/Y/)).toBeTruthy();
    expectQuiet();
  });

  it('draws the 3D viewport with nothing in the project', () => {
    // Nothing to frame, nothing to paint and no solve to lay down: three
    // separate chances to divide by zero or read a dimension off a model that
    // is not there. Asserted, because a preset loading itself behind the test
    // would make this the demo project with a different name.
    render(<App />);
    fireEvent.click(
      screen.getByTitle('The rig as a solid, with the prediction plane where it actually sits'),
    );
    act(() => {
      useStore.getState().newProject();
    });
    expect(useStore.getState().sources).toHaveLength(0);
    expect(screen.getByText(/Drag to orbit/)).toBeTruthy();
    const canvas = document.querySelector('.canvas-wrap canvas');
    if (!canvas) throw new Error('the 3D viewport drew no canvas');
    fireEvent.doubleClick(canvas);
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, button: 0, buttons: 1 });
    fireEvent.pointerMove(canvas, { clientX: 60, clientY: 40, buttons: 1 });
    fireEvent.pointerUp(canvas);
    expectQuiet();
  });
});

describe('the controls work', () => {
  it('changes frequency without falling over', () => {
    render(<App />);
    const slider = document.querySelector<HTMLInputElement>('input[type=range].slider.full')!;
    for (const hz of ['40', '63', '125', '200', '31.5']) {
      fireEvent.change(slider, { target: { value: hz } });
    }
    expect(useStore.getState().sim.frequencyHz).toBeCloseTo(31.5, 6);
    expectQuiet();
  });

  it('switches averaging, which re-enters the solver on a different path', () => {
    render(<App />);
    const avg = within(screen.getByRole('group', { name: 'Averaging' }));
    fireEvent.click(avg.getByText('1/3'));
    expect(useStore.getState().sim.bandOct).toBeCloseTo(1 / 3);
    fireEvent.click(avg.getByText('1/1'));
    expect(useStore.getState().sim.bandOct).toBe(1);
    fireEvent.click(avg.getByText('Pink'));
    expect(useStore.getState().sim.signal).toBe('pink');
    fireEvent.click(avg.getByText('Tone'));
    expect(useStore.getState().sim.signal).toBe('tone');
    expect(useStore.getState().sim.bandOct).toBe(0);
    expectQuiet();
  });

  it('changes language without leaving raw keys on screen', () => {
    // A missing translation renders as the key itself, so the check is against
    // the real key list rather than a clever pattern: an earlier version of
    // this test used a regex and flagged ordinary Polish abbreviations.
    //
    // The second half is the one that can fail. `translate` falls back to
    // English by construction, so "no raw keys on screen" is true of an
    // interface with no dictionaries at all, and this case was green through
    // the whole period the disclaimers were hardcoded. Three headings that are
    // always on screen are therefore checked for the operator's own words AND
    // for the absence of the English ones.
    const keys = Object.keys(EN);
    const HEADINGS: MessageKey[] = ['src.title', 'area.title', 'right.band'];
    render(<App />);
    const lang = document.querySelector<HTMLSelectElement>('select.lang-select')!;
    for (const l of ['pl', 'it', 'en'] as Lang[]) {
      fireEvent.change(lang, { target: { value: l } });
      const text = document.body.textContent ?? '';
      expect(keys.filter((k) => text.includes(k))).toEqual([]);
      for (const k of HEADINGS) {
        expect(text, `${k} in ${l}`).toContain(translate(l, k));
        if (l !== 'en') expect(text, `English ${k} left in ${l}`).not.toContain(EN[k]);
      }
      expectQuiet();
    }
  });
});

describe('every preset loads and solves', () => {
  // Flown Column aimed its column out of the drawn section for six days
  // without a single test noticing, because nothing ever loaded a preset.
  it.each(EXAMPLE_RIGS.map((p) => [p.name, p.id] as const))('%s', (_name, id) => {
    render(<App />);
    const preset = EXAMPLE_RIGS.find((p) => p.id === id)!;
    const built = preset.build();
    useStore.getState().loadDoc(built.doc, built.sim);
    expect(useStore.getState().sources.length).toBeGreaterThan(0);
    expectQuiet();
  });
});

describe('a solve the engine refuses', () => {
  /**
   * The other way this canvas goes blank.
   *
   * `PredictionClient` refuses a request carrying a non-finite number, because
   * the engine's answer to a NaN is silence and a map of silence is
   * indistinguishable from a correct prediction of a rig that is not playing.
   * The refusal reached a console nobody has open: the plot was empty, the
   * status line said Ready, and the "add a subwoofer" overlay was gated on the
   * project, so a project WITH cabinets showed nothing at all.
   */
  const withBrokenDriveLevel = () => {
    const base = builtinProvider.get('la-ks28')!;
    // A drive level that is not a number. `resolve` reads maxSpl as refSplDb,
    // which is what the engine turns into a complex amplitude, so this is the
    // shape every reported case of this has had.
    useStore.getState().addCustomSpeaker({ ...base, id: 'broken-sub', model: 'BROKEN SUB', maxSpl: NaN });
    useStore.getState().addSource('broken-sub', { x: 0, y: 0, z: 0.275 });
  };

  it('says so on the canvas instead of only in the console', async () => {
    withBrokenDriveLevel();
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });

    const text = document.body.textContent ?? '';
    expect(text).toContain(EN['plot.refused']);
    // and it names the field, which is what makes the project fixable
    expect(text).toContain('reference SPL');
    // not the beginner's prompt: this project has a cabinet in it
    expect(text).not.toContain(EN['plot.emptyTitle']);

    // The console still carries it for a bug report, and that is the only
    // noise this case is allowed to make.
    expect(noise.join('\n')).toContain('reference SPL');
  });

  it('takes the message down again once the project can be solved', async () => {
    withBrokenDriveLevel();
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(EN['plot.refused']);

    act(() => {
      const st = useStore.getState();
      st.selectSources(st.sources.map((x) => x.id));
      st.deleteSelected();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const text = document.body.textContent ?? '';
    expect(text).not.toContain(EN['plot.refused']);
    expect(text).toContain(EN['plot.emptyTitle']);
  });
});

describe('the plot heading says what the map stands on', () => {
  const ks = (id: string, x: number) => makeSource(id, `S${x}`, { x, y: 0, z: 0.3 });

  it('is silent with nothing in the project', () => {
    const { container } = render(<App />);
    expect(container.querySelector('.plot-grade')).toBeNull();
    expectQuiet();
  });

  it('names the grade of a one-model rig', () => {
    act(() => useStore.setState({ sources: [ks('la-ks28', 0), ks('la-ks28', 1)] }));
    const { container } = render(<App />);
    const grade = container.querySelector('.plot-grade')!;
    expect(grade.textContent).toContain('C');
    expect(grade.textContent).toContain('Analytical approximation');
    expectQuiet();
  });

  it('names the weakest grade, and how many models it was taken from', () => {
    act(() => useStore.setState({ sources: [ks('la-ks28', 0), ks('la-ks21', 1)] }));
    const { container } = render(<App />);
    expect(container.querySelector('.plot-grade')!.textContent).toContain('Analytical approximation, the weakest of 2 models');
    expectQuiet();
  });
});

describe('a held slider drops the map to Draft', () => {
  it('the frequency slider, until it is let go anywhere', () => {
    render(<App />);
    const slider = screen
      .getAllByRole('slider')
      .find((x) => x.getAttribute('min') === '20' && x.getAttribute('max') === '200')!;
    fireEvent.pointerDown(slider);
    expect(useStore.getState().interacting).toBe(true);
    fireEvent.pointerUp(window);
    expect(useStore.getState().interacting).toBe(false);
    expectQuiet();
  });
});

describe('the delay sheet', () => {
  const ks = (label: string, x: number) => makeSource('la-ks28', label, { x, y: 0, z: 0.3 });

  it('opens from the File menu, lists every cabinet and prints only itself', () => {
    act(() => useStore.setState({ sources: [ks('L', -2), { ...ks('R', 2), delayS: 0.0015, invertPolarity: true }] }));
    render(<App />);
    fireEvent.click(screen.getByText('File'));
    fireEvent.click(screen.getByText('Delay and position sheet…'));
    const preview = document.querySelector('.sheet-preview')!;
    const rows = preview.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[1].textContent).toContain('1.50');
    expect(rows[1].textContent).toContain('Ø');
    // the same sheet waits outside the application for the printer
    expect(document.querySelectorAll('body > .print-sheet-root tbody tr')).toHaveLength(2);

    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    fireEvent.click(screen.getByText('Print / PDF'));
    expect(print).toHaveBeenCalledTimes(1);
    expectQuiet();
  });

  it('keeps the author and the notes in the project', () => {
    act(() => useStore.setState({ sources: [ks('L', 0)] }));
    render(<App />);
    fireEvent.click(screen.getByText('File'));
    fireEvent.click(screen.getByText('Delay and position sheet…'));
    fireEvent.change(screen.getByPlaceholderText('Rigging, cabling, processor channels…'), {
      target: { value: 'Ch 1-8 on LA12X #1' },
    });
    expect(useStore.getState().project.notes).toBe('Ch 1-8 on LA12X #1');
    expect(document.querySelector('.sheet-preview .sheet-notes')!.textContent).toContain('LA12X');
    expectQuiet();
  });
});

describe('the colour controls are buttons', () => {
  it('sets palette, contour and window, and opens on an 18 dB window', () => {
    render(<App />);
    expect(useStore.getState().sim.dynamicRangeDb).toBe(18);
    const window18 = within(screen.getByRole('group', { name: 'Window' })).getByText('18dB');
    expect(window18.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(within(screen.getByRole('group', { name: 'Window' })).getByText('42dB'));
    expect(useStore.getState().sim.dynamicRangeDb).toBe(42);

    const contour = within(screen.getByRole('group', { name: 'Contour' }));
    expect(contour.getByText('0dB').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(contour.getByText('6dB'));
    expect(useStore.getState().sim.dbPerDivision).toBe(6);

    fireEvent.click(within(screen.getByRole('group', { name: 'Palette' })).getByText('Viridis'));
    expect(useStore.getState().palette).toBe('viridis');
    expectQuiet();
  });
});

describe('the top bar', () => {
  it('starts with undo and redo, and no longer offers Debug', () => {
    const { container } = render(<App />);
    const first = container.querySelector('.topbar')!.firstElementChild!;
    expect(within(first as HTMLElement).getByLabelText(/^Undo/)).toBeTruthy();
    expect(within(first as HTMLElement).getByLabelText(/^Redo/)).toBeTruthy();
    expect(screen.queryByTitle('Per-source contribution breakdown')).toBeNull();
    expectQuiet();
  });
});

describe('the Groups panel', () => {
  const groupOfTwo = () => {
    const a = makeSource('la-ks28', 'A', { x: 0, y: 0, z: 0.3 });
    const b = makeSource('la-ks28', 'B', { x: 1, y: 0, z: 0.3 });
    act(() => {
      useStore.setState({ sources: [a, b], selectedSourceIds: [a.id, b.id], showGroups: false });
      useStore.getState().groupSelected('ARRAY');
      useStore.setState({ selectedGroupId: null, showGroups: false });
    });
  };

  it('comes up from the top bar in the left column, and goes away again', () => {
    groupOfTwo();
    const { container } = render(<App />);
    expect(container.querySelector('.group-panel')).toBeNull();
    fireEvent.click(screen.getByTitle('Bring the Groups panel up in the left column'));
    const panel = container.querySelector('.left-col > .group-panel')!;
    expect(panel).toBeTruthy();
    // first in the column, above the sources
    expect(container.querySelector('.left-col')!.firstElementChild).toBe(panel);
    expect(panel.textContent).toContain('Pick a group');
    fireEvent.click(screen.getByTitle('Bring the Groups panel up in the left column'));
    expect(container.querySelector('.group-panel')).toBeNull();
    expectQuiet();
  });

  it('edits the group there, not in the right column', () => {
    groupOfTwo();
    const { container } = render(<App />);
    fireEvent.click(within(container.querySelector('.tree')!).getByText('ARRAY'));
    // picking the group brought the panel up
    const panel = container.querySelector('.left-col > .group-panel') as HTMLElement;
    expect(panel).toBeTruthy();
    expect(within(panel).getByText('Transform offset')).toBeTruthy();
    expect(within(container.querySelector('.right-col') as HTMLElement).queryByText('Transform offset')).toBeNull();
    expectQuiet();
  });

  it('says what to do when there are no groups', () => {
    act(() => useStore.setState({ showGroups: true }));
    const { container } = render(<App />);
    expect(container.querySelector('.group-panel')!.textContent).toContain('No groups yet');
    act(() => useStore.setState({ showGroups: false }));
    expectQuiet();
  });
});
