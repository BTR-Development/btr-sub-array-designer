/**
 * The 3D viewport.
 *
 * What it is FOR, which decides everything it draws: the two 2D views are
 * sections, and a rig that is several cabinets deep at each of several
 * positions is exactly the rig a section cannot show. A reverse stack is the
 * sharpest case — in plan the turned cabinet sits under the ones in front of
 * it and in section it sits behind them, so the one arrangement whose whole
 * point is which way a box faces is the one neither view can draw.
 *
 * So: solid cabinets with a visible front face, the prediction plane drawn
 * where it actually sits, and the floor to measure against. The geometry is
 * `render/camera3d.ts` and `render/box3d.ts`, both pure and both tested; this
 * file decides only what gets painted and in which order.
 *
 * It is a VIEW, not a prediction surface. The SPL still comes from the plane
 * the simulation settings name, and the one thing this view adds to it is
 * showing you where that plane is relative to the rig.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { cssVar } from '../render/cssTokens';
import { resolveAll } from '../state/resolve';
import {
  affineForQuad,
  basisOf,
  clipSegment,
  depthOf,
  fitCamera,
  orbit,
  pan,
  gridStepFor,
  project,
  zoomAt,
  type Viewport3D,
} from '../render/camera3d';
import { cabinetCorners, cabinetFaces, facesCamera, shadeOf, type Face3D } from '../render/box3d';
import { planeImageCorners, pointOnPlane } from '../render/view';
import { pickCabinet } from '../render/pick3d';
import { boxSize, UNKNOWN_BOX } from '../speakers/schema';
import { useHeatCanvas } from './useHeatCanvas';
import { useT } from '../i18n/useT';
import type { GridResult } from '../engine/types';
import type { Vec3 } from '../core/types';

interface Props {
  result: GridResult | null;
}

// Czytane z arkusza, nie wpisane drugi raz: patrz render/cssTokens.ts.
// Trójki RGB zostają liczbami, bo idą do cieniowania Lamberta — mnoży się je
// przez jasność w czasie rysowania, a tokenu CSS nie da się pomnożyć.
const css = () => ({
  bg: cssVar('--bg-canvas', '#121416'),
  floor: cssVar('--line', '#1e2328'),
  floorMajor: cssVar('--line-strong', '#2b3238'),
  axisX: '#6b4a4a',
  axisY: '#4a6b52',
  gizmoX: '#d08a8a',
  gizmoY: '#86c795',
  gizmoZ: '#8ab4e0',
  text: cssVar('--fg-muted', '#8b949e'),
  planeEdge: cssVar('--line-strong', '#3d4852'),
  outline: 'rgba(8,10,12,0.65)',
  selectedEdge: cssVar('--accent', '#9ecbff'),
  point: cssVar('--fg-secondary', '#d8dee4'),
  pointSelected: cssVar('--accent', '#5c96d6'),
  inverted: cssVar('--error', '#ff6b6b'),
  cabinet: [120, 134, 148] as [number, number, number],
  // Zielony przód i prawie czarny tył. Te dwie barwy
  // niosą najważniejszą rzecz w tym widoku — którą stroną stoi obudowa — więc
  // są możliwie daleko od siebie, a nie dwoma odcieniami tego samego.
  // Boki zostają szare: gdyby i one zrobiły się czarne, obrócona obudowa
  // zlewałaby się z tłem i rząd przestałby być policzalny.
  cabinetFront: [76, 195, 138] as [number, number, number],
  cabinetBack: [14, 16, 18] as [number, number, number],
  cabinetSelected: [92, 150, 214] as [number, number, number],
});

type Drag =
  | { kind: 'none' }
  | { kind: 'orbit'; x: number; y: number; x0: number; y0: number; moved: boolean }
  | { kind: 'pan'; x: number; y: number; x0: number; y0: number; moved: boolean };

/** Ile pikseli wolno przejechać, żeby to był jeszcze klik, a nie obrót. */
const CLICK_SLOP_PX = 4;

