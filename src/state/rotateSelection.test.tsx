// @vitest-environment jsdom
/**
 * Rotating a selection turns it as one body: the cabinets
 * swing round the selection's geometric centre and each gets the same heading
 * change, from every way in — the store action, the Inspector's buttons and
 * field, and the Alt-drag on the canvas.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { makeSource, useStore } from './store';
import { resolveAll } from './resolve';
import { rotateSelection, selectionCentre } from './rotateSelection';
import { Inspector } from '../ui/Inspector';
import { CanvasStage } from '../ui/CanvasStage';
import { worldToScreen } from '../render/view';
import type { Group, Source } from '../core/types';

const st = () => useStore.getState();

/** four KS28 in a row along X, 1 m apart, centred on (cx, cy) */
function row(cx = 0, cy = 0): Source[] {
  return [-1.5, -0.5, 0.5, 1.5].map((dx, i) => makeSource('la-ks28', `S${i}`, { x: cx + dx, y: cy, z: 0.275 }));
}
function project(sources: Source[], groups: Group[] = [], select = sources.map((x) => x.id)) {
  act(() => {
    useStore.setState({
      sources, groups, selectedSourceIds: select, selectedGroupId: null, selectedPointId: null,
      undoStack: [], redoStack: [],
    });
  });
}
const close = (a: number, b: number, d = 9) => expect(a).toBeCloseTo(b, d);
const dist = (a: Source, b: Source) => Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);

// Platform stubs only, as in ui/interaction.test.tsx: jsdom has no layout,
// no canvas raster and no pointer capture.
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
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
});

beforeEach(() => st().newProject());
afterEach(() => cleanup());

describe('rotateSelection', () => {
  it('swings the cabinets round the selection centre and turns each by the same angle', () => {
    const before = row(4, 2);
    const after = rotateSelection(before, [], before.map((x) => x.id), 90);
    // the left end (-1.5 m from the centre) swings to 1.5 m in front of it
    close(after[0].position.x, 4);
    close(after[0].position.y, 3.5);
    close(after[3].position.x, 4);
    close(after[3].position.y, 0.5);
    for (const s of after) expect(s.rotation.azimuthDeg).toBe(90);
    // centre kept, shape kept, height untouched
    const c = selectionCentre(after, [], after.map((x) => x.id))!;
    close(c.x, 4);
    close(c.y, 2);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) close(dist(after[i], after[j]), dist(before[i], before[j]));
      expect(after[i].position.z).toBe(before[i].position.z);
    }
  });

  it('leaves what is not selected alone, and turns a lone cabinet in place', () => {
    const s = row();
    const after = rotateSelection(s, [], [s[3].id], 45);
    expect(after.slice(0, 3)).toEqual(s.slice(0, 3));
    expect(after[3].position).toEqual(s[3].position);
    expect(after[3].rotation.azimuthDeg).toBe(45);
  });

  it('pivots where the cabinets are drawn when they sit in a moved, turned group', () => {
    const g: Group = {
      id: 'g1', name: 'G', offset: { x: 10, y: 5, z: 0 }, rotationOffsetDeg: 30,
      anchor: { x: 0, y: 0, z: 0 }, levelOffsetDb: 0, delayOffsetS: 0, mute: false,
    };
    const s = row().map((x) => ({ ...x, groupId: g.id }));
    const world = (list: Source[]) => resolveAll(list, [g], st().provider).map((r) => r.position);
    const w0 = world(s);
    const after = rotateSelection(s, [g], s.map((x) => x.id), 60);
    const w1 = world(after);
    const cx = w0.reduce((t, p) => t + p.x, 0) / 4, cy = w0.reduce((t, p) => t + p.y, 0) / 4;
    // every drawn cabinet turned 60 deg clockwise about the drawn centre
    const a = (60 * Math.PI) / 180;
    w0.forEach((p, i) => {
      const dx = p.x - cx, dy = p.y - cy;
      close(w1[i].x, cx + dx * Math.cos(a) + dy * Math.sin(a), 6);
      close(w1[i].y, cy - dx * Math.sin(a) + dy * Math.cos(a), 6);
    });
  });

  it('turns a whole position with its remembered angle, and leaves a partial one alone', () => {
    const s = row().map((x, i) => ({ ...x, positionKey: i < 2 ? 'p.a' : 'p.b' }));
    const after = rotateSelection(s, [], [s[0].id, s[1].id, s[2].id], 20);
    expect(after[0].positionYawDeg).toBe(20);
    expect(after[1].positionYawDeg).toBe(20);
    expect(after[2].positionYawDeg).toBeUndefined();
    // folded like the field: 170 + 20 -> -170
    const turned = rotateSelection(after.map((x) => ({ ...x, positionYawDeg: 170 })), [], [s[0].id, s[1].id], 20);
    close(turned[0].positionYawDeg!, -170);
  });
});

describe('every way in turns the selection as one body', () => {
  it('the Inspector buttons', () => {
    project(row());
    render(<Inspector />);
    fireEvent.click(screen.getByText('+90°'));
    const r = st().sources;
    close(r[0].position.x, 0);
    close(r[0].position.y, 1.5);
    expect(r.every((x) => x.rotation.azimuthDeg === 90)).toBe(true);
    expect(st().undoStack.length).toBe(1);
  });

  it('the azimuth field, when the selection faces one way — reversed cabinets included', () => {
    const s = row();
    s[2] = { ...s[2], rotation: { ...s[2].rotation, azimuthDeg: 180 }, invertPolarity: true };
    project(s);
    render(<Inspector />);
    const az = screen.getByLabelText(/Azimuth/) as HTMLInputElement;
    expect(az.value).toBe('0');
    fireEvent.change(az, { target: { value: '30' } });
    fireEvent.blur(az);
    const r = st().sources;
    expect(r.map((x) => x.rotation.azimuthDeg)).toEqual([30, 30, 210, 30]);
    close(dist(r[0], r[3]), 3);
    expect(Math.abs(r[0].position.y - r[3].position.y)).toBeGreaterThan(1);
  });

  it('the Alt-drag on the canvas', () => {
    act(() => st().setView({ scale: 40, cx: 0, cy: 0 }));
    project(row());
    const canvas = render(<CanvasStage result={null} />).container.querySelector('canvas')!;
    const at = (h: number, v: number) => {
      const [x, y] = worldToScreen({ width: 800, height: 600, view: st().view }, h, v);
      return { clientX: x, clientY: y, pointerId: 1 };
    };
    // down on the right-hand cabinet, then a quarter turn about the centre
    fireEvent.pointerDown(canvas, { ...at(1.5, 0), altKey: true });
    fireEvent.pointerMove(canvas, { ...at(0, 1.5), altKey: true });
    fireEvent.pointerUp(canvas, at(0, 1.5));
    const r = st().sources;
    expect(r.every((x) => x.rotation.azimuthDeg === -90)).toBe(true);
    // the right-hand end swung up to the front, the left-hand end behind
    close(r[3].position.x, 0, 6);
    close(r[3].position.y, 1.5, 6);
    close(r[0].position.y, -1.5, 6);
  });
});
