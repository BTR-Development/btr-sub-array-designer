// @vitest-environment jsdom
/**
 * Where the interface writes to the project without being asked.
 *
 * WHY THIS FILE EXISTS
 *
 * The September audit's interface findings are all of one shape: a control that
 * looks inert and is in fact an edit. The global shortcuts stayed live under an
 * open dialog, so the arrows walked the selection behind it. Alt-drag wrote
 * azimuth in the side view, where azimuth is not the angle on screen and nothing
 * moved to say so. A multi-selection printed 0 for every value its members
 * disagreed on, and the level slider sitting at that 0 flattened a taper on the
 * first click. None of them throws, none of them is visible in a screenshot, and
 * the existing suites all stayed green.
 *
 * So these tests drive the controls a person drives and then read the SOURCES,
 * never the component: what a user would see in the GPS table afterwards is the
 * only thing that settles whether the gesture did what it looked like.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from './App';
import { CanvasStage } from './CanvasStage';
import { Inspector } from './Inspector';
import { makeSource, useStore } from '../state/store';
import { worldToScreen } from '../render/view';
import { EN } from '../i18n';
import type { Group, Source } from '../core/types';

const st = () => useStore.getState();

/** KS28: published 1.34 x 0.55 x 0.719 m, so a click at its centre lands on it. */
const KS28 = 'la-ks28';

/**
 * Platform stubs only. jsdom has no layout, no canvas raster and no pointer
 * capture; it has everything else, and the moment a test stubs a module of ours
 * it stops being able to fail for the reasons above.
 */
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

  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  globalThis.URL.createObjectURL ??= () => 'blob:test';
  globalThis.URL.revokeObjectURL ??= () => undefined;
});

beforeEach(() => {
  st().newProject();
});

afterEach(cleanup);

/** Replace the project wholesale, then clear the history the setup created. */
function project(sources: Source[], groups: Group[] = [], select = sources.map((x) => x.id)) {
  act(() => {
    useStore.setState({
      sources,
      groups,
      selectedSourceIds: select,
      selectedGroupId: null,
      selectedPointId: null,
      undoStack: [],
      redoStack: [],
    });
  });
}

function sub(label: string, x: number, y: number, z = 0): Source {
  return makeSource(KS28, label, { x, y, z });
}

/**
 * A pointer event at a WORLD coordinate on the drawn plane.
 *
 * The canvas measures 800 x 600 in jsdom (its rect is all zeros, and the stage
 * keeps its last good size rather than fitting to nothing), and the rect's
 * origin is 0, so client coordinates are screen coordinates.
 */
function at(h: number, v: number) {
  const [x, y] = worldToScreen({ width: 800, height: 600, view: st().view }, h, v);
  return { clientX: x, clientY: y, pointerId: 1 };
}