/** A thing to paint, with the depth it sorts by. */
interface Drawable {
  depth: number;
  paint: (ctx: CanvasRenderingContext2D) => void;
}

export function Canvas3D({ result }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<Drag>({ kind: 'none' });
  const [size, setSize] = useState({ width: 800, height: 600 });
  const s = useStore();
  const t = useT();
  // `useT` returns a NEW function on every store change, so holding it in the
  // draw effect's dependencies repainted the whole scene — floor, plane,
  // every cabinet — each time anything anywhere in the application moved. The
  // effect needs the string, which only changes with the language.
  const frontLabel = t('v3d.front');
  const edgeOnLabel = t('v3d.edgeOn');

  const vp: Viewport3D = { width: size.width, height: size.height, cam: s.cam3d };

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      setSize({ width: r.width, height: r.height });
    };
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    apply();
    return () => ro.disconnect();
  }, []);

  const resolved = useMemo(
    () => resolveAll(s.sources, s.groups, s.provider),
    [s.sources, s.groups, s.provider],
  );

  const heatCanvas = useHeatCanvas(result, {
    palette: s.palette,
    dynamicRangeDb: s.sim.dynamicRangeDb,
    dbPerDivision: s.sim.dbPerDivision,
    splMode: s.sim.splMode,
    calibratedRefDb: s.calibratedRefDb,
  });

  /** Every corner of every cabinet plus the prediction rectangle, for framing. */
  const framePoints = useMemo(() => {
    const pts: Vec3[] = [];
    for (const r of resolved) {
      const b = r.model ? boxSize(r.model) : UNKNOWN_BOX;
      pts.push(
        ...cabinetCorners(
          r.position,
          { azimuthDeg: r.azimuthDeg, elevationDeg: r.elevationDeg, rollDeg: r.rollDeg },
          b,
        ),
      );
    }
    const a = s.sim.area;
    for (const [h, v] of [[a.xMin, a.vMin], [a.xMax, a.vMin], [a.xMin, a.vMax], [a.xMax, a.vMax]]) {
      pts.push(pointOnPlane(s.sim.plane, h, v, a.planeOffset));
    }
    return pts;
  }, [resolved, s.sim.area, s.sim.plane]);

  // The Home button and a double click both ask for the same framing.
  useEffect(() => {
    const handler = () => s.setCam3d(fitCamera(s.cam3d, framePoints, size.width, size.height));
    window.addEventListener('btr:fit', handler);
    return () => window.removeEventListener('btr:fit', handler);
  });

  // ------------------------------------------------------------------ draw
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

    // Built here rather than captured: a viewport object made during render is
    // a new object every render, and as an effect dependency it would repaint
    // the scene on every keystroke anywhere in the application.
    const view: Viewport3D = { width: size.width, height: size.height, cam: s.cam3d };
    const basis = basisOf(s.cam3d);
    const to = (p: Vec3) => project(view, p, basis);

    // ---- floor, drawn first: it is the ground and everything stands on it
    if (s.showGrid) drawFloor(CSSV, ctx, view, to);

    // ---- the prediction plane, where it actually sits
    const hc = s.showHeatmap ? heatCanvas() : null;
    if (hc && result) {
      // The offset comes from the settings rather than the result, because the
      // result carries only the rectangle it was solved over. A stale solve
      // therefore draws at the plane the settings now name, which is the same
      // thing the 2D views do and is what the staleness badge is for.
      const corner = (h: number, v: number) =>
        pointOnPlane(s.sim.plane, h, v, s.sim.area.planeOffset);
      // The image's row 0 is the HIGH end of the vertical axis, the same way
      // the 2D view draws it, so the two cannot disagree about which way up
      // the map is.
      const { origin: o, alongX: ax, alongY: ay } = planeImageCorners(
        s.sim.plane,
        result,
        s.sim.area.planeOffset,
      );
      const m = affineForQuad(view, o, ax, ay, result.nx, result.nv, basis);
      if (!m) {
        // A plane seen EDGE-ON projects to a line, and so does its map. A
        // vertical prediction plane at the default camera is exactly that, so
        // this is not a corner case — it is what the side-view plane does the
        // moment somebody opens this view, and drawing nothing without saying
        // why reads as a broken viewport.
        ctx.save();
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = CSSV.text;
        ctx.textAlign = 'center';
        ctx.fillText(edgeOnLabel, size.width / 2, size.height / 2);
        ctx.restore();
      }
      if (m) {
        // Painted BENEATH the cabinets, deliberately and not by depth.
        //
        // One depth per object cannot place a large flat surface against small
        // solids scattered over it: half the plane is behind the rig and half
        // in front, and sorting by its centre put the whole map over the top
        // of every cabinet — a 3D view of a sub array with no subs in it. The
        // alternative, splitting the plane along the rig, buys nothing: the
        // map is a reading of the room rather than an object in it, and the
        // one thing this view exists to show must never be hidden by it.
        ctx.save();
        ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.globalAlpha = 0.92;
        ctx.drawImage(hc, 0, 0);
        ctx.restore();
        ctx.strokeStyle = CSSV.planeEdge;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const ring = [o, ax, corner(result.xMax, result.vMin), ay];
        ring.forEach((p, i) => {
          const [x, y] = to(p);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.stroke();
      }
    }

    // ---- cabinets, painted among themselves back to front
    const items: Drawable[] = [];

    for (const r of resolved) {
      const b = r.model ? boxSize(r.model) : UNKNOWN_BOX;
      const rot = { azimuthDeg: r.azimuthDeg, elevationDeg: r.elevationDeg, rollDeg: r.rollDeg };
      const faces = cabinetFaces(r.position, rot, b);
      const selected =
        s.selectedSourceIds.includes(r.source.id) || s.selectedGroupId === r.source.groupId;
      const muted = r.muted;
      const inverted = r.source.invertPolarity;
      items.push({
        depth: depthOf(s.cam3d, r.position, basis),
        paint: (c) => {
          // Back faces are dropped rather than painted over: a box is convex,
          // so the faces turned away from the camera are exactly the hidden
          // ones and sorting the remaining three never gets it wrong.
          const visible = faces
            .filter((f) => facesCamera(f.normal, basis.dir))
            .sort((p, q) => depthOf(s.cam3d, faceCentre(q), basis) - depthOf(s.cam3d, faceCentre(p), basis));
          for (const f of visible) paintFace(CSSV, c, f, to, selected, muted);
          // The same marker both 2D views draw. A turned-round cabinet and an
          // inverted one are different facts and a reverse stack needs both:
          // the gold face says which way it points, this says what its
          // polarity is, and a rig with one and not the other is a mistake
          // worth seeing.
          if (inverted) {
            const [px, py] = to(r.position);
            c.fillStyle = CSSV.inverted;
            c.font = 'bold 11px ui-monospace, SFMono-Regular, monospace';
            c.textAlign = 'center';
            c.fillText('Ø', px, py - 4);
            c.textAlign = 'left';
          }
        },
      });
    }

    // Painter's algorithm: furthest first.
    items.sort((a, b2) => b2.depth - a.depth);
    for (const it of items) it.paint(ctx);

    // ---- measurement points and the labels, always on top
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    for (const mp of s.measurementPoints) {
      const [x, y] = to(mp.position);
      ctx.fillStyle = s.selectedPointId === mp.id ? CSSV.pointSelected : CSSV.point;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = CSSV.text;
      ctx.fillText(mp.name, x + 7, y + 4);
    }

    // ---- what a metre is, and which way the room runs
    // `view`, not the component's `vp` — the same numbers, but `vp` is a fresh
    // object on every render, so depending on it here repaints the whole scene
    // whenever anything anywhere in the application moves. Same reason the
    // front label is pulled out of `useT` above.
    if (s.showGrid) drawAxisLabels(CSSV, ctx, view, to);
    drawScaleBar(CSSV, ctx, view, size.height);

    // ---- the orientation legend, so the picture can be read without guessing
    drawLegend(CSSV, ctx, size.width, s.cam3d.yawDeg, s.cam3d.pitchDeg, frontLabel);
  }, [
    size, s.cam3d, s.showGrid, s.showHeatmap, result, resolved, heatCanvas,
    s.sim.plane, s.sim.area.planeOffset, s.selectedSourceIds, s.selectedGroupId,
    s.measurementPoints, s.selectedPointId, frontLabel, edgeOnLabel,
  ]);

  // ------------------------------------------------------------- interaction
  //
  // Every handler below composes a NEW camera out of the current one, so it has
  // to read the current one. `s.cam3d` is the render's copy, and a burst of
  // wheel or move events arrives faster than React re-renders: each event in
  // the burst then starts from the same stale camera. For orbit and pan, whose
  // deltas are relative, that silently drops all but the last event. For the
  // zoom it is worse — the shift that pins the cursor is computed against a
  // scale the camera no longer has, so the view walks away from the pointer,
  // which is the exact failure this zoom was written to remove.
  const liveCam = () => useStore.getState().cam3d;

  const onPointerDown = (e: React.PointerEvent) => {
    // Only the buttons that mean something. A right press used to start an
    // orbit that no pointerup ever ended, because the browser opens its
    // context menu instead and the capture goes with it — the view then
    // orbited on every later mouse move with no button down at all.
    if (e.button !== 0 && e.button !== 1) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const panning = e.shiftKey || e.button === 1;
    dragRef.current = {
      kind: panning ? 'pan' : 'orbit',
      x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: false,
    };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (d.kind === 'none') return;
    // A button released outside the canvas, or taken by a context menu, never
    // sends its pointerup here. `buttons` is the state rather than the event,
    // so it ends the drag the first time the pointer moves without one.
    if (e.buttons === 0) {
      dragRef.current = { kind: 'none' };
      return;
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const far =
      Math.abs(e.clientX - d.x0) > CLICK_SLOP_PX || Math.abs(e.clientY - d.y0) > CLICK_SLOP_PX;
    dragRef.current = { ...d, x: e.clientX, y: e.clientY, moved: d.moved || far };
    const cam = liveCam();
    if (d.kind === 'orbit') s.setCam3d(orbit(cam, dx, dy));
    else s.setCam3d(pan({ ...vp, cam }, dx, dy));
  };
  const endDrag = () => {
    dragRef.current = { kind: 'none' };
  };

  /**
   * Puszczenie przycisku bez przejechania to kliknięcie, a kliknięcie zaznacza.
   *
   * Próg jest po to, żeby obrót nie zaznaczał: przy obracaniu rigu palec prawie
   * nigdy nie wraca dokładnie w punkt startu, a zaznaczenie na końcu każdego
   * obrotu kasowałoby to, co operator przed chwilą wybrał.
   */
  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = { kind: 'none' };
    if (d.kind !== 'orbit' || d.moved) return;

    const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const basis = basisOf(s.cam3d);
    const boxes = resolved.map((x) => ({
      id: x.source.id,
      position: x.position,
      rotation: { azimuthDeg: x.azimuthDeg, elevationDeg: x.elevationDeg, rollDeg: x.rollDeg },
      size: x.model ? boxSize(x.model) : UNKNOWN_BOX,
    }));
    const hit = pickCabinet(vp, basis, boxes, e.clientX - r.left, e.clientY - r.top);

    if (!hit) {
      // Puste miejsce czyści zaznaczenie, tak jak na planie.
      if (!e.shiftKey && !e.metaKey && !e.ctrlKey) s.selectSources([]);
      return;
    }
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      // Te same reguły co w liście i na planie, po kolejności w projekcie.
      s.selectSourceAt(hit, s.sources.map((x) => x.id), {
        toggle: e.metaKey || e.ctrlKey,
        range: e.shiftKey,
      });
    } else {
      s.selectSources([hit]);
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    // About the POINTER, not the viewport centre. `size` comes from
    // getBoundingClientRect, so the viewport and the projection are both in CSS
    // pixels and the cursor offset needs no device-ratio correction.
    const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    s.setCam3d(
      zoomAt({ ...vp, cam: liveCam() }, Math.pow(0.999, e.deltaY), e.clientX - r.left, e.clientY - r.top),
    );
  };

  return (
    <div ref={wrapRef} className="canvas-wrap">
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={endDrag}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
        onDoubleClick={() => s.setCam3d(fitCamera(s.cam3d, framePoints, size.width, size.height))}
      />
      <div className="canvas-hint small">{t('v3d.hint')}</div>
    </div>
  );
}

