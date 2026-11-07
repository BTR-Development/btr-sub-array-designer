/**
 * Resolves the editable project model (sources + group transforms + speaker
 * library) into the flat EngineSource[] the simulation engine consumes.
 *
 * Group parameters are treated strictly as an OFFSET/TRANSFORM layer: a source
 * keeps its own position, level and delay untouched, so ungrouping is lossless.
 */

import type { Group, Source, Vec3 } from '../core/types';
import type { EngineSource } from '../engine/types';
import type { SpeakerDataProvider } from '../speakers/provider';
import { acousticOrigin, type SpeakerModel } from '../speakers/schema';

/**
 * The 1 m reference used when NOTHING in the project publishes a max SPL. It is
 * an arbitrary scale, not a measurement, and the interface must not print it as
 * one. Because every source then shares it, it cancels out of every level
 * DIFFERENCE on the map — which is the property the old comment here claimed
 * while the constant was in fact handed out one source at a time.
 */
export const UNGRADED_REF_SPL_DB = 130;

/** Which reference the ungraded sources of a project are driven to, and which they are. */
export interface ReferenceLevels {
  /** the 1 m reference handed to every source whose model publishes no max SPL */
  substituteDb: number;
  /**
   * The sources that got it. Non-empty means the ABSOLUTE scale of the map is
   * only partly published; it says nothing against the relative pattern, which
   * stays exact as long as the substitution is uniform.
   */
  substitutedSourceIds: string[];
}

/**
 * Decide the 1 m reference each source is driven to.
 *
 * `refSplDb` is not a caption, it is a DRIVE LEVEL: the engine turns
 * `refSplDb + levelDb` into a complex amplitude, and because the summation is
 * complex, a difference between two sources is an amplitude RATIO. It moves
 * nulls and reshapes the lobe — it does not merely relabel the colour bar.
 *
 * So the flat 130 dB placeholder was never neutral. Next to a KS28 (143 dB) or
 * an SL-SUB (144 dB) it drove a vendor-imported cabinet 13 to 14 dB down, 18 dB
 * in the worst pairing, and the array it belonged to predicted a gain structure
 * nobody had asked for.
 *
 * Nothing honest can be said about the output of a cabinet whose sensitivity
 * nobody publishes, so this does not invent one. What it refuses to invent is
 * the RATIO: an ungraded source is driven to the same reference as the loudest
 * graded cabinet in the same project — the equal-drive gain structure an
 * engineer sets at the amplifier — and when the project has no graded cabinet at
 * all they share `UNGRADED_REF_SPL_DB` and the relative map is exact.
 *
 * The LOUDEST rather than the mean or the median of the graded ratings, because
 * a mean is a decibel no cabinet in the project has, and because driving the
 * unknown cabinet DOWN is the failure mode that quietly removes it from the sum.
 *
 * Muted sources count toward the reference on purpose. Mute is a listening aid,
 * and a reference derived from the unmuted set only would change the level of
 * the cabinets that are still playing.
 */
export function referenceLevels(resolved: ResolvedSource[]): ReferenceLevels {
  let loudestGraded = -Infinity;
  const substitutedSourceIds: string[] = [];
  for (const r of resolved) {
    const published = r.model?.maxSpl;
    if (published == null) substitutedSourceIds.push(r.source.id);
    else loudestGraded = Math.max(loudestGraded, published);
  }
  return {
    substituteDb: isFinite(loudestGraded) ? loudestGraded : UNGRADED_REF_SPL_DB,
    substitutedSourceIds,
  };
}

/**
 * Turn a point about an anchor in the XY plane, IN THE SAME SENSE AS AZIMUTH.
 *
 * This is the whole subtlety of a group yaw, and it used to be wrong. A group
 * rotation moves two things: where each cabinet stands, and which way it faces.
 * The heading is turned by `azimuthDeg += deg`, and this program's azimuth is
 * clockwise-positive — `front = (sin az, cos az, sin el)`, so +90 takes the
 * front from +Y to +X. The matrix that agrees with it is
 *
 *   x' = dx*cos + dy*sin
 *   y' = -dx*sin + dy*cos
 *
 * The obvious one, `x' = dx*c - dy*s`, is its transpose: the counter-clockwise
 * rotation. With that in place the line of cabinets swung one way while every
 * cabinet aimed the other, so a group yaw was not a rigid-body rotation at all
 * and a 30 degree yaw steered the array to -28 degrees. Under no sign
 * convention can the two halves of one yaw disagree.
 */
