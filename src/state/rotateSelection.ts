/**
 * Obrót ZAZNACZENIA jak jednej bryły.
 *
 * Cztery zaznaczone suby obracają się po okręgu wokół środka geometrycznego
 * zaznaczenia: każdy przesuwa się w X/Y o to, co wynika z obrotu jego
 * położenia wokół tego punktu, i każdy dostaje ten sam przyrost azymutu.
 * Dotąd każde wejście (klawisze [ ], uchwyt obrotu na płótnie, przyciski
 * i pole azymutu w Inspektorze) obracało skrzynie W MIEJSCU — rząd czterech
 * subów zamiast się obrócić, rozsuwał się w wachlarz.
 *
 * Środek liczony jest w świecie, po transformacji grupy (przesunięcie i obrót),
 * bo tam patrzy użytkownik; wynik wraca do współrzędnych własnych każdej
 * obudowy przez odwrotność transformacji jej grupy. Azymut, który się zapisuje,
 * jest własnym azymutem obudowy — obrót grupy zostaje offsetem na nim.
 *
 * Pozycja (wspólny positionKey) zaznaczona W CAŁOŚCI dostaje ten sam przyrost
 * swojego `positionYawDeg`, żeby przebudowa układu obróciła ją z powrotem
 * o tyle samo. Pozycja zaznaczona częściowo przestaje być prostym rzędem i jej
 * kąt zostaje, jak był.
 */
import type { Group, Source, Vec3 } from '../core/types';
import { rotateXY } from './resolve';

function toWorld(p: Vec3, g: Group | null): Vec3 {
  if (!g) return p;
  const r = rotateXY(p, g.anchor, g.rotationOffsetDeg);
  return { x: r.x + g.offset.x, y: r.y + g.offset.y, z: r.z + g.offset.z };
}

function toLocal(p: Vec3, g: Group | null): Vec3 {
  if (!g) return p;
  const shifted = { x: p.x - g.offset.x, y: p.y - g.offset.y, z: p.z - g.offset.z };
  return rotateXY(shifted, g.anchor, -g.rotationOffsetDeg);
}

/** Środek geometryczny zaznaczenia w świecie (X/Y), albo null dla pustego. */
export function selectionCentre(
  sources: Source[],
  groups: Group[],
  ids: string[],
): { x: number; y: number } | null {
  const byGroup = new Map(groups.map((g) => [g.id, g]));
  const chosen = new Set(ids);
  const picked = sources.filter((s) => chosen.has(s.id));
  if (!picked.length) return null;
  const w = picked.map((s) => toWorld(s.position, s.groupId ? byGroup.get(s.groupId) ?? null : null));
  return {
    x: w.reduce((t, p) => t + p.x, 0) / w.length,
    y: w.reduce((t, p) => t + p.y, 0) / w.length,
  };
}

/**
 * Obraca zaznaczone obudowy o `deltaDeg` (konwencja azymutu: zgodnie ze
 * wskazówkami zegara z góry) wokół środka zaznaczenia. Liczy zawsze OD
 * `sources` — przeciąganie podaje stan sprzed przeciągnięcia, więc kolejne
 * ruchy myszy nie sumują błędów. Zwraca całą listę.
 */
export function rotateSelection(
  sources: Source[],
  groups: Group[],
  ids: string[],
  deltaDeg: number,
): Source[] {
  const centre = selectionCentre(sources, groups, ids);
  if (!centre || !Number.isFinite(deltaDeg) || deltaDeg === 0) return sources;
  const byGroup = new Map(groups.map((g) => [g.id, g]));
  const chosen = new Set(ids);

  // pozycje zaznaczone w całości
  const keyed = new Map<string, { all: number; picked: number }>();
  for (const s of sources) {
    if (!s.positionKey) continue;
    const c = keyed.get(s.positionKey) ?? { all: 0, picked: 0 };
    c.all++;
    if (chosen.has(s.id)) c.picked++;
    keyed.set(s.positionKey, c);
  }
  const whole = (s: Source) => {
    const c = s.positionKey ? keyed.get(s.positionKey) : undefined;
    return !!c && c.picked === c.all;
  };

  const pivot = { x: centre.x, y: centre.y, z: 0 };
  return sources.map((s) => {
    if (!chosen.has(s.id)) return s;
    const g = s.groupId ? byGroup.get(s.groupId) ?? null : null;
    const world = rotateXY(toWorld(s.position, g), pivot, deltaDeg);
    const local = toLocal(world, g);
    const out: Source = {
      ...s,
      position: { x: local.x, y: local.y, z: s.position.z },
      rotation: { ...s.rotation, azimuthDeg: s.rotation.azimuthDeg + deltaDeg },
    };
    if (whole(s)) {
      // zwinięty do (-180, 180], jak pole „Obrót pozycji”
      const yaw = ((((s.positionYawDeg ?? 0) + deltaDeg + 180) % 360) + 360) % 360 - 180;
      out.positionYawDeg = Math.abs(yaw) < 1e-9 ? undefined : yaw === -180 ? 180 : yaw;
    }
    return out;
  });
}
