/**
 * Neutral VendorScene -> BTR project.
 *
 * This is where vendor products become BTR speakers, and where anything the file
 * could not tell us is reported rather than filled in with a plausible number.
 */

import { BRANDING } from '../../branding';
import {
  defaultSimulationSettings,
  type BTRProject,
  type Group,
  type Source,
} from '../../core/types';
import type { SpeakerDataProvider } from '../../speakers/provider';
import { UNKNOWN_BOX, acousticOrigin, orientedDimensions, type SpeakerModel } from '../../speakers/schema';
import type { VendorScene } from './importTypes';
import { resolveVendorModel } from './reverseDeviceMap';
import { speedOfSoundFromTemp } from '../../core/types';

export interface ImportDiagnostics {
  warnings: string[];
  /** device-level notes: what each vendor model became */
  mapping: string[];
}

export interface ImportResult {
  project: BTRProject;
  diagnostics: ImportDiagnostics;
  stats: { sources: number; groups: number; placeholders: number };
}

/** Pad the prediction area around whatever was imported. */
function areaFor(sources: Source[]) {
  const d = defaultSimulationSettings();
  if (!sources.length) return d.area;
  const xs = sources.map((s) => s.position.x);
  const ys = sources.map((s) => s.position.y);
  const halfWidth = Math.max(12, (Math.max(...xs) - Math.min(...xs)) * 1.4);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const front = Math.max(...ys);
  return {
    xMin: Math.round(cx - halfWidth),
    xMax: Math.round(cx + halfWidth),
    vMin: Math.round(Math.min(...ys) - 6),
    vMax: Math.round(front + Math.max(30, halfWidth * 1.6)),
    planeOffset: 0,
  };
}

