import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { cssVar } from '../render/cssTokens';
import { resolveAll } from '../state/resolve';
import { useHeatCanvas } from './useHeatCanvas';
import {
  fitView,
  fromPlaneAxes,
  gridStep,
  planeAxes,
  pointOnPlane,
  screenToWorld,
  snapValue,
  worldToScreen,
  type Viewport,
} from '../render/view';
import { boxSize } from '../speakers/schema';
import type { GridResult } from '../engine/types';
import type { Source, Vec3 } from '../core/types';

interface Props {
  result: GridResult | null;
}

type DragMode =
  | { kind: 'none' }
  | { kind: 'move'; startH: number; startV: number; origin: Map<string, Vec3>; moved: boolean }
  | {
      kind: 'rotate';
      axis: RotateAxis;
      centerH: number;
      centerV: number;
      startAngle: number;
      origin: Map<string, number>;
      /** stan sprzed przeciągnięcia i zaznaczenie — obrót bryły liczy się od nich */
      from: Source[];
      ids: string[];
    }
  | { kind: 'pan'; startX: number; startY: number; cx: number; cy: number }
  | { kind: 'marquee'; startH: number; startV: number; curH: number; curV: number };

/**
 * Which angle the Alt-drag gesture writes.
 *
 * It follows the drawn plane, because that is the only angle the drag can
 * actually be seen to change. The gesture used to write azimuth in both views,
 * so in the side view the user dragged, watched nothing move, and had rewritten
 * every selected cabinet's heading in 5 degree steps. Azimuth is acoustically
 * live: it rotates `originOffset` and the elements with it.
 */
type RotateAxis = 'azimuth' | 'elevation';

/**
 * The pointer's angle about the pivot, in the convention of the axis being
 * edited: azimuth is clockwise-positive from +Y, elevation is measured up from
 * the horizontal, and in the side view the screen axes are (Y, Z).
 */
function pointerAngle(axis: RotateAxis, dh: number, dv: number) {
  return axis === 'azimuth' ? Math.atan2(dh, dv) : Math.atan2(dv, dh);
}

// Czytane z arkusza, nie wpisane drugi raz: patrz render/cssTokens.ts.
// Funkcja, nie stała, bo tokeny są dostępne dopiero po zamontowaniu dokumentu.
const css = () => ({
  bg: cssVar('--bg-canvas', '#121416'),
  grid: cssVar('--line', '#22262a'),
  gridMajor: cssVar('--line-strong', '#333940'),
  axis: cssVar('--line-strong', '#4a525c'),
  text: cssVar('--fg-muted', '#7d8794'),
  box: cssVar('--fg-secondary', '#c3ccd8'),
  boxFill: 'rgba(20,24,30,0.82)',
  sel: cssVar('--accent', '#4da3ff'),
  muted: cssVar('--fg-weak', '#5a626d'),
  point: cssVar('--warn', '#ffd24a'),
  cursor: cssVar('--error', '#ff7043'),
});

