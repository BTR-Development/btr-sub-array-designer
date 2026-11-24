/**
 * BTR project -> the neutral vendor source model shared by both exporters.
 *
 * COORDINATE FRAMES
 * -----------------
 * The neutral frame is BTR's own:
 *
 *   BTR  +X lateral,  +Y into the audience,  +Z up; azimuth 0 = +Y, clockwise
 *
 * Soundvision's ON-SCREEN frame is the same (measured, see
 * toSoundvisionGeometry), but its FILE is not: the XML stores (−x, z, y) of the
 * cluster's front-face bottom centre and the azimuth negated. Both adapters
 * therefore convert:
 *
 *   Soundvision: position = (−x_ref, z_bottom, y_ref)   orientation[1] = −yaw
 *   ArrayCalc:   OriginX =  y   OriginY = -x   OriginZ = z   HorizontalAngle = -yaw
 *
 * VERTICAL DATUM
 * --------------
 * A BTR position is the cabinet's geometric centre (the floor convention on
 * `centreZFromBottomFace`); a Soundvision cluster is measured from its bottom,
 * and in plan from the middle of its front face. The neutral model keeps BTR's
 * datum and each adapter applies its own:
 *
 *   Soundvision  bottom = centre − h/2, front = centre + d/2 along yaw   MEASURED
 *   ArrayCalc    OriginZ = centre           UNCONFIRMED — see toArrayCalcGeometry
 *
 * DELAY
 * -----
 * A BTR group's delay offset is the same idea as ArrayCalc's
 * `SourceGroups.RelativeDelay`, so it is carried separately rather than baked in:
 *
 *   ArrayCalc   RelativeDelay = groupRelativeDelayMs
 *               Cabinets.Delay = (designDelayMs + relative) / 1000   [seconds, TOTAL]
 *   Soundvision no group delay exists, so the total is baked into each cluster.
 *
 * Both routes therefore produce the same acoustic result.
 */

import type { BTRProject } from '../../core/types';
import { orientedDimensions } from '../../speakers/schema';
import { resolveAll } from '../../state/resolve';
import type { SpeakerDataProvider } from '../../speakers/provider';
import {
  soundvisionDeviceFor,
  arraycalcDeviceFor,
  gatedBehindNativeModels,
  type VendorTarget,
} from './deviceMap';

export interface VendorSource {
  id: string;
  name: string;
  /** BTR speaker id, used to pick the vendor device */
  btrSpeakerId: string;
  /** metres, neutral (= Soundvision) frame */
  x_m: number;
  y_m: number;
  z_m: number;
  /** degrees about the vertical axis */
  yaw_deg: number;
  pitch_deg: number;
  roll_deg: number;
  /** dB, source level plus any group level offset */
  gain_db: number;
  /** ms, the DESIGN delay — the number an operator types, without the group offset */
  delay_ms: number;
  /** +1 normal, -1 inverted */
  polarity: 1 | -1;
  muted: boolean;
  /**
   * metres, the cabinet's published height, or null when nobody publishes one.
   * Carried purely for the vertical datum: half a cabinet is the whole distance
   * between a BTR centre and a Soundvision ground, and the geometry adapters have
   * no speaker provider of their own. `toVendorModel` fills it in; a READER leaves
   * it undefined, because a vendor file names a model rather than a box and the
   * height is not resolved until `sceneToProject` maps that name onto a cabinet.
   */
  heightM?: number | null;
  /**
   * metres, the cabinet's depth (front baffle to back), or null when unpublished.
   * Soundvision measures a cluster from the centre of its FRONT face, not from
   * the box centre, so the Soundvision adapter needs half of it — see
   * toSoundvisionGeometry. Filled by toVendorModel, left undefined by readers.
   */
  depthM?: number | null;
  /**
   * Set by the Soundvision reader for a multi-enclosure cluster. Soundvision stores
   * one ground position per cluster and derives the vertical spacing itself, so the
   * per-box height is NOT in the file — the importer reconstructs it from the
   * cabinet height. Ignored by the exporters.
   */
  stack?: { index: number; count: number; /** 'row' = `horizontal_stacked`, side by side; default a pile */ layout?: 'row' | 'pile' };
  /**
   * Set by the Soundvision reader: x/y are the cluster's FRONT-FACE reference
   * (Soundvision's datum), not the box centre. The importer steps back half a
   * cabinet depth along yaw once it knows which cabinet this is.
   */
  frontRef?: boolean;
  /**
   * Przynależność do POZYCJI w BTR (Source.positionKey) — eksport Soundvision
   * składa z obudów jednej pozycji JEDEN klaster, tak jak Soundvision modeluje
   * stos subów. Brak = obudowa sama jest pozycją.
   */
  positionKey?: string;
  /**
   * Zaszyty gradient kardioidy tej obudowy, ms (Source.gradientDelayS). Już
   * wliczony w delay_ms; osobno, bo ścieżka z presetem kardioidalnym
   * Soundvision (KS28_60_C_R) realizuje gradient SAMA i nie może go dostać
   * drugi raz.
   */
  gradient_ms?: number;
  /**
   * The cluster this cabinet came out of, when a READER made it.
   *
   * A Soundvision cluster is a STACK — one physical pile of boxes with one
   * ground position — and a multi-enclosure one expands into several BTR
   * cabinets. Without this they arrive as loose boxes that happen to share a
   * coordinate, and the thing the operator built as one object has to be
   * re-selected by hand before it can be moved. Carried so the importer can
   * put each stack back together as its own module.
   */
  cluster?: { id: string; name: string; size: number };
  /**
   * Set by a READER for a cabinet the file says is TURNED ROUND inside its
   * cluster — Soundvision marks it with a `*_cardioid` enclosure configuration
   * and an `..._C_R` preset.
   *
   * It is not in the geometry. The cluster carries one orientation for all its
   * enclosures, so read off the coordinates alone a cardioid block of four
   * arrives as four cabinets all facing the audience: the one thing the block
   * exists for, silently gone.
   *
   * Ustawiane też przez toVendorModel przy EKSPORCIE: odwrócona polaryzacja
   * ORAZ kierunek o ponad 90° od przodu pozycji (przód = obudowy
   * nieodwrócone, ta sama reguła co forwardHeadingOf). Cały rig z odwróconą
   * fazą nie jest kardioidą, więc nic w nim nie jest "odwrócone".
   */
  reversed?: boolean;
}