function faceCentre(f: Face3D): Vec3 {
  return f.corners.reduce(
    (a, c) => ({ x: a.x + c.x / 4, y: a.y + c.y / 4, z: a.z + c.z / 4 }),
    { x: 0, y: 0, z: 0 },
  );
}

function paintFace(
  CSSV: ReturnType<typeof css>,
  ctx: CanvasRenderingContext2D,
  f: Face3D,
  to: (p: Vec3) => [number, number],
  selected: boolean,
  muted: boolean,
) {
  // The front face is COLOURED, not just shaded, and it keeps its colour when
  // the cabinet is selected. A reverse stack is the reason this view exists; a
  // selection that repaints the front face hides exactly the thing the view
  // was opened to check — and every layout leaves the rig it just built
  // selected, so that is the state the operator looks at it in.
  const base =
    f.kind === 'front'
      ? CSSV.cabinetFront
      : f.kind === 'back'
        ? CSSV.cabinetBack
        : selected
          ? CSSV.cabinetSelected
          : CSSV.cabinet;
  const k = shadeOf(f.normal) * (muted ? 0.55 : 1);
  ctx.fillStyle = `rgb(${Math.round(base[0] * k)},${Math.round(base[1] * k)},${Math.round(base[2] * k)})`;
  ctx.beginPath();
  f.corners.forEach((p, i) => {
    const [x, y] = to(p);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fill();
  // Selection says itself in the outline instead, which no face colour can
  // collide with.
  ctx.strokeStyle = selected ? CSSV.selectedEdge : CSSV.outline;
  ctx.lineWidth = selected ? 1.4 : 1;
  ctx.stroke();
}

/**
 * A floor grid at z = 0 with the two stage axes picked out.
 *
 * Bounded by what the viewport can actually see rather than by a fixed extent,
 * so it neither runs out at the edge of a big room nor spends a thousand lines
 * off screen.
 */
function drawFloor(
  CSSV: ReturnType<typeof css>,
  ctx: CanvasRenderingContext2D,
  vp: Viewport3D,
  to: (p: Vec3) => [number, number],
) {
  const halfW = vp.width / 2 / vp.cam.scale;
  const halfH = vp.height / 2 / vp.cam.scale;
  // The on-screen half-diagonal, projected back onto the floor. Generous on
  // purpose: a shallow pitch stretches the floor a long way up the screen.
  const reach = Math.hypot(halfW, halfH) / Math.max(0.2, Math.abs(Math.sin((vp.cam.pitchDeg * Math.PI) / 180)));
  const step = gridStepFor(vp.cam.scale);
  const cx = Math.round(vp.cam.target.x / step) * step;
  const cy = Math.round(vp.cam.target.y / step) * step;
  const n = Math.min(240, Math.ceil(reach / step));

  ctx.lineWidth = 1;
  for (let i = -n; i <= n; i++) {
    const gx = cx + i * step;
    const gy = cy + i * step;
    ctx.strokeStyle = Math.abs(gx) < 1e-9 ? CSSV.axisX : Math.abs(gx % (step * 5)) < 1e-9 ? CSSV.floorMajor : CSSV.floor;
    line(ctx, to({ x: gx, y: cy - n * step, z: 0 }), to({ x: gx, y: cy + n * step, z: 0 }));
    ctx.strokeStyle = Math.abs(gy) < 1e-9 ? CSSV.axisY : Math.abs(gy % (step * 5)) < 1e-9 ? CSSV.floorMajor : CSSV.floor;
    line(ctx, to({ x: cx - n * step, y: gy, z: 0 }), to({ x: cx + n * step, y: gy, z: 0 }));
  }
}

function line(ctx: CanvasRenderingContext2D, a: [number, number], b: [number, number]) {
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
}

/**
 * Numbers on the floor grid, and the three axis names.
 *
 * The 3D view had a grid and not one figure on it, so a spacing could be
 * counted in squares and never converted: the squares change size with the
 * zoom. The two 2D views label every fifth line, and this labels the same
 * lines on the same rule.
 *
 * WHERE the numbers go is the part that is different here. In 2D a gridline is
 * vertical or horizontal and the number sits at the edge of the canvas. On a
 * floor seen at an angle the line runs off both edges and its world axis is
 * usually off screen altogether, so the first version of this wrote the
 * numbers ON the X and Y axes - and the moment the camera panned away from the
 * origin, which is most of the time, the view had a grid and no figures again.
 * So each line is clipped to the canvas and labelled where it leaves it: the X
 * values along the bottom edge, the Y values down the left, which keeps the two
 * families apart.
 */
function drawAxisLabels(
  CSSV: ReturnType<typeof css>,
  ctx: CanvasRenderingContext2D,
  vp: Viewport3D,
  to: (p: Vec3) => [number, number],
) {
  const step = gridStepFor(vp.cam.scale);
  const major = step * 5;
  const dp = major < 1 ? 1 : 0;
  // The same reach the floor grid uses, so the numbers stop where it does.
  const halfW = vp.width / 2 / vp.cam.scale;
  const halfH = vp.height / 2 / vp.cam.scale;
  const reach = Math.hypot(halfW, halfH) /
    Math.max(0.2, Math.abs(Math.sin((vp.cam.pitchDeg * Math.PI) / 180)));
  const n = Math.min(120, Math.ceil(reach / major));
  const cx = Math.round(vp.cam.target.x / major) * major;
  const cy = Math.round(vp.cam.target.y / major) * major;
  const far = (n + 1) * major;
  // Inset so the text lands inside the canvas rather than half off it.
  const rect = { x0: 20, y0: 14, x1: vp.width - 20, y1: vp.height - 44 };
  if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return;

  ctx.save();
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = CSSV.text;

  // X values: label the end of the clipped line nearest the BOTTOM.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (let i = -n; i <= n; i++) {
    const gx = cx + i * major;
    const seg = clipSegment(to({ x: gx, y: cy - far, z: 0 }), to({ x: gx, y: cy + far, z: 0 }), rect);
    if (!seg) continue;
    const at = seg[0][1] >= seg[1][1] ? seg[0] : seg[1];
    ctx.fillText(gx.toFixed(dp), at[0], at[1] - 2);
  }

  // Y values: the end nearest the LEFT.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let i = -n; i <= n; i++) {
    const gy = cy + i * major;
    const seg = clipSegment(to({ x: cx - far, y: gy, z: 0 }), to({ x: cx + far, y: gy, z: 0 }), rect);
    if (!seg) continue;
    const at = seg[0][0] <= seg[1][0] ? seg[0] : seg[1];
    ctx.fillText(gy.toFixed(dp), at[0] + 3, at[1]);
  }

  // A three-armed gizmo at the origin, ONE GRID SQUARE long.
  //
  // One square rather than one labelled interval: at a 25 m grid the five-
  // square version reached further than the canvas and read as three more grid
  // lines rather than as a marker. Each arm keeps its own colour for the same
  // reason - at the house view the Z arm goes up the screen and the Y arm comes
  // down it, so in one colour they are a single line through the origin and say
  // nothing. Z matters most of the three: it is the only vertical reference in
  // the picture, the floor grid having none.
  ctx.font = 'bold 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1.6;
  const o = to({ x: 0, y: 0, z: 0 });
  for (const [label, end, colour] of [
    ['X', { x: step, y: 0, z: 0 }, CSSV.gizmoX],
    ['Y', { x: 0, y: step, z: 0 }, CSSV.gizmoY],
    ['Z', { x: 0, y: 0, z: step }, CSSV.gizmoZ],
  ] as Array<[string, Vec3, string]>) {
    const tip = to(end);
    ctx.strokeStyle = colour;
    line(ctx, o, tip);
    if (tip[0] < -20 || tip[1] < -10 || tip[0] > vp.width + 20 || tip[1] > vp.height + 10) continue;
    // A few pixels further along the arm, so the letter sits off the end of the
    // stick rather than on it. In PIXELS: an offset quoted in metres is a
    // different distance at every zoom, and at a 20 m grid the first version
    // put the Y seven metres off its own axis.
    const dx = tip[0] - o[0];
    const dy = tip[1] - o[1];
    const len = Math.hypot(dx, dy) || 1;
    ctx.fillStyle = colour;
    ctx.fillText(label, tip[0] + (dx / len) * 9, tip[1] + (dy / len) * 9);
  }
  ctx.restore();
}