export function rotateXY(p: Vec3, anchor: Vec3, deg: number): Vec3 {
  if (!deg) return p;
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const dx = p.x - anchor.x, dy = p.y - anchor.y;
  return {
    x: anchor.x + dx * c + dy * s,
    y: anchor.y - dx * s + dy * c,
    z: p.z,
  };
}

export interface ResolvedSource {
  source: Source;
  group: Group | null;
  model: SpeakerModel | undefined;
  /** world position after the group transform */
  position: Vec3;
  azimuthDeg: number;
  elevationDeg: number;
  rollDeg: number;
  levelDb: number;
  delayS: number;
  muted: boolean;
}

export function resolveSource(
  s: Source,
  group: Group | null,
  provider: SpeakerDataProvider,
): ResolvedSource {
  const model = provider.get(s.speakerId);
  let position = s.position;
  let azimuthDeg = s.rotation.azimuthDeg;
  let levelDb = s.levelDb;
  // Ukryty gradient kardioidy jest częścią delayu OBUDWY, nie kolumny
  // użytkownika — patrz Source.gradientDelayS. Doliczony tutaj, trafia tą
  // samą drogą do silnika, do Inspektora i do eksporterów vendorowych, więc
  // procesor dostaje liczbę, z którą rig naprawdę gra.
  let delayS = s.delayS + (s.gradientDelayS ?? 0);

  if (group) {
    position = rotateXY(s.position, group.anchor, group.rotationOffsetDeg);
    position = {
      x: position.x + group.offset.x,
      y: position.y + group.offset.y,
      z: position.z + group.offset.z,
    };
    azimuthDeg += group.rotationOffsetDeg;
    levelDb += group.levelOffsetDb;
    delayS += group.delayOffsetS;
  }

  return {
    source: s,
    group,
    model,
    position,
    azimuthDeg,
    elevationDeg: s.rotation.elevationDeg,
    rollDeg: s.rotation.rollDeg,
    levelDb,
    delayS,
    muted: s.mute || !!group?.mute,
  };
}

export function resolveAll(
  sources: Source[],
  groups: Group[],
  provider: SpeakerDataProvider,
): ResolvedSource[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  return sources.map((s) => resolveSource(s, s.groupId ? byId.get(s.groupId) ?? null : null, provider));
}

/** Only the audible sources, converted to the engine's input shape. */
export function toEngineSources(resolved: ResolvedSource[]): EngineSource[] {
  // Derived from the WHOLE resolved set, muted cabinets included: see
  // referenceLevels for why muting must not move anyone else's drive level.
  const refs = referenceLevels(resolved);
  const out: EngineSource[] = [];
  for (const r of resolved) {
    if (r.muted) continue;
    // The rear cabinet of a cardioid block (the reverse tool marks it with a
    // hidden gradient) plays its own preset where the model knows one.
    const pd =
      (r.source.gradientDelayS ?? 0) > 0 && r.model?.cardioidRearData
        ? r.model.cardioidRearData
        : r.model?.predictionData;
    out.push({
      id: r.source.id,
      position: r.position,
      azimuthDeg: r.azimuthDeg,
      elevationDeg: r.elevationDeg,
      rollDeg: r.rollDeg,
      levelDb: r.levelDb,
      delayS: r.delayS,
      invertPolarity: r.source.invertPolarity,
      refSplDb: r.model?.maxSpl ?? refs.substituteDb,
      elements: pd && pd.kind === 'elements' ? pd.elements : null,
      normaliseOnAxis: !!(pd && pd.kind === 'elements' && pd.normaliseOnAxis),
      balloon: pd && pd.kind === 'balloon' ? pd : undefined,
      // A cabinet radiates from its baffle, not from the handle in the middle
      // of the box, so a rotated cabinet radiates from somewhere else. Without
      // this a reversed sub is acoustically identical to an un-reversed one.
      originOffset: r.model ? acousticOrigin(r.model) : null,
    });
  }
  return out;
}