export interface VendorModel {
  projectName: string;
  groupName: string;
  /** ms — ArrayCalc's Delay (rel.); baked into each cluster for Soundvision */
  groupRelativeDelayMs: number;
  sources: VendorSource[];
}

export interface ExportDiagnostics {
  errors: string[];
  warnings: string[];
  /** one line per BTR model that was replaced by a different vendor product */
  substitutions: string[];
}

/**
 * Flatten a BTR project into the neutral model.
 *
 * Group transforms are resolved first, so positions and rotations are absolute —
 * neither vendor writer applies a group offset.
 */
export function toVendorModel(
  project: BTRProject,
  provider: SpeakerDataProvider,
): VendorModel {
  const resolved = resolveAll(project.sources, project.groups, provider);

  // ArrayCalc has exactly one relative delay per sub group. If the BTR project has
  // several groups with different offsets we cannot represent that, so the most
  // common non-zero offset wins and the rest is baked into the sources (warned about
  // in validate()).
  const offsets = project.groups.map((g) => g.delayOffsetS * 1000).filter((v) => v !== 0);
  const groupRelativeDelayMs = offsets.length ? offsets[0] : 0;

  const sources: VendorSource[] = resolved.map((r) => {
    // r.delayS already includes this source's own group offset. Strip the single
    // offset we export separately; any difference (a second group with a different
    // offset) stays inside the design delay, so the TOTAL is always preserved.
    const totalMs = r.delayS * 1000;
    const designMs = totalMs - groupRelativeDelayMs;

    return {
      id: r.source.id,
      name: r.source.label,
      btrSpeakerId: r.source.speakerId,
      x_m: r.position.x,
      y_m: r.position.y,
      z_m: r.position.z,
      yaw_deg: r.azimuthDeg,
      pitch_deg: r.elevationDeg,
      roll_deg: r.rollDeg,
      gain_db: r.levelDb,
      delay_ms: round1(designMs),
      polarity: r.source.invertPolarity ? -1 : 1,
      muted: r.muted,
      // The ORIENTED height, not the datasheet one. Half a cabinet is the
      // whole distance between a BTR centre and a Soundvision ground, and a
      // cabinet on its end face is a different half: a rolled KS21 exported
      // against its published 0.571 m landed 0.097 m off the deck.
      heightM: r.model ? orientedDimensions(r.model, r.rollDeg).heightM : null,
      depthM: r.model ? orientedDimensions(r.model, r.rollDeg).depthM : null,
      positionKey: r.source.positionKey
        ? `${r.source.groupId ?? ''}|${r.source.positionKey}`
        : undefined,
      gradient_ms: round1((r.source.gradientDelayS ?? 0) * 1000),
    };
  });

  // Które obudowy są ODWRÓCONE w swojej pozycji. Przód pozycji to kierunek
  // jej obudów nieodwróconych (polaryzacja rozstrzyga — forwardHeadingOf);
  // pozycja bez żadnej nieodwróconej obudowy to rig z odwróconą fazą, nie
  // kardioida, więc nic w niej nie jest "odwrócone".
  const byPos = new Map<string, VendorSource[]>();
  for (const v of sources) {
    const k = v.positionKey ?? `solo|${v.id}`;
    const got = byPos.get(k);
    if (got) got.push(v);
    else byPos.set(k, [v]);
  }
  for (const members of byPos.values()) {
    const upright = members.filter((m) => m.polarity !== -1);
    if (!upright.length) continue;
    const fwd = upright[0].yaw_deg;
    for (const m of members) {
      const d = ((((m.yaw_deg - fwd) % 360) + 360) % 360);
      m.reversed = m.polarity === -1 && (d > 180 ? 360 - d : d) > 90;
    }
  }


  return {
    projectName: project.project.name || 'BTR export',
    groupName: project.groups[0]?.name || 'SUBS',
    groupRelativeDelayMs: round1(groupRelativeDelayMs),
    sources,
  };
}