export function sceneToProject(
  scene: VendorScene,
  selectedGroupIds: string[],
  provider: SpeakerDataProvider,
): ImportResult {
  const warnings = [...scene.warnings];
  const mapping: string[] = [];
  const placeholders = new Map<string, SpeakerModel>();
  const counts = new Map<string, { count: number; note?: string }>();

  const chosen = scene.groups.filter((g) => selectedGroupIds.includes(g.id));
  const sources: Source[] = [];
  const groups: Group[] = [];
  /** vendor model -> was any of its cabinets part of a stack; see the seating block below */
  const unseated = new Map<string, boolean>();
  /** vendor models with no published depth, left on Soundvision's front-face datum */
  const unstepped = new Set<string>();
  // The gradient delay is a distance over a speed, and the file names no
  // temperature. 20 C is the project default and the number every other
  // preset is built at; the warning below says the figure was computed.
  const speedOfSound = speedOfSoundFromTemp(20);
  /** models whose turned-round cabinets were given a computed gradient delay */
  const computedGradients = new Set<string>();
  /** ...and those that could not be, because nobody publishes a depth */
  const unknownGradients = new Set<string>();

  chosen.forEach((g, gi) => {
    const groupId = `grp_import_${gi}`;
    const blankGroup = (id: string, name: string): Group => ({
      id,
      name,
      offset: { x: 0, y: 0, z: 0 },
      rotationOffsetDeg: 0,
      anchor: { x: 0, y: 0, z: 0 },
      levelOffsetDb: 0,
      // ArrayCalc's Delay (rel.) maps straight onto a BTR module offset
      delayOffsetS: g.relativeDelayMs / 1000,
      mute: false,
    });

    /*
     * A STACK COMES IN AS ONE THING
     *
     * A Soundvision cluster of several enclosures is one physical pile with one
     * ground position — a cardioid block of four KS28 is a cluster, not four
     * cabinets that happen to share a coordinate. Expanded into loose sources
     * it arrived as four boxes the operator had to re-select by hand before
     * they could move what they had built as one object, and nothing recorded
     * that they belonged together.
     *
     * So each multi-enclosure cluster becomes its own module, and the vendor
     * group keeps only the single-box clusters. A file of several stacks
     * therefore imports as a group of stacks, which is how it was drawn.
     */
    const stackIds = new Map<string, string>();
    for (const vs of g.sources) {
      const c = vs.cluster;
      if (!c || c.size < 2 || stackIds.has(c.id)) continue;
      const id = `grp_import_${gi}_stack_${stackIds.size}`;
      stackIds.set(c.id, id);
      groups.push(blankGroup(id, c.name || `STACK ${stackIds.size}`));
    }
    // Pushed only if anything is left for it: a file whose every cluster is a
    // stack would otherwise import an empty module, which is saved, exported
    // and impossible to see.
    const loose = g.sources.some((vs) => !vs.cluster || vs.cluster.size < 2);
    if (loose) groups.push(blankGroup(groupId, g.name || `GROUP ${gi + 1}`));

    g.sources.forEach((vs, si) => {
      const resolved = resolveVendorModel(
        vs.btrSpeakerId,
        scene.format,
        (id) => provider.get(id) !== undefined,
        placeholders,
      );
      const key = vs.btrSpeakerId || '(unnamed)';
      const entry = counts.get(key) ?? { count: 0, note: resolved.note };
      entry.count++;
      if (resolved.note) entry.note = resolved.note;
      counts.set(key, entry);

      /*
       * WHERE THE CABINET SITS
       *
       * A BTR position is the cabinet's geometric CENTRE (see the floor
       * convention on `centreZFromBottomFace`). A Soundvision cluster position is
       * the GROUND height of the whole stack, and the file does not store the
       * per-box height at all, so both numbers are rebuilt from the cabinet:
       *
       *   centre of box i = ground + h/2 + i * h
       *
       * The h/2 is the half that used to be missing. Every imported cabinet was
       * seated half a box into the deck — for a KS28 that is 0.275 m, and side
       * view is the first place an engineer looks after an import.
       */
      const model = placeholders.get(key) ?? provider.get(resolved.speakerId);
      // Oriented: a row of KS28 on their sides is as tall as a KS28 is wide.
      const dims = model ? orientedDimensions(model, vs.roll_deg) : null;
      const heightM = dims?.heightM ?? null;
      let x = vs.x_m;
      let y = vs.y_m;
      let z = vs.z_m;
      if (scene.format === 'soundvision') {
        const a = (vs.yaw_deg * Math.PI) / 180;
        if (vs.stack?.layout === 'row') {
          // Side by side, #1 at the cluster's +X end (its right hand facing
          // the audience), so box i sits ((n−1)/2 − i) widths from the middle.
          if (heightM == null) unseated.set(key, !!unseated.get(key));
          else z += heightM / 2;
          const off = ((vs.stack.count - 1) / 2 - vs.stack.index) * (dims?.widthM ?? UNKNOWN_BOX.widthM);
          x += off * Math.cos(a);
          y -= off * Math.sin(a);
        } else {
          if (heightM == null) unseated.set(key, !!vs.stack || !!unseated.get(key));
          else z += heightM / 2;
          if (vs.stack) z += vs.stack.index * (heightM ?? UNKNOWN_BOX.heightM);
        }
        // The file measures from the middle of the FRONT face; BTR from the box.
        if (vs.frontRef) {
          const d = dims?.depthM ?? null;
          if (d == null) unstepped.add(key);
          else {
            x -= (d / 2) * Math.sin(a);
            y -= (d / 2) * Math.cos(a);
          }
        }
      }

      if (vs.gain_db > 0) {
        warnings.push(`"${vs.name}" has a positive gain (${vs.gain_db} dB); BTR treats 0 dB as nominal.`);
      }

      /*
       * A CABINET THE FILE SAYS IS TURNED ROUND
       *
       * Soundvision keeps one orientation per cluster, so the half-turn on a
       * cardioid enclosure is not in the geometry at all — it is in the
       * enclosure's configuration and in the amplifier preset. Imported from
       * the coordinates alone, a cardioid block arrived as four cabinets all
       * facing the audience and the thing it was built for was gone.
       *
       * The polarity and the half-turn are what the file MEANS, so they are
       * written. The gradient delay is not in the file either and cannot be —
       * it lives in the amplifier — so it is COMPUTED from the cabinet's own
       * depth, which is the only separation there is, and the import says so
       * rather than leaving a block that looks right and nulls nowhere.
       */
      const reversed = !!vs.reversed;
      let delayS = vs.delay_ms / 1000;
      if (reversed) {
        const span = model ? 2 * Math.abs(acousticOrigin(model).y) : 0;
        if (span > 0) {
          delayS += span / speedOfSound;
          computedGradients.add(key);
        } else {
          unknownGradients.add(key);
        }
      }

      sources.push({
        id: `src_import_${gi}_${si}`,
        label: vs.name || `SUB ${String(si + 1).padStart(2, '0')}`,
        speakerId: resolved.speakerId,
        position: { x, y, z },
        rotation: { azimuthDeg: vs.yaw_deg + (reversed ? 180 : 0), elevationDeg: 0, rollDeg: vs.roll_deg },
        levelDb: vs.gain_db,
        delayS,
        invertPolarity: reversed || vs.polarity === -1,
        mute: vs.muted,
        groupId: (vs.cluster && stackIds.get(vs.cluster.id)) ?? groupId,
      });
    });
  });

  if (unstepped.size) {
    warnings.push(
      `${[...unstepped].join(', ')} publishes no depth. Soundvision places a cluster by the middle ` +
        'of its front face, so these cabinets sit half a box further forward than in Soundvision. ' +
        'Assign a library cabinet in the Inspector to get real geometry.',
    );
  }
  if (computedGradients.size) {
    warnings.push(
      `The file marks ${[...computedGradients].join(', ')} cabinets as turned round inside their ` +
        'cluster but carries no delay for them: in Soundvision the cardioid processing lives in ' +
        'the amplifier preset, not in the project. They were imported reversed and inverted, with ' +
        'the gradient delay computed from the cabinet depth over the speed of sound. Check it ' +
        'against the preset actually loaded on the rig.',
    );
  }
  if (unknownGradients.size) {
    warnings.push(
      `${[...unknownGradients].join(', ')} is turned round inside its cluster and publishes no ` +
        'depth, so no gradient delay could be computed. It was imported reversed and inverted ' +
        'with the delay the file carries, which will not produce a rear null.',
    );
  }

  for (const [key, stacked] of unseated) {
    warnings.push(
      `"${key}" has no known cabinet height, so it could not be seated on the deck: its centre sits ` +
        `at the height the file gives, where the bottom face belongs` +
        (stacked ? `, and the stack was spaced by a nominal ${UNKNOWN_BOX.heightM} m` : '') +
        '. Assign a library cabinet in the Inspector to get real geometry.',
    );
  }

  /*
   * ArrayCalc is NOT given the same treatment, because nobody has confirmed what
   * its height means. `OriginZ` is confirmed to be the vertical axis; which face
   * of the cabinet it measures is not, and this project does not guess at a
   * vendor's convention. If d&b measures the bottom face as L-Acoustics does, a
   * ground-stacked .dbpr imports half a box low — visible in side view, and
   * fixable the day someone can open a file in real ArrayCalc.
   */
  if (scene.format === 'arraycalc' && sources.length) {
    warnings.push(
      'ArrayCalc stores each cabinet height but not which face of the cabinet it measures, so the ' +
        'heights were taken as cabinet centres. A ground-stacked rig may therefore sit half a box ' +
        'low; check the side view.',
    );
  }

  for (const [vendorModel, info] of counts) {
    const ph = placeholders.get(vendorModel);
    mapping.push(
      ph
        ? `${info.count} × ${vendorModel} → imported as a placeholder (dimensions unknown)`
        : `${info.count} × ${vendorModel} → BTR library cabinet${info.note ? ` (${info.note})` : ''}`,
    );
  }

  const customSpeakers = [...placeholders.values()];
  if (customSpeakers.length) {
    warnings.push(
      `${customSpeakers.length} cabinet type(s) are not in the BTR library. They were imported with ` +
        'unknown dimensions and an omnidirectional model. Assign a library cabinet in the Inspector ' +
        'to get real geometry.',
    );
  }

  const sim = defaultSimulationSettings();
  sim.area = areaFor(sources);

  return {
    project: {
      format: BRANDING.formatId,
      version: BRANDING.formatVersion,
      project: {
        name: scene.projectName || `Imported ${scene.format === 'soundvision' ? 'Soundvision' : 'ArrayCalc'} project`,
        notes: `Imported from ${scene.format === 'soundvision' ? 'L-Acoustics Soundvision' : 'd&b ArrayCalc'}.`,
        createdAt: new Date().toISOString(),
      },
      sources,
      groups,
      measurementPoints: [],
      simulationSettings: sim,
      customSpeakers,
    },
    diagnostics: { warnings, mapping },
    stats: { sources: sources.length, groups: groups.length, placeholders: customSpeakers.length },
  };
}
