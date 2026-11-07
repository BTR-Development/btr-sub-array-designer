// @vitest-environment jsdom
/**
 * The SUBS panel's wiring.
 *
 * WHY THIS FILE EXISTS
 *
 * `engine/steering.ts` and `state/arrayModule.ts` are each well covered, and the
 * sharpest defect in this panel lived between them: the tilt tool handed a
 * DOWN-positive angle to a field whose positive is up, so a flown column was
 * steered 21.7 degrees the wrong way. Both halves had a test, both tests were
 * right about their own function, and nothing tested the seam.
 *
 * So these tests drive the controls a person drives and then look at the
 * cabinets in the project, which is the only place the two conventions actually
 * meet. Everything asserted here is a coordinate or a delay a user would read
 * off the GPS table, never an internal of the component.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SteeringPanel } from './SteeringPanel';
import { makeSource, useStore } from '../state/store';
import { EN } from '../i18n';
import type { SpeakerModel } from '../speakers/schema';
import { analyticCardioidDataset } from '../speakers/schema';

const st = () => useStore.getState();

/** KS28: 1.34 x 0.55 x 0.719 m, manufacturer published. */
const KS28 = 'la-ks28';
const KS28_H = 0.55;

/** What a vendor import leaves behind: a cabinet with no confirmed dimensions. */
const NO_DIMS: SpeakerModel = {
  id: 'ph-no-dimensions',
  manufacturer: 'Unknown',
  model: 'IMPORTED SUB',
  dimensions: { widthM: null, heightM: null, depthM: null },
  type: 'other',
  maxSpl: null,
  predictionData: { kind: 'omni' },
  dataQuality: 'D',
  isCustom: true,
};

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  st().newProject();
  useStore.setState({ undoStack: [], redoStack: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The control that follows a label, which is how every row in the panel reads. */
/**
 * Type a number into a NumField the way a person does: the keystrokes, then
 * leaving the field. The field commits on Enter and on blur, not on each
 * keystroke, so a bare `fireEvent.change` sets the text and writes nothing -
 * which is the behaviour, not a quirk of the harness.
 */
function typeNumber(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

function fieldFor(label: string): HTMLInputElement {
  const found = screen.getByText(label).nextElementSibling;
  const input = found?.querySelector('input') ?? found;
  return input as HTMLInputElement;
}

function selectFor(label: string): HTMLSelectElement {
  return screen.getByText(label).nextElementSibling as HTMLSelectElement;
}

function click(label: string) {
  fireEvent.click(screen.getByText(label));
}

/** The "More steering" disclosure, whose caret makes it two text nodes. */
function openMore() {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(EN['subs.more']) }));
}

/** A flown column of `count` cabinets, pitch = cabinet height, as one module. */
function column(count: number, speakerId = KS28) {
  const gid = st().createSubArray({ speakerId, count, spacingM: KS28_H, axis: 'z' });
  useStore.setState({ undoStack: [], redoStack: [] });
  return gid;
}

describe('the tilt tool aims the column at the target', () => {
  // The panel's own worked example, written out rather than taken from the
  // function under test: 6 cabinets of 0.55 m with their top face at 9 m put the
  // acoustic centre at 9 - 1.65 = 7.35 m, and a listener 1.6 m up at 30 m is
  // atan(5.75 / 30) = 10.86 degrees BELOW it.
  const TILT_DEG = (Math.atan((9 - (6 * KS28_H) / 2 - 1.6) / 30) * 180) / Math.PI;

  it('delays the bottom of the column, which is what tips the beam down', () => {
    column(6);
    render(<SteeringPanel />);
    openMore();
    fireEvent.change(selectFor(EN['subs.mode']), { target: { value: 'steer' } });

    click(EN['subs.useAsAim']);
    click(EN['subs.applyDelay']);

    const cabinets = [...st().sources].sort((a, b) => b.position.z - a.position.z);
    const step = (KS28_H * Math.sin((TILT_DEG * Math.PI) / 180)) / st().sim.speedOfSound;

    // Top cabinet first, every one below it later by one element's worth of
    // tilt. Handing the down-tilt straight to the steering field inverted this
    // and aimed the rig into the roof.
    expect(cabinets[0].delayS).toBeCloseTo(0, 12);
    for (let i = 1; i < cabinets.length; i++) {
      expect(cabinets[i].delayS - cabinets[i - 1].delayS).toBeCloseTo(step, 9);
    }
  });

  it('still reports the angle as a down-tilt on screen', () => {
    column(6);
    render(<SteeringPanel />);
    openMore();
    expect(screen.getByText(new RegExp(`down-tilt ${TILT_DEG.toFixed(2)}`))).toBeTruthy();
  });

  it('is not offered at all when the cabinet height is unconfirmed', () => {
    // The tool IS the column's height turned into an angle. It used to stand in
    // 0.6 m and aim a rig off a box nobody measured; now it degrades the way the
    // stack controls do, and the row above says why.
    st().addCustomSpeaker(NO_DIMS);
    column(6, NO_DIMS.id);
    render(<SteeringPanel />);
    openMore();

    expect(screen.queryByText(EN['subs.arrayTop'])).toBeNull();
    expect(screen.queryByText(EN['subs.useAsAim'])).toBeNull();
    expect(screen.getByText(EN['subs.stackNoHeight'])).toBeTruthy();
  });
});