export function CanvasStage({ result }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragMode>({ kind: 'none' });
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [, force] = useState(0);

  const s = useStore();
  const vp: Viewport = { width: size.width, height: size.height, view: s.view };

  // ---------------------------------------------------------------- resize
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => {
      const r = el.getBoundingClientRect();
      // A zero rect means the tab is not laid out; keep the last good size.
      if (r.width < 1 || r.height < 1) return;
      setSize({ width: r.width, height: r.height });
    };
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    apply();
    return () => ro.disconnect();
  }, []);

  // ------------------------------------------------------------- fit view
  /**
   * Retries left for a canvas that has not been laid out yet.
   *
   * The wait is needed: a panel opening or closing resizes the canvas and the
   * ResizeObserver has not necessarily fired, so an early measurement reports
   * zero and fitting against it would burn in a nonsense zoom. The COUNTER is
   * needed because the wait used to be unbounded: a canvas that never reaches
   * a usable size, in a hidden tab or a collapsed pane, re-armed the timer
   * every 150 ms for as long as the app stayed open. Nothing broke, and it
   * never stopped either.
   */
  const fitTries = useRef(0);
  const fitAll = useCallback(() => {
    const rect = wrapRef.current?.getBoundingClientRect();
    const box = { width: rect?.width ?? 0, height: rect?.height ?? 0 };
    if (box.width < 50 || box.height < 50) {
      // ~1.5 s of waiting, then give up: the next real fit request, or the
      // ResizeObserver firing, will start a fresh round anyway.
      if (fitTries.current < 10) {
        fitTries.current++;
        setTimeout(() => window.dispatchEvent(new Event('btr:fit')), 150);
      }
      return;
    }
    fitTries.current = 0;
    const pts: Array<[number, number]> = [];
    for (const src of s.sources) pts.push(planeAxes(s.sim.plane, src.position));
    for (const mp of s.measurementPoints) pts.push(planeAxes(s.sim.plane, mp.position));
    const a = s.sim.area;
    pts.push([a.xMin, a.vMin], [a.xMax, a.vMax]);
    const minH = Math.min(...pts.map((p) => p[0]));
    const maxH = Math.max(...pts.map((p) => p[0]));
    const minV = Math.min(...pts.map((p) => p[1]));
    const maxV = Math.max(...pts.map((p) => p[1]));
    s.setView(fitView(box, { minH, maxH, minV, maxV }));
  }, [s]);

  useEffect(() => {
    const handler = () => fitAll();
    window.addEventListener('btr:fit', handler);
    return () => window.removeEventListener('btr:fit', handler);
  }, [fitAll]);

  // "Prediction area ← view": snap the calculated extents to what is on screen.
  useEffect(() => {
    const handler = () => {
      const [xMin, vMax] = screenToWorld(vp, 0, 0);
      const [xMax, vMin] = screenToWorld(vp, size.width, size.height);
      s.patchSim({
        area: {
          ...s.sim.area,
          xMin: Math.round(xMin * 10) / 10,
          xMax: Math.round(xMax * 10) / 10,
          vMin: Math.round(vMin * 10) / 10,
          vMax: Math.round(vMax * 10) / 10,
        },
      });
    };
    window.addEventListener('btr:areaToView', handler);
    return () => window.removeEventListener('btr:areaToView', handler);
  });

  // ------------------------------------------------------------ heat cache
  // Shared with the 3D viewport, so the two cannot colour one solve differently.
  const heatCanvas = useHeatCanvas(result, {
    palette: s.palette,
    dynamicRangeDb: s.sim.dynamicRangeDb,
    dbPerDivision: s.sim.dbPerDivision,
    splMode: s.sim.splMode,
    calibratedRefDb: s.calibratedRefDb,
  });

  // ----------------------------------------------------------------- draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
    const ctx = canvas.getContext('2d')!;

    const CSSV = css();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = CSSV.bg;
    ctx.fillRect(0, 0, size.width, size.height);

    // ---- heatmap
    const hc = s.showHeatmap ? heatCanvas() : null;
    if (hc && result) {
      const [x0, y0] = worldToScreen(vp, result.xMin, result.vMax);
      const [x1, y1] = worldToScreen(vp, result.xMax, result.vMin);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(hc, x0, y0, x1 - x0, y1 - y0);
    }

    // ---- grid
    if (s.showGrid) {
      const step = gridStep(s.view.scale);
      const [wl, wt] = screenToWorld(vp, 0, 0);
      const [wr, wb] = screenToWorld(vp, size.width, size.height);
      ctx.lineWidth = 1;
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = 'top';

      for (let x = Math.floor(wl / step) * step; x <= wr; x += step) {
        const [sx] = worldToScreen(vp, x, 0);
        const major = Math.abs(x) < 1e-9;
        ctx.strokeStyle = major ? CSSV.axis : Math.abs(x % (step * 5)) < 1e-6 ? CSSV.gridMajor : CSSV.grid;
        ctx.beginPath();
        ctx.moveTo(Math.round(sx) + 0.5, 0);
        ctx.lineTo(Math.round(sx) + 0.5, size.height);
        ctx.stroke();
        if (Math.abs(x % (step * 5)) < 1e-6) {
          ctx.fillStyle = CSSV.text;
          ctx.fillText(`${x.toFixed(step < 1 ? 1 : 0)}`, sx + 3, size.height - 14);
        }
      }
      for (let v = Math.floor(wb / step) * step; v <= wt; v += step) {
        const [, sy] = worldToScreen(vp, 0, v);
        const major = Math.abs(v) < 1e-9;
        ctx.strokeStyle = major ? CSSV.axis : Math.abs(v % (step * 5)) < 1e-6 ? CSSV.gridMajor : CSSV.grid;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(sy) + 0.5);
        ctx.lineTo(size.width, Math.round(sy) + 0.5);
        ctx.stroke();
        if (Math.abs(v % (step * 5)) < 1e-6) {
          ctx.fillStyle = CSSV.text;
          ctx.fillText(`${v.toFixed(step < 1 ? 1 : 0)}`, 4, sy + 3);
        }
      }
      ctx.fillStyle = CSSV.text;
      ctx.fillText(s.sim.plane === 'top' ? 'X (m)  /  Y (m)' : 'Y (m)  /  Z (m)', size.width - 96, size.height - 28);
    }

    // ---- prediction area outline
    {
      const a = s.sim.area;
      const [ax0, ay0] = worldToScreen(vp, a.xMin, a.vMax);
      const [ax1, ay1] = worldToScreen(vp, a.xMax, a.vMin);
      ctx.strokeStyle = 'rgba(120,140,170,0.35)';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.strokeRect(ax0, ay0, ax1 - ax0, ay1 - ay0);
      ctx.setLineDash([]);
    }

    // ---- sources
    const resolved = resolveAll(s.sources, s.groups, s.provider);
    const plane = s.sim.plane;
    for (const r of resolved) {
      const model = r.model;
      // Drawn in the orientation the cabinet is standing in: a sub on its end
      // face is a tall narrow box in plan, not the datasheet's wide flat one.
      const b = model
        ? boxSize(model, r.rollDeg)
        : { widthM: 0.6, heightM: 0.6, depthM: 0.6, unknown: true };
      const [h, v] = planeAxes(plane, r.position);
      const [sx, sy] = worldToScreen(vp, h, v);
      const selected = s.selectedSourceIds.includes(r.source.id) || s.selectedGroupId === r.source.groupId;

      // On the top view the footprint is width x depth rotated by azimuth; on
      // the side view the screen axes are depth and height, so the box is depth
      // x height tilted by elevation.
      const wPx = (plane === 'top' ? b.widthM : b.depthM) * s.view.scale;
      const dPx = (plane === 'top' ? b.depthM : b.heightM) * s.view.scale;
      const rot = plane === 'top' ? r.azimuthDeg : -r.elevationDeg;

      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate((rot * Math.PI) / 180);

      ctx.fillStyle = r.muted ? 'rgba(20,24,30,0.55)' : CSSV.boxFill;
      ctx.strokeStyle = selected ? CSSV.sel : r.muted ? CSSV.muted : CSSV.box;
      ctx.lineWidth = selected ? 2 : 1.25;
      ctx.beginPath();
      ctx.rect(-wPx / 2, -dPx / 2, wPx, dPx);
      ctx.fill();
      ctx.stroke();

      // FRONT marker: a filled wedge on the leading edge.
      //
      // Which edge that IS depends on the plane, and it used to not. In plan
      // the rectangle is width x depth, so the front is local -Y — up the
      // screen, because screen Y grows downward while world front is +Y. In
      // SECTION the rectangle is depth x height, so the front is local +X and
      // the old marker sat on the cabinet's TOP face: a constant quarter turn
      // out, in the one view that exists to show elevation, and the opposite
      // of what the 3D view paints on the same box.
      ctx.fillStyle = selected ? CSSV.sel : r.muted ? CSSV.muted : CSSV.box;
      ctx.beginPath();
      if (plane === 'top') {
        const tip = -dPx / 2;
        const base = tip + Math.min(10, dPx * 0.3);
        ctx.moveTo(-wPx * 0.28, base);
        ctx.lineTo(wPx * 0.28, base);
        ctx.lineTo(0, tip + 1.5);
      } else {
        const tip = wPx / 2;
        const base = tip - Math.min(10, wPx * 0.3);
        ctx.moveTo(base, -dPx * 0.28);
        ctx.lineTo(base, dPx * 0.28);
        ctx.lineTo(tip - 1.5, 0);
      }
      ctx.closePath();
      ctx.fill();

      // acoustic centre
      ctx.strokeStyle = selected ? CSSV.sel : 'rgba(190,200,215,0.75)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-4, 0); ctx.lineTo(4, 0);
      ctx.moveTo(0, -4); ctx.lineTo(0, 4);
      ctx.stroke();
      ctx.restore();

      if (r.source.invertPolarity) {
        ctx.fillStyle = cssVar('--error', '#e5636b');
        ctx.font = 'bold 10px ui-monospace, monospace';
        ctx.fillText('Ø', sx + wPx / 2 + 3, sy - 12);
      }

      // Labels, but only when the cabinet's own footprint can hold them —
      // otherwise a tight array turns into a smear of overlapping text.
      if (s.view.scale > 6) {
        ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const slot = Math.max(wPx, dPx) + 6;
        const labelY = sy + Math.max(dPx, wPx) / 2 + 4;
        if (ctx.measureText(r.source.label).width <= slot) {
          ctx.fillStyle = selected ? CSSV.sel : CSSV.text;
          ctx.fillText(r.source.label, sx, labelY);
          if (model && ctx.measureText(model.model).width <= slot) {
            ctx.fillStyle = 'rgba(125,135,148,0.75)';
            ctx.fillText(model.model, sx, labelY + 12);
          }
        }
        ctx.textAlign = 'left';
      }
    }

    // ---- measurement points
    for (const mp of s.measurementPoints) {
      const [h, v] = planeAxes(plane, mp.position);
      const [px, py] = worldToScreen(vp, h, v);
      const sel = s.selectedPointId === mp.id;
      ctx.strokeStyle = sel ? CSSV.sel : CSSV.point;
      ctx.fillStyle = sel ? CSSV.sel : CSSV.point;
      ctx.lineWidth = sel ? 2 : 1.5;
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, py, 1.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(mp.name, px + 9, py - 4);
    }

    // ---- probe cursor
    if (s.cursorPoint) {
      const [h, v] = planeAxes(plane, s.cursorPoint);
      const [px, py] = worldToScreen(vp, h, v);
      ctx.strokeStyle = CSSV.cursor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px - 10, py); ctx.lineTo(px + 10, py);
      ctx.moveTo(px, py - 10); ctx.lineTo(px, py + 10);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ---- marquee
    const d = dragRef.current;
    if (d.kind === 'marquee') {
      const [x0, y0] = worldToScreen(vp, Math.min(d.startH, d.curH), Math.max(d.startV, d.curV));
      const [x1, y1] = worldToScreen(vp, Math.max(d.startH, d.curH), Math.min(d.startV, d.curV));
      ctx.strokeStyle = CSSV.sel;
      ctx.fillStyle = 'rgba(77,163,255,0.12)';
      ctx.lineWidth = 1;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    }
  });

  // ------------------------------------------------------------ hit testing
  const hitSource = (h: number, v: number): string | null => {
    const resolved = resolveAll(s.sources, s.groups, s.provider);
    const plane = s.sim.plane;
    // iterate backwards so the top-most cabinet wins
    for (let i = resolved.length - 1; i >= 0; i--) {
      const r = resolved[i];
      // Same box the drawing used, or clicking a turned cabinet misses it.
      const b = r.model
        ? boxSize(r.model, r.rollDeg)
        : { widthM: 0.6, heightM: 0.6, depthM: 0.6 };
      const [ch, cv] = planeAxes(plane, r.position);
      const rot = ((plane === 'top' ? r.azimuthDeg : -r.elevationDeg) * Math.PI) / 180;
      const dh = h - ch, dv = v - cv;
      // screen rotation is clockwise-positive, world V axis points up
      const c = Math.cos(rot), si = Math.sin(rot);
      const lx = dh * c - dv * si;
      const ly = dh * si + dv * c;
      const halfW = (plane === 'top' ? b.widthM : b.depthM) / 2;
      const halfD = (plane === 'top' ? b.depthM : b.heightM) / 2;
      const pad = 4 / s.view.scale; // easier to grab tiny boxes when zoomed out
      if (Math.abs(lx) <= halfW + pad && Math.abs(ly) <= halfD + pad) return r.source.id;
    }
    return null;
  };

  const hitPoint = (h: number, v: number): string | null => {
    const tol = 9 / s.view.scale;
    for (let i = s.measurementPoints.length - 1; i >= 0; i--) {
      const mp = s.measurementPoints[i];
      const [ph, pv] = planeAxes(s.sim.plane, mp.position);
      if (Math.hypot(h - ph, v - pv) <= tol) return mp.id;
    }
    return null;
  };

  // -------------------------------------------------------------- pointer
  const localXY = (e: React.PointerEvent | PointerEvent): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const onPointerDown = (e: React.PointerEvent) => {
    canvasRef.current?.setPointerCapture(e.pointerId);
    const [sx, sy] = localXY(e);
    const [h, v] = screenToWorld(vp, sx, sy);

    if (e.button === 1 || e.button === 2) {
      dragRef.current = { kind: 'pan', startX: sx, startY: sy, cx: s.view.cx, cy: s.view.cy };
      return;
    }

    if (s.tool === 'addPoint') {
      s.addMeasurementPoint(pointOnPlane(s.sim.plane, h, v, s.sim.area.planeOffset));
      s.setTool('select');
      return;
    }

    const mpId = hitPoint(h, v);
    if (mpId) {
      s.selectPoint(mpId);
      const mp = s.measurementPoints.find((m) => m.id === mpId)!;
      s.snapshot();
      s.setInteracting(true);
      dragRef.current = {
        kind: 'move',
        startH: h,
        startV: v,
        origin: new Map([[`mp:${mpId}`, { ...mp.position }]]),
        moved: false,
      };
      return;
    }

    const id = hitSource(h, v);
    if (id) {
      const already = s.selectedSourceIds.includes(id);
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        // same modifier rules as the lists, over the project order
        s.selectSourceAt(id, s.sources.map((x) => x.id), {
          toggle: e.metaKey || e.ctrlKey,
          range: e.shiftKey,
        });
      } else if (!already) {
        s.selectSources([id]);
      }

      const ids = already && !e.shiftKey ? s.selectedSourceIds : e.shiftKey ? [...new Set([...s.selectedSourceIds, id])] : [id];
      s.snapshot();
      s.setInteracting(true);

      if (e.altKey) {
        // The pivot is taken from RESOLVED positions. The pointer angle is
        // measured in world coordinates, so a pivot averaged over the stored
        // positions sits away from the visible cabinets for any selection inside
        // a group carrying an offset or a yaw, and the drag then swings about a
        // point that is nowhere on screen.
        const picked = resolveAll(s.sources, s.groups, s.provider).filter((r) => ids.includes(r.source.id));
        const ch = picked.reduce((a, r) => a + planeAxes(s.sim.plane, r.position)[0], 0) / picked.length;
        const cv = picked.reduce((a, r) => a + planeAxes(s.sim.plane, r.position)[1], 0) / picked.length;
        const axis: RotateAxis = s.sim.plane === 'top' ? 'azimuth' : 'elevation';
        dragRef.current = {
          kind: 'rotate',
          axis,
          centerH: ch,
          centerV: cv,
          startAngle: pointerAngle(axis, h - ch, v - cv),
          // Stan sprzed przeciągnięcia: azymut liczy się od niego przy każdym
          // ruchu myszy, razem z położeniem (obrót bryły, rotateSelection).
          from: s.sources,
          ids,
          // The angles written are the source's OWN, not the resolved ones: a
          // group's yaw is an offset on top of them and stays where it is.
          origin: new Map(
            picked.map((r) => [
              r.source.id,
              axis === 'azimuth' ? r.source.rotation.azimuthDeg : r.source.rotation.elevationDeg,
            ]),
          ),
        };
      } else {
        const origin = new Map<string, Vec3>();
        for (const src of s.sources) if (ids.includes(src.id)) origin.set(src.id, { ...src.position });
        dragRef.current = { kind: 'move', startH: h, startV: v, origin, moved: false };
      }
      return;
    }

    // empty space
    dragRef.current = { kind: 'marquee', startH: h, startV: v, curH: h, curV: v };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const [sx, sy] = localXY(e);

    if (d.kind === 'pan') {
      s.setView({
        cx: d.cx - (sx - d.startX) / s.view.scale,
        cy: d.cy + (sy - d.startY) / s.view.scale,
      });
      return;
    }
    if (d.kind === 'none') return;

    const [h, v] = screenToWorld(vp, sx, sy);

    if (d.kind === 'marquee') {
      dragRef.current = { ...d, curH: h, curV: v };
      force((n) => n + 1);
      return;
    }

    if (d.kind === 'rotate') {
      const ang = pointerAngle(d.axis, h - d.centerH, v - d.centerV);
      // Folded to (-180, 180]: two atan2 readings either side of the seam differ
      // by a full turn, which is harmless for a modular azimuth and would send a
      // clamped elevation straight to its limit.
      let deltaDeg = ((((ang - d.startAngle) * 180) / Math.PI + 540) % 360) - 180;
      if (e.shiftKey) deltaDeg = Math.round(deltaDeg); // fine
      else deltaDeg = Math.round(deltaDeg / 5) * 5;
      if (d.axis === 'azimuth') {
        // po okręgu wokół środka zaznaczenia, nie każda skrzynia w miejscu
        s.rotateSelected(d.ids, deltaDeg, { from: d.from, history: false });
        return;
      }
      for (const [id, base] of d.origin) {
        // The same limit the inspector's field enforces: past 90 degrees
        // either way the front vector folds over, which is a different
        // heading rather than a steeper tilt.
        const el = Math.max(-90, Math.min(90, base + deltaDeg));
        s.patchSources([id], { rotation: { elevationDeg: el } }, false);
      }
      return;
    }

    // move
    const snapStep = e.shiftKey ? 0 : s.snap;
    let dh = h - d.startH;
    let dv = v - d.startV;

    // Snap the primary (first) item to the grid, then move everything by the
    // same delta so relative geometry inside a selection is preserved.
    const first = d.origin.values().next().value as Vec3 | undefined;
    if (first && snapStep > 0) {
      const [oh, ov] = planeAxes(s.sim.plane, first);
      dh = snapValue(oh + dh, snapStep) - oh;
      dv = snapValue(ov + dv, snapStep) - ov;
    }

    for (const [key, orig] of d.origin) {
      const [oh, ov] = planeAxes(s.sim.plane, orig);
      const next = fromPlaneAxes(s.sim.plane, oh + dh, ov + dv, orig);
      if (key.startsWith('mp:')) {
        s.patchMeasurementPointTransient(key.slice(3), next);
      } else {
        s.patchSources([key], { position: next }, false);
      }
    }
    if (!d.moved && (Math.abs(dh) > 0 || Math.abs(dv) > 0)) dragRef.current = { ...d, moved: true };
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const [sx, sy] = localXY(e);
    const [h, v] = screenToWorld(vp, sx, sy);

    if (d.kind === 'marquee') {
      const dist = Math.hypot(h - d.startH, v - d.startV);
      if (dist * s.view.scale < 4) {
        // a plain click on empty canvas = probe the prediction there
        s.selectSources([]);
        s.selectPoint(null);
        s.setCursorPoint(pointOnPlane(s.sim.plane, h, v, s.sim.area.planeOffset));
      } else {
        const lo = { h: Math.min(d.startH, h), v: Math.min(d.startV, v) };
        const hi = { h: Math.max(d.startH, h), v: Math.max(d.startV, v) };
        const resolved = resolveAll(s.sources, s.groups, s.provider);
        const ids = resolved
          .filter((r) => {
            const [ph, pv] = planeAxes(s.sim.plane, r.position);
            return ph >= lo.h && ph <= hi.h && pv >= lo.v && pv <= hi.v;
          })
          .map((r) => r.source.id);
        s.selectSources(ids, e.shiftKey);
      }
    }

    dragRef.current = { kind: 'none' };
    s.setInteracting(false);
    canvasRef.current?.releasePointerCapture(e.pointerId);
    force((n) => n + 1);
  };

  const onWheel = (e: React.WheelEvent) => {
    const [sx, sy] = localXY(e as unknown as React.PointerEvent);
    if (e.shiftKey) {
      s.setView({ cx: s.view.cx + e.deltaY / s.view.scale });
      return;
    }
    const [wx, wv] = screenToWorld(vp, sx, sy);
    const factor = Math.exp(-e.deltaY * 0.0016);
    const scale = Math.max(0.5, Math.min(400, s.view.scale * factor));
    // keep the world point under the cursor pinned
    s.setView({
      scale,
      cx: wx - (sx - size.width / 2) / scale,
      cy: wv + (sy - size.height / 2) / scale,
    });
  };

  return (
    <div ref={wrapRef} className="canvas-wrap">
      <canvas
        ref={canvasRef}
        style={{ width: size.width, height: size.height, cursor: s.tool === 'addPoint' ? 'crosshair' : 'default' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}