/** ArrayCalc and Soundvision both show delay at 0.1 ms; match what the operator sees. */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Neutral -> ArrayCalc geometry. Inverse of the confirmed Soundvision mapping in the
 * horizontal plane.
 *
 * OriginZ deliberately gets the BTR centre unshifted. That OriginZ is the vertical
 * axis is confirmed; which face of the cabinet d&b measures it from is not, and this
 * project does not guess at a vendor's convention in either direction. The importer
 * makes the same choice and says so, and so does validateForTarget.
 */
export function toArrayCalcGeometry(s: VendorSource) {
  return {
    originX: s.y_m, // depth   — sign unverified, see docs
    originY: -s.x_m, // lateral — CONFIRMED
    originZ: s.z_m, // height  — axis CONFIRMED, datum face UNCONFIRMED
    horizontalAngle: -s.yaw_deg, // CONFIRMED
  };
}

/**
 * Neutral -> Soundvision geometry, MEASURED in Soundvision (22–24.10.2026) by
 * opening crafted files and reading the Position/Azimuth fields back:
 *
 *   XML position (1, 2, 3)  ->  UI X −1, Y 3, Z 2
 *   XML orientation[1] 30   ->  UI azimuth −30
 *
 * The UI frame itself is BTR's frame — X lateral, Y depth, boxes at azimuth 0
 * face +Y, azimuth positive clockwise from above — so the file stores
 *
 *   position    = (−x, z_bottom, y)      of the reference point
 *   orientation = (0, −azimuth, 0)
 *
 * and the reference point is the centre of the cluster's FRONT face at its
 * BOTTOM: the body extends behind it. The previous identity mapping put every
 * export mirrored left-for-right with height and depth swapped — the
 * hand-corrected "perfect" file was built on top of exactly that mirror.
 *
 * An unpublished height is not halved and an unpublished depth is not stepped,
 * for the same reason as on import: half of an unknown box is unknown.
 */
export function toSoundvisionGeometry(s: VendorSource) {
  const bottomZ = s.heightM == null ? s.z_m : s.z_m - s.heightM / 2;
  const a = (s.yaw_deg * Math.PI) / 180;
  const half = s.depthM == null ? 0 : s.depthM / 2;
  return svPlacement(s.x_m + half * Math.sin(a), s.y_m + half * Math.cos(a), bottomZ, s.yaw_deg);
}

/** A front-face reference in BTR terms -> the XML numbers. */
export function svPlacement(refX: number, refY: number, bottomZ: number, azimuthDeg: number) {
  return {
    position: [nz(-refX), bottomZ, refY] as [number, number, number],
    orientation: [0, nz(-azimuthDeg), 0] as [number, number, number],
  };
}

/** Inverse of svPlacement: XML numbers -> front-face reference in BTR terms. */
export function fromSvPlacement(position: number[], orientation: number[]) {
  return { refX: nz(-(position[0] ?? 0)), refY: position[2] ?? 0, bottomZ: position[1] ?? 0, azimuthDeg: nz(-(orientation[1] ?? 0)) };
}

/** −0 out of the file and the tests */
function nz(v: number): number {
  return v === 0 ? 0 : v;
}

/**
 * Check a model against a target BEFORE writing anything.
 * Errors mean "do not write a file"; warnings mean "the target cannot carry this".
 */