describe('live steering is a preview of the taper and nothing else', () => {
  /** Four loose cabinets along X: a module, but not yet a group. */
  function looseLine() {
    const sources = [0, 1, 2, 3].map((i) =>
      makeSource(KS28, `SUB 0${i + 1}`, { x: -2.25 + i * 1.5, y: 0, z: KS28_H / 2 }),
    );
    useStore.setState({ sources, groups: [], selectedGroupId: null, undoStack: [], redoStack: [] });
  }

  /** Drag the beam-width slider to `deg` and let the re-solve settle. */
  function dragBeamWidth(deg: number) {
    fireEvent.change(screen.getByRole<HTMLInputElement>('slider', { name: EN['subs.dispersion'] }), {
      target: { value: String(deg) },
    });
    act(() => vi.advanceTimersByTime(200));
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('keeps layout edits that were typed and not applied yet', () => {
    // The slider sits next to a live readout and reads as exploration. It used
    // to gather the cabinets into a group, which re-points the editor at a new
    // module and drops every pending field — six typed positions, gone, with the
    // count snapping back under the cursor.
    looseLine();
    render(<SteeringPanel />);
    fireEvent.change(fieldFor(EN['subs.positions']), { target: { value: '6' } });

    dragBeamWidth(60);

    expect(fieldFor(EN['subs.positions']).value).toBe('6');
    expect(st().groups).toHaveLength(0);
    expect(st().sources).toHaveLength(4); // and the layout is still unapplied
    // the taper itself did reach the cabinets
    expect(st().sources.some((x) => x.delayS > 0)).toBe(true);
  });

  it('makes one undo entry for the drag, not one per settling point', () => {
    looseLine();
    render(<SteeringPanel />);

    dragBeamWidth(60);
    expect(st().undoStack).toHaveLength(1);

    dragBeamWidth(50);
    dragBeamWidth(40);
    expect(st().undoStack).toHaveLength(1);

    // and one undo returns the cabinets to the taper they had before the drag
    act(() => st().undo());
    expect(st().sources.every((x) => x.delayS === 0)).toBe(true);
  });
});

describe('what the panel reports about the array it is pointed at', () => {
  /** Four cabinets along X at 1.5 m, each aimed where the operator put it. */
  function line(azimuths: number[], elevations: number[]) {
    const sources = azimuths.map((az, i) => ({
      ...makeSource(KS28, `SUB 0${i + 1}`, { x: -2.25 + i * 1.5, y: 0, z: KS28_H / 2 }),
      rotation: { azimuthDeg: az, elevationDeg: elevations[i], rollDeg: 0 },
    }));
    useStore.setState({ sources, groups: [], selectedGroupId: null, undoStack: [], redoStack: [] });
  }

  it('quotes the pattern-control limit of the array, not of an unapplied arc', () => {
    // Grating lobes at c / d, which is 229 Hz for these cabinets at 20 degrees.
    // The editor opens holding an 80 degree arc that nothing has applied, and
    // quoting the limit against that reported 139 Hz — a number an operator
    // would go and set a crossover from.
    line([0, 0, 0, 0], [0, 0, 0, 0]);
    render(<SteeringPanel />);
    const c = st().sim.speedOfSound;
    expect(screen.getByText(`${(c / 1.5).toFixed(0)} Hz`)).toBeTruthy();

    // Once an arc IS being dialled in, the readout follows it: half of a 60
    // degree fan is 30 degrees off axis, so c / (d * (1 + sin 30)) = 153 Hz.
    fireEvent.change(screen.getByRole<HTMLInputElement>('slider', { name: EN['subs.dispersion'] }), {
      target: { value: '60' },
    });
    expect(screen.getByText(`${(c / (1.5 * 1.5)).toFixed(0)} Hz`)).toBeTruthy();
  });

  it('reads the fan off a block that is visibly fanned', () => {
    line([-15, -5, 5, 15], [0, 0, 0, 0]);
    render(<SteeringPanel />);
    openMore();
    expect(fieldFor(EN['subs.splay']).value).toBe('30');
  });

  it('applies a layout without flattening tilts that were set one by one', () => {
    // Apply layout moves cabinets. It is not a statement about where they point,
    // and it used to level the whole module off to the first cabinet's angle.
    line([0, 0, 0, 0], [-1, -2, -3, -4]);
    render(<SteeringPanel />);
    click(EN['subs.applyLayout']);

    const tilts = [...st().sources]
      .sort((a, b) => a.position.x - b.position.x)
      .map((x) => x.rotation.elevationDeg);
    expect(tilts).toEqual([-1, -2, -3, -4]);
  });
});

describe('the level column stays the operator’s until a taper is asked for', () => {
  /** Four loose cabinets with the outer pair trimmed 6 dB by hand. */
  function trimmedLine() {
    const sources = [0, 1, 2, 3].map((i) => ({
      ...makeSource(KS28, `SUB 0${i + 1}`, { x: -2.25 + i * 1.5, y: 0, z: KS28_H / 2 }),
      levelDb: i === 0 || i === 3 ? -6 : 0,
    }));
    useStore.setState({ sources, groups: [], selectedGroupId: null, undoStack: [], redoStack: [] });
  }

  /** The level column as the GPS table lists it, left to right. */
  const levels = () =>
    [...st().sources].sort((a, b) => a.position.x - b.position.x).map((x) => x.levelDb);

  it('survives an Apply delay with the taper control untouched', () => {
    // The edge taper OWNS the level column: it overwrites every cabinet, which
    // is how setting it back to 0 takes it off again. Held as a plain number the
    // control could not tell "no taper" from "flatten the taper", it starts at
    // 0, and so every apply wrote 0 dB over levels that were set by hand.
    trimmedLine();
    render(<SteeringPanel />);

    click(EN['subs.applyDelay']);

    expect(levels()).toEqual([-6, 0, 0, -6]);
    expect(st().sources.some((x) => x.delayS !== 0)).toBe(true); // the plan did land
  });

  it('survives a live re-steer, which writes the same plan on a timer', () => {
    vi.useFakeTimers();
    trimmedLine();
    render(<SteeringPanel />);

    fireEvent.change(screen.getByRole<HTMLInputElement>('slider', { name: EN['subs.dispersion'] }), {
      target: { value: '60' },
    });
    act(() => vi.advanceTimersByTime(200));

    expect(levels()).toEqual([-6, 0, 0, -6]);
    expect(st().sources.some((x) => x.delayS !== 0)).toBe(true);
  });

  it('is taken over by a taper that is typed, and released flat when it is typed back to 0', () => {
    // 0 dB at the edge is how an operator removes a taper, so a typed 0 has to
    // reach the cabinets. This is the direction the fix above must not break:
    // the silence is the untouched control, not the number 0.
    trimmedLine();
    render(<SteeringPanel />);
    openMore();

    typeNumber(fieldFor(EN['subs.edgeTaper']), '-6');
    click(EN['subs.applyDelay']);

    // a symmetric taper, ends at the edge value and the inner pair above it
    const tapered = levels();
    expect([tapered[0], tapered[3]]).toEqual([-6, -6]);
    expect(tapered[1]).toBeCloseTo(tapered[2], 9);
    expect(tapered[1]).toBeGreaterThan(-6);
    expect(tapered[1]).toBeLessThan(0);

    typeNumber(fieldFor(EN['subs.edgeTaper']), '0');
    click(EN['subs.applyDelay']);

    expect(levels()).toEqual([0, 0, 0, 0]);
  });
});

/**
 * The shape of the form, not its wiring.
 *
 * These three are the only part of the 1:1 restructure that jsdom can see.
 * It performs no layout — every rect is zero and every computed width is
 * empty — so the alignment cannot be asserted here at
 * all, and a test that tried would compare 0 with 0 and pass with the whole
 * change reverted. What jsdom does see is how many controls a row carries,
 * where a control lives, and whether the readouts are one element or five,
 * and each of those is exactly what the restructure changed.
 */
describe('the form keeps its fixed slots', () => {
  /** A 2x2 KS28 block: canRoll, canStack, canTouch and canReverse all hold. */
  function block() {
    st().createSubArray({ speakerId: KS28, count: 2, spacingM: 1.34, axis: 'x' });
    useStore.setState({ undoStack: [], redoStack: [] });
  }

  /** Which line of the form an element sits on, counting from the top. */
  function lineOf(root: HTMLElement, el: Element): number {
    const lines = [...root.querySelectorAll('.steer-grid section > *')];
    return lines.findIndex((l) => l === el || l.contains(el));
  }

  it('never puts more than two label/control pairs on a line', () => {
    block();
    const { container } = render(<SteeringPanel />);
    openMore();

    const rows = [...container.querySelectorAll('.steer-row')];
    expect(rows.length).toBeGreaterThan(6);
    for (const row of rows) {
      // Four grid tracks hold two pairs. A third pair wraps, and where it
      // wraps to depends on the panel's width - which is the jumping the
      // fixed slots exist to stop.
      expect(row.querySelectorAll(':scope > label').length).toBeLessThanOrEqual(2);
      expect(row.children.length).toBeLessThanOrEqual(4);
    }
  });

  it('gives Mounting one home, whichever way the rig is built', () => {
    // A vertical column and a horizontal stack are the two branches that each
    // used to render their own Mounting control, several lines apart.
    column(4);
    const vertical = render(<SteeringPanel />);
    const vMatches = vertical.container.querySelectorAll('.steer-row > label');
    const vLabel = [...vMatches].filter((l) => l.textContent === EN['subs.mounting']);
    expect(vLabel).toHaveLength(1);
    const vLine = lineOf(vertical.container, vLabel[0]);
    cleanup();

    st().newProject();
    block();
    st().patchSources(
      st().sources.map((x) => x.id),
      {},
    );
    const horizontal = render(<SteeringPanel />);
    typeNumber(fieldFor(EN['subs.perPosition']), '2');
    const hLabel = [...horizontal.container.querySelectorAll('.steer-row > label')].filter(
      (l) => l.textContent === EN['subs.mounting'],
    );
    expect(hLabel).toHaveLength(1);

    // The count alone proves nothing - the two branches were already
    // exclusive. That it is the SAME line in both is what says the control
    // stopped moving.
    expect(lineOf(horizontal.container, hLabel[0])).toBe(vLine);
  });

  it('says what it has to say in one strip, not five rows', () => {
    // A reversed block: the gradient ceiling has something to say AND so does
    // the footprint, which is two advisories at once. Five separate rows is
    // what this replaced, and most of them were empty most of the time.
    st().createSubArray({ speakerId: KS28, count: 4, spacingM: 1.34, axis: 'x' });
    const last = [...st().sources].sort((a, b) => a.position.x - b.position.x).pop()!;
    st().patchSources([last.id], {
      rotation: { azimuthDeg: 180 },
      invertPolarity: true,
    });
    useStore.setState({ undoStack: [], redoStack: [] });

    const { container } = render(<SteeringPanel />);

    const notes = container.querySelectorAll('.steer-notes');
    expect(notes).toHaveLength(1);
    expect(notes[0].children.length).toBeGreaterThanOrEqual(2);
    // and no advisory is left outside it as a row of its own
    expect(container.querySelectorAll('.steer-row > .steer-readout')).toHaveLength(1);
  });

  it('quotes the 3 + 1 ceiling only for a cabinet that really is a point source', () => {
    // The ceiling is arithmetic for omnidirectional boxes. A cabinet with its own
    // front-to-back response can go past it, so the text would be false there.
    const DIRECTIONAL = 'directional-sub';
    const ceilingShown = (speakerId: string) => {
      st().newProject();
      if (speakerId === DIRECTIONAL) {
        const base = st().provider.get(KS28)!;
        st().addCustomSpeaker({ ...base, id: DIRECTIONAL, predictionData: analyticCardioidDataset(0.719) });
      }
      st().createSubArray({ speakerId, count: 2, spacingM: 3, axis: 'x' });
      const h = st().provider.get(speakerId)!.dimensions.heightM!;
      st().applyArrayLayout(st().sources.map((x) => x.id), {
        count: 2, spacingM: 3, axis: 'x', centreM: 0, cross: { y: 0, z: 2 * h },
        perPosition: 4, stackPitchM: h, acrossM: 0, rollDeg: 0,
        reversePattern: [false, false, false, true], forwardAzimuthDeg: 0,
        reverseDelayS: 0.6 / st().sim.speedOfSound,
      });
      useStore.setState({ undoStack: [], redoStack: [] });
      const { container, unmount } = render(<SteeringPanel />);
      const shown = /cannot exceed/.test(container.textContent ?? '');
      unmount();
      return shown;
    };
    expect(ceilingShown(DIRECTIONAL)).toBe(false);
    expect(ceilingShown(KS28)).toBe(true);
  });

  /**
   * A GUARD, not a revert-detector: it passes before this change as well as
   * after, and is here only so that a later tidy-up cannot collapse the two
   * Z fields into one slot. They are different coordinates - one is where the
   * column stands across the layout axis, the other is the face its height is
   * measured from - and a single field would silently drop one of them.
   */
  it('keeps the cross-axis position and the rig height as two numbers', () => {
    column(4);
    render(<SteeringPanel />);

    typeNumber(fieldFor(EN['subs.stackDeckZ']), '2.5');
    typeNumber(fieldFor(EN['subs.position'].replace('{axis}', 'Y')), '-3');
    click(EN['subs.applyLayout']);

    // The field places the bottom FACE; a position is a cabinet's centre.
    const zs = st().sources.map((x) => x.position.z);
    expect(Math.min(...zs)).toBeCloseTo(2.5 + KS28_H / 2, 6);
    expect(st().sources.every((x) => Math.abs(x.position.y + 3) < 1e-9)).toBe(true);
  });
});

describe('the live spacing slider', () => {
  function lineOfTwo() {
    st().createSubArray({ speakerId: KS28, count: 2, spacingM: 2, axis: 'x' });
    useStore.setState({ undoStack: [], redoStack: [] });
  }

  const slider = () =>
    screen.getByRole<HTMLInputElement>('slider', { name: EN['subs.spacing'] });
  const xs = () => st().sources.map((x) => x.position.x).sort((a, b) => a - b);

  it('writes the geometry as it moves, with no Apply pressed', () => {
    lineOfTwo();
    render(<SteeringPanel />);

    fireEvent.change(slider(), { target: { value: '3' } });
    expect(xs()[1] - xs()[0]).toBeCloseTo(3, 6);

    fireEvent.change(slider(), { target: { value: '5.5' } });
    expect(xs()[1] - xs()[0]).toBeCloseTo(5.5, 6);
  });

  it('one drag is one undo entry, however many values it passes through', () => {
    lineOfTwo();
    render(<SteeringPanel />);

    fireEvent.change(slider(), { target: { value: '3' } });
    fireEvent.change(slider(), { target: { value: '4' } });
    fireEvent.change(slider(), { target: { value: '6' } });
    expect(st().undoStack.length).toBe(1);

    // the gesture ends; the next touch is its own entry
    fireEvent.pointerUp(slider());
    fireEvent.change(slider(), { target: { value: '2' } });
    expect(st().undoStack.length).toBe(2);

    // and undoing the second gesture lands on the END of the first, 6 m,
    // not on one of the values the drag passed through
    st().undo();
    expect(xs()[1] - xs()[0]).toBeCloseTo(6, 6);
  });
});

describe('the two resets', () => {
  /** A gradient cardioid pair: front box, and a reversed one with its d/c. */
  function cardioidPair() {
    st().createSubArray({ speakerId: KS28, count: 2, spacingM: 1.4, axis: 'x' });
    const [, rear] = [...st().sources].sort((a, b) => a.position.x - b.position.x);
    const dOverC = 0.719 / st().sim.speedOfSound;
    st().patchSources([rear.id], {
      rotation: { azimuthDeg: 180 },
      invertPolarity: true,
      delayS: dOverC,
      levelDb: -3,
    });
    useStore.setState({ undoStack: [], redoStack: [] });
    return { rearId: rear.id, dOverC };
  }

  it('Reset level + delays keeps the cardioid: the reversed box keeps its d/c', () => {
    const { rearId, dOverC } = cardioidPair();
    render(<SteeringPanel />);

    click(EN['subs.resetLevelDelay']);

    const rear = st().sources.find((x) => x.id === rearId)!;
    const front = st().sources.find((x) => x.id !== rearId)!;
    // levels and the steering taper are gone...
    expect(front.levelDb).toBe(0);
    expect(rear.levelDb).toBe(0);
    expect(front.delayS).toBe(0);
    expect(rear.delayS).toBe(0);
    // ...but the gradient is CONFIGURATION, not steering. It lives in the
    // hidden field now — a hand-built pair carrying d/c in the user column
    // gets it MIGRATED there by the reset instead of losing the cardioid.
    expect(rear.gradientDelayS).toBeCloseTo(dOverC, 9);
    expect(front.gradientDelayS ?? 0).toBe(0);
    expect(rear.invertPolarity).toBe(true);
    expect(rear.rotation.azimuthDeg).toBe(180);
  });

  it('Reset all takes the module offset with it', () => {
    cardioidPair();
    render(<SteeringPanel />);
    // the module's common Delay (rel.) — typed through its own field
    typeNumber(fieldFor(EN['subs.relDelay']), '5');
    expect((st().groups[0]?.delayOffsetS ?? 0) * 1000).toBeCloseTo(5, 6);

    click(EN['subs.resetAll']);

    expect(st().groups[0]?.delayOffsetS ?? 0).toBe(0);
    for (const x of st().sources) {
      expect(x.delayS).toBe(0);
      expect(x.invertPolarity).toBe(false);
      expect(x.rotation.azimuthDeg).toBe(0);
    }
  });
});

describe('the hidden gradient, end to end', () => {
  /**
   * A reported case: an on-end ROW with an F/B pattern — Apply delay used
   * to rewrite the column with the bare arc (the coordinate partner test found
   * nobody beside the reversed box) and the cardioid died looking tidy.
   */
  function rowFB() {
    st().createSubArray({ speakerId: KS28, count: 2, spacingM: 4, axis: 'x' });
    const ids = st().sources.map((x) => x.id);
    st().applyArrayLayout(ids, {
      count: 2,
      spacingM: 4,
      axis: 'x',
      centreM: 0,
      cross: { y: 0, z: KS28_H / 2 },
      perPosition: 2,
      stackPitchM: 0.555,
      acrossM: 0.555,
      rollDeg: 90,
      reversePattern: [false, true],
      forwardAzimuthDeg: 0,
      reverseDelayS: 0.719 / st().sim.speedOfSound,
    });
    useStore.setState({ undoStack: [], redoStack: [] });
  }

  it('Apply delay leaves the user column equal and the cardioid armed', () => {
    rowFB();
    render(<SteeringPanel />);

    typeNumber(fieldFor(EN['subs.dispersion']), '90');
    click(EN['subs.applyDelay']);

    const dOverC = 0.719 / st().sim.speedOfSound;
    const byX = [...st().sources].sort((a, b) => a.position.x - b.position.x);
    const [f1, b1] = byX.slice(0, 2);
    // the visible delay of the reversed box IS the forward box's — the arc
    // time of their shared position...
    expect(b1.invertPolarity).toBe(true);
    expect(b1.delayS).toBeCloseTo(f1.delayS, 9);
    // ...and the gradient sits underneath, out of the user's reach
    expect(b1.gradientDelayS).toBeCloseTo(dOverC, 9);
    expect(f1.gradientDelayS ?? 0).toBe(0);
  });

  it('Apply delay MIGRATES a hand-built gradient out of the user column', () => {
    // A legacy rig: the reversed box carries its d/c in delayS and has no
    // hidden field — every project saved before the field existed, and every
    // pair someone built by hand in the table. One Apply delay used to be the
    // moment such a rig lost its cardioid; now it is the moment the gradient
    // moves to safety.
    st().createSubArray({ speakerId: KS28, count: 2, spacingM: 1.4, axis: 'x' });
    const [front0, rear] = [...st().sources].sort((a, b) => a.position.x - b.position.x);
    const dOverC = 0.719 / st().sim.speedOfSound;
    // ręcznie zsunięty STOS: obudowa przeciągnięta NA drugą (współrzędna
    // z przednią, piętro wyżej), obrócona, odwrócona, z d/c wpisanym w delay
    st().patchSources([rear.id], {
      position: { x: front0.position.x, y: front0.position.y, z: front0.position.z + 0.555 },
      rotation: { azimuthDeg: 180 },
      invertPolarity: true,
      delayS: dOverC,
    });
    useStore.setState({ undoStack: [], redoStack: [] });
    render(<SteeringPanel />);

    click(EN['subs.applyDelay']);

    const again = st().sources.find((x) => x.id === rear.id)!;
    expect(again.gradientDelayS).toBeCloseTo(dOverC, 9);
    // the user column now carries the plan alone — no d/c folded in
    const front = st().sources.find((x) => x.id !== rear.id)!;
    expect(again.delayS).toBeCloseTo(front.delayS, 9);
  });

  it('editing the delay cell cannot disarm the cardioid', () => {
    rowFB();
    const rear = st().sources.find((x) => x.invertPolarity)!;
    const dOverC = rear.gradientDelayS!;
    st().patchSources([rear.id], { delayS: 0.004 });
    const again = st().sources.find((x) => x.id === rear.id)!;
    expect(again.gradientDelayS).toBeCloseTo(dOverC, 12);
    expect(again.delayS).toBeCloseTo(0.004, 12);
  });
});

describe('changing what a position IS does not move the positions', () => {
  it('turning the cabinets on end keeps the centre-to-centre spacing', () => {
    // A reported case, measured: 6 x 4 KS28, "On end" squeezed the pitch
    // from 0.86 to 0.69 m against 2.20 m per position, and neighbouring
    // positions' cabinets ended up interleaved. The outer width was being held
    // even though nobody had typed one.
    st().createSubArray({ speakerId: KS28, count: 3, spacingM: 4, axis: 'x' });
    useStore.setState({ undoStack: [], redoStack: [] });
    render(<SteeringPanel />);
    typeNumber(fieldFor(EN['subs.perPosition']), '4');
    click(EN['subs.applyLayout']);

    const centres = () => {
      const xs = [...new Set(st().sources.map((x) => Math.round(x.position.x * 1000)))];
      return xs.length;
    };
    expect(centres()).toBe(3); // three stacks, one X each

    fireEvent.click(screen.getByText(EN['subs.orientOnEnd']));
    click(EN['subs.applyLayout']);

    // three rows of four, each row 4 x 0.55 m wide, CENTRES still 4 m apart
    const byKey = new Map<string, number[]>();
    for (const x of st().sources) {
      const k = x.positionKey!;
      byKey.set(k, [...(byKey.get(k) ?? []), x.position.x]);
    }
    const rowCentres = [...byKey.values()]
      .map((xs) => (Math.min(...xs) + Math.max(...xs)) / 2)
      .sort((a, b) => a - b);
    expect(rowCentres).toHaveLength(3);
    expect(rowCentres[1] - rowCentres[0]).toBeCloseTo(4, 6);
    expect(rowCentres[2] - rowCentres[1]).toBeCloseTo(4, 6);
    // and no cabinet of one row stands inside another row
    const spans = [...byKey.values()].map((xs) => [Math.min(...xs), Math.max(...xs)]);
    spans.sort((a, b) => a[0] - b[0]);
    expect(spans[1][0]).toBeGreaterThan(spans[0][1]);
    expect(spans[2][0]).toBeGreaterThan(spans[1][1]);
  });
});

describe('the F/B pattern acts at once', () => {
  /** 2 positions x 4 on-end KS28, keyed, all forward. */
  function rows() {
    st().createSubArray({ speakerId: KS28, count: 2, spacingM: 4, axis: 'x' });
    useStore.setState({ undoStack: [], redoStack: [] });
    render(<SteeringPanel />);
    typeNumber(fieldFor(EN['subs.perPosition']), '4');
    click(EN['subs.applyLayout']);
    fireEvent.click(screen.getByText(EN['subs.orientOnEnd']));
    click(EN['subs.applyLayout']);
    useStore.setState({ undoStack: [], redoStack: [] });
  }
  const patternButtons = () =>
    [...document.querySelectorAll<HTMLButtonElement>('.rev-pattern button')];
  /** each position read left to right, as F/B; positions left to right too */
  const read = () => {
    const byKey = new Map<string, Array<{ x: number; b: boolean }>>();
    for (const x of st().sources) {
      byKey.set(x.positionKey!, [
        ...(byKey.get(x.positionKey!) ?? []),
        { x: x.position.x, b: x.invertPolarity },
      ]);
    }
    return [...byKey.values()]
      .sort((p, q) => p[0].x - q[0].x)
      .map((r) => r.sort((a, b) => a.x - b.x).map((c) => (c.b ? 'B' : 'F')).join(''));
  };
  const positionsOf = () => st().sources.map((x) => ({ ...x.position }));

  it('one click changes the cabinets, and nothing moves', () => {
    rows();
    const before = positionsOf();

    fireEvent.click(patternButtons()[2]);

    // no Apply pressed: the rig already says F F B F on the left and, mirrored
    // about the array centre, F B F F on the right
    expect(read()).toEqual(['FFBF', 'FBFF']);
    // and not a millimetre of geometry changed — position, height, spacing
    expect(positionsOf()).toEqual(before);
    // the reversed box carries the hidden gradient, the user column stays 0
    const rev = st().sources.filter((x) => x.invertPolarity);
    expect(rev).toHaveLength(2);
    for (const r of rev) {
      expect(r.gradientDelayS).toBeGreaterThan(0);
      expect(r.delayS).toBe(0);
      expect(Math.abs(r.rotation.azimuthDeg)).toBe(180);
    }
    // one click, one undo entry
    expect(st().undoStack.length).toBe(1);

    // and back: F F F F straightens it, gradient off
    fireEvent.click(patternButtons()[2]);
    expect(read()).toEqual(['FFFF', 'FFFF']);
    expect(st().sources.every((x) => !x.gradientDelayS && x.rotation.azimuthDeg === 0)).toBe(true);
    expect(positionsOf()).toEqual(before);
  });

  it('the last forward cabinet is locked, visibly, instead of ignoring the click', () => {
    rows();
    for (const i of [0, 1, 2]) fireEvent.click(patternButtons()[i]);
    expect(read()).toEqual(['BBBF', 'FBBB']);
    const last = patternButtons()[3];
    expect(last.disabled).toBe(true);
    expect(last.title).toBe(EN['subs.revLastFront']);
  });
});

describe('a single cabinet turned on end stays on the deck', () => {
  it('the exact path that sank a rig to −0.3775 m', () => {
    // On end with ONE cabinet per position, then the model, then four per
    // position. The cabinet used to turn about its own centre in step one —
    // half of it went through the deck — and every later step faithfully kept
    // the wrong deck.
    st().createSubArray({ speakerId: KS28, count: 2, spacingM: 4, axis: 'x' });
    useStore.setState({ undoStack: [], redoStack: [] });
    render(<SteeringPanel />);
    const bottom = () =>
      Math.min(...st().sources.map((x) => {
        // on end, a KS28 is 1.34 m tall; upright 0.55 m
        const tall = Math.abs(((x.rotation.rollDeg % 180) + 180) % 180 - 90) < 1 ? 1.34 : KS28_H;
        return x.position.z - tall / 2;
      }));
    expect(bottom()).toBeCloseTo(0, 6);

    fireEvent.click(screen.getByText(EN['subs.orientOnEnd']));
    click(EN['subs.applyLayout']);
    expect(st().sources[0].position.z).toBeCloseTo(1.34 / 2, 6);
    expect(bottom()).toBeCloseTo(0, 6);

    typeNumber(fieldFor(EN['subs.perPosition']), '4');
    click(EN['subs.applyLayout']);
    expect(bottom()).toBeCloseTo(0, 6);
  });
});