/**
 * How long a metre is, bottom left.
 *
 * Unconditional, and the reason is the camera: the floor numbers sit on the
 * world axes and a camera panned away from the origin cannot see either of
 * them, so without this there are views of a rig with no scale on screen at
 * all. Orthographic, so one bar is honest everywhere in the picture — which is
 * the whole argument for the projection.
 */
function drawScaleBar(CSSV: ReturnType<typeof css>, ctx: CanvasRenderingContext2D, vp: Viewport3D, height: number) {
  const step = gridStepFor(vp.cam.scale);
  // Five grid squares, unless that is wider than a third of the viewport.
  const metres = step * 5 * vp.cam.scale > vp.width / 3 ? step : step * 5;
  const px = metres * vp.cam.scale;
  const x0 = 12;
  const y = height - 34;
  ctx.save();
  ctx.strokeStyle = CSSV.text;
  ctx.fillStyle = CSSV.text;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y - 4);
  ctx.lineTo(x0, y + 4);
  ctx.moveTo(x0, y);
  ctx.lineTo(x0 + px, y);
  ctx.moveTo(x0 + px, y - 4);
  ctx.lineTo(x0 + px, y + 4);
  ctx.stroke();
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${metres < 1 ? metres.toFixed(1) : metres.toFixed(0)} m`, x0, y - 6);
  ctx.restore();
}

/** Which way the camera is looking, and what the gold face means. */
function drawLegend(
  CSSV: ReturnType<typeof css>,
  ctx: CanvasRenderingContext2D,
  width: number,
  yawDeg: number,
  pitchDeg: number,
  frontLabel: string,
) {
  // Along the TOP, because the bottom strip belongs to the instruction line
  // and two of them in the same place is how the hint ended up unreadable.
  ctx.save();
  ctx.font = '11px ui-monospace, SFMono-Regular, monospace';
  ctx.textBaseline = 'top';
  ctx.fillStyle = CSSV.text;
  ctx.textAlign = 'right';
  ctx.fillText(`${yawDeg.toFixed(0)}° / ${pitchDeg.toFixed(0)}°`, width - 10, 11);
  ctx.textAlign = 'left';
  ctx.fillStyle = `rgb(${CSSV.cabinetFront.join(',')})`;
  ctx.fillRect(10, 11, 10, 10);
  ctx.fillStyle = CSSV.text;
  ctx.fillText(frontLabel, 26, 11);
  ctx.restore();
}