// ─────────────────────────────────────────────────────────────── C9 ────
describe('an open dialog owns the keyboard', () => {
  /** Mount the app over a one-cabinet project and open the speaker picker. */
  function withDialog() {
    render(<App />);
    project([sub('S1', 0, 0)]);
    fireEvent.click(screen.getByText(EN['src.add']));
    expect(document.querySelector('.modal')).toBeTruthy();
  }

  it('does not let the arrow keys walk the selection behind it', () => {
    withDialog();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(st().sources[0].position.x).toBe(0);
  });

  it('does not let Cmd+D duplicate behind it', () => {
    withDialog();
    fireEvent.keyDown(window, { key: 'd', metaKey: true });
    expect(st().sources).toHaveLength(1);
  });

  it('does not let Backspace delete behind it', () => {
    // It used to raise a confirmation stacked on the dialog; since deleting
    // stopped asking the same keystroke would delete outright.
    withDialog();
    fireEvent.keyDown(window, { key: 'Backspace' });
    expect(st().sources).toHaveLength(1);
    expect(st().pendingConfirm).toBe(null);
  });

  it('still lets the arrow keys through with no dialog open', () => {
    // The control for the three above: without it they would also pass with the
    // shortcut handler deleted outright.
    render(<App />);
    project([sub('S1', 0, 0)]);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(st().sources[0].position.x).toBeGreaterThan(0);
  });

  it('keeps Tab inside the dialog', () => {
    withDialog();
    const panel = document.querySelector('.modal')!;
    const stops = Array.from(panel.querySelectorAll<HTMLElement>('button, input, select, textarea'));
    expect(stops.length).toBeGreaterThan(1);
    const first = stops[0];
    const last = stops[stops.length - 1];

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('puts focus inside a dialog that does not claim it itself', () => {
    // The array dialog has no autoFocus of its own, which is the case that
    // matters: without focus inside, Tab has nothing to cycle and the next
    // keystroke is aimed at the document behind the dialog.
    render(<App />);
    project([sub('S1', 0, 0)]);
    fireEvent.click(screen.getByText(EN['src.arrayDots']));
    const panel = document.querySelector('.modal')!;
    expect(panel.contains(document.activeElement)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────── C10 ────
describe('alt-drag rotates what the view can show being rotated', () => {
  /**
   * One cabinet at (0, 0, 2) already turned 30 degrees off axis, drawn in the
   * section and centred in the view. The heading is there to be left alone.
   */
  function sideOneCabinet() {
    act(() => {
      st().patchSim({ plane: 'side' });
      st().setView({ scale: 20, cx: 0, cy: 2 });
    });
    const s1 = sub('S1', 0, 0, 2);
    s1.rotation.azimuthDeg = 30;
    project([s1]);
  }

  /** A point at `deg` about that cabinet's centre, measured as elevation is. */
  function polar(deg: number, r: number): [number, number] {
    const a = (deg * Math.PI) / 180;
    return [r * Math.cos(a), 2 + r * Math.sin(a)];
  }

  it('tilts in the side view instead of rewriting the heading', () => {
    sideOneCabinet();
    const canvas = render(<CanvasStage result={null} />).container.querySelector('canvas')!;

    // Down on the cabinet's centre, so the start angle is the same in either
    // convention, then up and forward by equal amounts: 45 degrees of tilt.
    fireEvent.pointerDown(canvas, { ...at(0, 2), altKey: true });
    fireEvent.pointerMove(canvas, { ...at(1, 3), altKey: true });
    fireEvent.pointerUp(canvas, at(1, 3));

    const s1 = st().sources[0];
    expect(s1.rotation.elevationDeg).toBe(45);
    expect(s1.rotation.azimuthDeg).toBe(30);
  });

  it('holds elevation at the limit instead of folding the cabinet over', () => {
    sideOneCabinet();
    const canvas = render(<CanvasStage result={null} />).container.querySelector('canvas')!;

    // 100 degrees of drag: past vertical the front vector folds over, which is
    // a different heading rather than a steeper tilt.
    fireEvent.pointerDown(canvas, { ...at(0, 2), altKey: true });
    fireEvent.pointerMove(canvas, { ...at(...polar(100, 4)), altKey: true });
    fireEvent.pointerUp(canvas, at(...polar(100, 4)));

    expect(st().sources[0].rotation.elevationDeg).toBe(90);
  });

  it('reads a drag across the seam as the short way round', () => {
    // Down at 170 degrees about the cabinet's centre (still inside its
    // footprint) and up at -170: two atan2 readings either side of the seam,
    // 20 degrees apart, that subtract to -340 if the difference is not folded.
    // Unfolded, the clamp below then pins the cabinet at -90.
    sideOneCabinet();
    const canvas = render(<CanvasStage result={null} />).container.querySelector('canvas')!;

    fireEvent.pointerDown(canvas, { ...at(...polar(170, 0.3)), altKey: true });
    fireEvent.pointerMove(canvas, { ...at(...polar(-170, 4)), altKey: true });
    fireEvent.pointerUp(canvas, at(...polar(-170, 4)));

    expect(st().sources[0].rotation.elevationDeg).toBe(20);
  });

  it('pivots where the cabinets are drawn, not where they are stored', () => {
    // Two cabinets 2 m apart inside a group translated 10 m along X. Stored
    // centre (0, 0), drawn centre (10, 0) — and the pointer angle is measured in
    // world coordinates, so only the drawn one is the pivot the user sees.
    const a = sub('A', -1, 0);
    const b = sub('B', 1, 0);
    const g: Group = {
      id: 'grp1',
      name: 'BLOCK',
      offset: { x: 10, y: 0, z: 0 },
      rotationOffsetDeg: 0,
      anchor: { x: 0, y: 0, z: 0 },
      levelOffsetDb: 0,
      delayOffsetS: 0,
      mute: false,
    };
    a.groupId = g.id;
    b.groupId = g.id;
    act(() => st().setView({ scale: 20, cx: 10, cy: 0 }));
    project([a, b], [g]);

    const canvas = render(<CanvasStage result={null} />).container.querySelector('canvas')!;
    // Down on B, drawn at (11, 0): 90 degrees round from the drawn centre.
    fireEvent.pointerDown(canvas, { ...at(11, 0), altKey: true });
    // Up to due north of it: the pointer has swung a quarter turn about (10, 0),
    // and only 5.7 degrees about (0, 0).
    fireEvent.pointerMove(canvas, { ...at(10, 1), altKey: true });
    fireEvent.pointerUp(canvas, at(10, 1));

    expect(st().sources.map((x) => x.rotation.azimuthDeg)).toEqual([-90, -90]);
  });
});

// ─────────────────────────────────────────────────────── D1 and C11 ────
describe('a multi-selection reports what it actually knows', () => {
  function fanned() {
    const a = sub('A', 0, 0);
    const b = sub('B', 1, 0);
    a.rotation.azimuthDeg = 10;
    b.rotation.azimuthDeg = 40;
    a.levelDb = 0;
    b.levelDb = -6;
    project([a, b]);
    render(<Inspector />);
  }

  it('leaves a mixed angle blank rather than printing 0', () => {
    fanned();
    const az = screen.getByLabelText(/Azimuth/) as HTMLInputElement;
    expect(az.value).toBe('');
    expect(az.placeholder).toBe('-');
  });

  it('leaves a mixed coordinate blank rather than showing the first cabinet', () => {
    fanned();
    expect((screen.getByLabelText(/^X/) as HTMLInputElement).value).toBe('');
    // Y is the same for both, so it still reads as the number it is.
    expect((screen.getByLabelText(/^Y/) as HTMLInputElement).value).toBe('0');
  });

  it('stays blank when the field is visited and left alone', () => {
    fanned();
    const az = screen.getByLabelText(/Azimuth/) as HTMLInputElement;
    fireEvent.focus(az);
    fireEvent.blur(az);
    expect(az.value).toBe('');
    expect(st().sources.map((x) => x.rotation.azimuthDeg)).toEqual([10, 40]);
  });

  it('still writes one typed angle to the whole selection', () => {
    fanned();
    // typed and then left, which is when a NumField commits
    const az = screen.getByLabelText(/Azimuth/);
    fireEvent.change(az, { target: { value: '25' } });
    fireEvent.blur(az);
    expect(st().sources.map((x) => x.rotation.azimuthDeg)).toEqual([25, 25]);
  });

  it('agrees with itself when the selection agrees', () => {
    const a = sub('A', 0, 0);
    const b = sub('B', 1, 0);
    a.rotation.azimuthDeg = 15;
    b.rotation.azimuthDeg = 15;
    project([a, b]);
    render(<Inspector />);
    expect((screen.getByLabelText(/Azimuth/) as HTMLInputElement).value).toBe('15');
  });

  it('will not let the level slider flatten a taper it cannot show', () => {
    fanned();
    const slider = document.querySelector<HTMLInputElement>('.inspector input.slider')!;
    expect(slider.disabled).toBe(true);
    expect(st().sources.map((x) => x.levelDb)).toEqual([0, -6]);
  });
});

describe('the level slider under the keyboard', () => {
  it('leaves an undo entry when driven by the arrow keys', () => {
    project([sub('S1', 0, 0)]);
    render(<Inspector />);
    const slider = document.querySelector<HTMLInputElement>('.inspector input.slider')!;

    // What a browser does with one press of Right on a focused range input.
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.change(slider, { target: { value: '-3' } });
    expect(st().sources[0].levelDb).toBe(-3);

    expect(st().undoStack).toHaveLength(1);
    act(() => st().undo());
    expect(st().sources[0].levelDb).toBe(0);
  });
});

describe('the empty-canvas overlay', () => {
  it('appears only when the project really is empty', () => {
    render(<App />);
    act(() => st().newProject());
    expect(screen.queryByText(EN['plot.emptyTitle'])).toBeTruthy();

    // Muting everything also leaves the solver with nothing, but the cabinets
    // are still drawn and "add a subwoofer" is then the wrong advice.
    const muted = sub('S1', 0, 0);
    muted.mute = true;
    project([muted]);
    expect(screen.queryByText(EN['plot.emptyTitle'])).toBe(null);
  });
});