export function validateForTarget(
  model: VendorModel,
  target: VendorTarget,
  nativeModels = false,
): ExportDiagnostics {
  const errors: string[] = [];
  const warnings: string[] = [];
  const substitutions: string[] = [];

  const active = model.sources.filter((s) => !s.muted);
  if (!active.length) {
    errors.push('No unmuted sources to export.');
    return { errors, warnings, substitutions };
  }

  const ids = new Set<string>();
  for (const s of model.sources) {
    if (ids.has(s.id)) errors.push(`Duplicate source id "${s.id}".`);
    ids.add(s.id);
  }

  // device substitutions, reported once per BTR model
  const seen = new Map<string, number>();
  for (const s of active) seen.set(s.btrSpeakerId, (seen.get(s.btrSpeakerId) ?? 0) + 1);
  for (const [btrId, count] of seen) {
    const choice =
      target === 'soundvision'
        ? soundvisionDeviceFor(btrId, nativeModels)
        : arraycalcDeviceFor(btrId);
    if (!choice.isEquivalent) {
      // Two different reasons land here and they need different sentences. A
      // model with no entry at all genuinely has no equivalent. A model that HAS
      // one, withheld because its preset string was never confirmed, is a
      // different message: the equivalent exists, it is just not being written.
      // Saying "no equivalent" for that case sends the user looking for a
      // product that is right there behind a checkbox.
      substitutions.push(
        gatedBehindNativeModels(target, btrId, nativeModels)
          ? `${count} × "${btrId}" is exported as ${choice.device.model}: its own preset string has never been confirmed against a real vendor file. Enable native models to write it anyway.`
          : `${count} × "${btrId}" has no ${target === 'soundvision' ? 'L-Acoustics' : 'd&b'} equivalent: exported as ${choice.device.model}.`,
      );
    } else if (!choice.device.verified) {
      warnings.push(
        `"${btrId}" is exported as ${choice.device.model}, whose preset/id string has never been confirmed against a real vendor file.`,
      );
    }
  }

  // things neither format carries
  if (model.sources.some((s) => s.pitch_deg)) {
    warnings.push('Pitch is not writable in either format: it is dropped, only yaw is exported.');
  }
  // Roll used to be lumped in with pitch as a rounding error. It is not one any
  // more: a cabinet rolled onto its end face has its width and its height
  // swapped, so dropping the roll does not merely lose an aim, it exports a box
  // of the wrong shape standing in the wrong place. Neither format has a field
  // for it, so the only honest thing is to name the consequence.
  // Only a roll that actually changes the box. Upside down is still the
  // published width and height, so saying they come out "the other way round"
  // for a 180 degree roll describes a change the export does not make.
  const rolled = model.sources.filter((s) => {
    const r = (((s.roll_deg % 180) + 180) % 180);
    return Math.min(r, 180 - r) > 0.5;
  });
  if (rolled.length) {
    warnings.push(
      `${rolled.length} cabinet${rolled.length === 1 ? ' is' : 's are'} rolled about the front axis ` +
        'and neither format can carry it. They are exported upright, so a cabinet on its end face ' +
        'arrives with its width and height the other way round. Check the elevation after importing.',
    );
  }
  if (model.sources.some((s) => s.muted)) {
    warnings.push(
      target === 'arraycalc'
        ? 'Muted sources are exported with the Mute flag set.'
        : 'Muted sources are exported as normal clusters: Soundvision mute is not written.',
    );
  }
  if (target === 'arraycalc' && model.sources.some((s) => s.polarity === -1)) {
    warnings.push('ArrayCalc .dbpr has no per-cabinet polarity field: polarity inversion is dropped.');
  }
  if (target === 'soundvision' && model.sources.some((s) => Math.abs(s.y_m) > 1e-9)) {
    warnings.push(
      'Sources have a non-zero depth (Y). The depth axis is the one part of the coordinate mapping that was never exercised by a reference file, check depth after importing.',
    );
  }
  if (target === 'soundvision') {
    const unseated = [...new Set(active.filter((s) => s.heightM == null).map((s) => s.btrSpeakerId))];
    if (unseated.length) {
      warnings.push(
        `No cabinet height is published for ${unseated.join(', ')}, so ${unseated.length === 1 ? 'it' : 'they'} ` +
          'could not be referenced to the ground a Soundvision cluster is measured from. The centre ' +
          'height BTR holds is written instead. Check the side view after importing.',
      );
    }
  }
  if (target === 'arraycalc') {
    warnings.push(
      'Cabinet heights are written as BTR holds them, at the cabinet centre. ArrayCalc stores a ' +
        'vertical origin but not which face of the cabinet it measures, so a ground-stacked rig may ' +
        'land half a box out; check the heights after importing.',
    );
  }
  if (target === 'soundvision' && model.groupRelativeDelayMs !== 0) {
    warnings.push(
      `Soundvision has no group delay, so the module's ${model.groupRelativeDelayMs.toFixed(1)} ms common offset is baked into every cluster.`,
    );
  }

  return { errors, warnings, substitutions };
}
