/**
 * Example rigs — TEST FIXTURES, not a user-facing feature.
 *
 * The Presets menu holds only what the user saved. These rigs serve the tests: the smoke suite mounts every one of them, the cardioid
 * suite measures the KS28 blocks against their published ceilings, and the
 * floor-convention tests read their geometry. Nothing in src/ui imports this
 * file, so none of it ships in the application path.
 *
 * A rig only ever sets PARAMETERS — positions, delays, levels, polarity.
 * None of them describe or hard-code the resulting pattern; every lobe you see
 * comes out of the simulation engine.
 */

import {
  defaultSimulationSettings,
  speedOfSoundFromTemp,
  type MeasurementPoint,
  type SimulationSettings,
  type Source,
} from '../core/types';
import { steeringDelays } from '../engine/steering';
import { BUILTIN_SPEAKERS } from '../speakers/library';
import { acousticOrigin, centreZFromBottomFace } from '../speakers/schema';
import type { Doc } from './store';
import { makeSource } from './store';
import { buildKs28Block, KS28_BLOCKS, type Ks28Block } from './ks28Blocks';

export interface ExampleRig {
  id: string;
  name: string;
  description: string;
  build: () => { doc: Doc; sim: SimulationSettings };
}

const C20 = speedOfSoundFromTemp(20);

/**
 * How far in front of its own handle a cabinet radiates. Only the presets that
 * turn a cabinet round need it: when every box faces the same way the offset is
 * the same vector on all of them and cancels out of every path difference.
 */
function originY(speakerId: string): number {
  const m = BUILTIN_SPEAKERS.find((x) => x.id === speakerId);
  return m ? acousticOrigin(m).y : 0;
}

/**
 * Where the centre of a cabinet goes when it is standing on the deck.
 *
 * A position is the geometric centre (the floor convention on
 * `centreZFromBottomFace`), so a ground-stacked preset is at z = h/2, not z = 0.
 * Every preset but the flown column used to ship at z = 0, which buried half of
 * each box under the deck the moment anyone switched to side view — and the demo
 * project is the first thing a new user opens.
 *
 * The fallback is unreachable: every cabinet a preset names is curated and
 * publishes a height. It is here so that adding a preset for a cabinet that does
 * not cannot silently produce a NaN position.
 */
function deckZ(speakerId: string): number {
  const m = BUILTIN_SPEAKERS.find((x) => x.id === speakerId);
  return (m ? centreZFromBottomFace(m) : null) ?? 0;
}

function doc(sources: Source[], points: MeasurementPoint[] = [], name = 'Preset'): Doc {
  return {
    project: { name, createdAt: new Date().toISOString() },
    sources,
    groups: [],
    measurementPoints: points,
    customSpeakers: [],
  };
}

function sim(over: Partial<SimulationSettings> = {}): SimulationSettings {
  return { ...defaultSimulationSettings(), ...over };
}

function line(
  speakerId: string,
  count: number,
  spacing: number,
  y = 0,
  axis: 'x' | 'y' = 'x',
): Source[] {
  const start = -((count - 1) * spacing) / 2;
  const z = deckZ(speakerId);
  return Array.from({ length: count }, (_, i) =>
    makeSource(speakerId, `SUB ${String(i + 1).padStart(2, '0')}`, {
      x: axis === 'x' ? start + i * spacing : 0,
      y: axis === 'y' ? start + i * spacing : y,
      z,
    }),
  );
}

const REF = 'btr-ref-omni-18';

const AUDIENCE_POINTS: MeasurementPoint[] = [
  { id: 'mp_foh', name: 'FOH', position: { x: 0, y: 28, z: 1.6 } },
  { id: 'mp_left', name: 'LEFT EDGE', position: { x: -20, y: 15, z: 1.6 } },
  { id: 'mp_right', name: 'RIGHT EDGE', position: { x: 20, y: 15, z: 1.6 } },
  { id: 'mp_back', name: 'BACK', position: { x: 0, y: 42, z: 1.6 } },
  { id: 'mp_stage', name: 'STAGE', position: { x: 0, y: -4, z: 1.6 } },
];

/**
 * The seven KS28 cardioid blocks, as presets.
 *
 * Each one builds its cabinets through `buildKs28Block`, which computes the
 * gradient delay from the cabinet's own geometry rather than copying a number. See `state/ks28Blocks.ts`.
 *
 * The orientation and layout variants are NOT separate presets. They are the
 * Orientation control and the layout axis, because seven blocks times
 * three variants is a list nobody can read.
 */
function ks28BlockRig(block: Ks28Block, note: string): ExampleRig {
  return {
    id: `ks28-${block.id}`,
    name: `KS28 ${block.label}: ${block.rows.map((r) => r.join('')).join(' / ')}`,
    description: note,
    build: () => {
      const built = buildKs28Block(block, {
        speedOfSound: C20,
        deckZ: 0,
        makeSource: (id, lbl, pos) => makeSource(id, lbl, pos),
        label: (i) => `KS28 ${String(i + 1).padStart(2, '0')}`,
      });
      return {
        doc: doc(built.sources, AUDIENCE_POINTS, `KS28 ${block.label}`),
        sim: sim({ frequencyHz: 63, quality: 'normal' }),
      };
    },
  };
}

/**
 * What each block actually measures, front to back, over 31.5-125 Hz.
 *
 * Written here because it is the thing an operator needs before choosing one
 * and the name does not say it. Measured in `ks28Blocks.test.ts` with the KS28 as
 * an analytical omnidirectional model, front to back at 30 m.
 */
const KS28_BLOCK_NOTES: Record<string, string> = {
  no1: '3 KS28 facing the audience and 1 turned round at the right-hand end, touching. Analytical model: 2.1 / 4.6 / 6.2 dB of rear rejection at 31.5 / 63 / 125 Hz.',
  'no1-1': 'As NO.1 with the reversed cabinet one place in from the end: 2.0 / 4.4 / 6.3 dB. What changes is the lateral pattern, not the rear rejection.',
  no2: '2 facing the audience and 1 turned round at the end. Analytical model: 4.1 / 7.7 / 9.9 dB at 31.5 / 63 / 125 Hz.',
  'no2-1': 'As NO.2 with the reversed cabinet in the middle: 4.0 / 7.5 / 9.9 dB, different lateral pattern.',
  no3: 'One facing the audience and one turned round. Matched groups, so the analytical model shows a deep null: 30.6 / 35.8 / 38.4 dB at 31.5 / 63 / 125 Hz. That is the ideal case; a real cabinet has its own front-to-back response, which this model leaves out.',
  no4: 'Two columns of two, touching: the left pair both facing the audience, the right pair forward over reversed. Analytical model: 2.1 / 4.5 / 6.3 dB at 31.5 / 63 / 125 Hz.',
  'no4-2': 'As NO.4 with the reversed cabinet at the TOP of the right-hand column: 2.0 / 4.5 / 6.3 dB. The vertical position of the reversed box tilts the null rather than deepening it.',
};

export const EXAMPLE_RIGS: ExampleRig[] = [
  {
    id: 'single',
    name: 'Single Sub',
    description: 'One omnidirectional cabinet. The reference case for the 1/r law.',
    build: () => ({
      doc: doc([makeSource(REF, 'SUB 01', { x: 0, y: 0, z: deckZ(REF) })], AUDIENCE_POINTS, 'Single Sub'),
      sim: sim({ frequencyHz: 63 }),
    }),
  },
  {
    id: 'two',
    name: 'Two Subs',
    description: 'Two omni cabinets 4 m apart, the classic power-alley / lobing demonstration.',
    build: () => ({
      doc: doc(line(REF, 2, 4), AUDIENCE_POINTS, 'Two Subs'),
      sim: sim({ frequencyHz: 63 }),
    }),
  },
  {
    id: 'broadside',
    name: 'Broadside Array',
    description: '8 cabinets evenly spaced along X. Wide horizontal coverage with side lobes above the aliasing frequency.',
    build: () => ({
      doc: doc(line(REF, 8, 2), AUDIENCE_POINTS, 'Broadside Array'),
      sim: sim({ frequencyHz: 63 }),
    }),
  },
  {
    id: 'endfire',
    name: 'End-Fire',
    description:
      '4 cabinets stacked front-to-back 1.4 m apart, each progressively delayed by its own spacing so the rear lobe cancels.',
    build: () => {
      const n = 4;
      const d = 1.4;
      const sources = Array.from({ length: n }, (_, i) => {
        const s = makeSource(REF, `SUB ${String(i + 1).padStart(2, '0')}`, { x: 0, y: -i * d, z: deckZ(REF) });
        // rear-most fires first; each cabinet in front of it waits d/c longer
        s.delayS = ((n - 1 - i) * d) / C20;
        return s;
      });
      return { doc: doc(sources, AUDIENCE_POINTS, 'End-Fire'), sim: sim({ frequencyHz: 63 }) };
    },
  },
  {
    id: 'cardioid-pair',
    name: 'Cardioid Pair',
    description:
      'Front cabinet plus a rear cabinet 1.35 m behind it, turned round, polarity inverted and delayed by its acoustic spacing over c. Gradient cardioid with a deep rear null.',
    build: () => {
      const gap = 1.35;
      const z = deckZ(REF);
      const front = makeSource(REF, 'SUB 01 FRONT', { x: 0, y: 0, z });
      const rear = makeSource(REF, 'SUB 02 REAR', { x: 0, y: -gap, z });
      rear.invertPolarity = true;
      // The rear box faces away, so it radiates one cabinet depth further back
      // than its handle: the gradient spacing is the distance between the two
      // BAFFLES, not between the two crosses on the drawing. Delaying by the
      // drawn distance puts the null in the wrong place.
      rear.delayS = (gap + 2 * originY(REF)) / C20;
      rear.rotation.azimuthDeg = 180;
      return { doc: doc([front, rear], AUDIENCE_POINTS, 'Cardioid Pair'), sim: sim({ frequencyHz: 63 }) };
    },
  },
  {
    id: 'arc',
    name: 'Arc Array',
    description: '7 cabinets on a 12 m radius arc spanning 60 deg, each aimed along the arc normal.',
    build: () => {
      const n = 7;
      const radius = 12;
      const totalArc = (60 * Math.PI) / 180;
      const sources = Array.from({ length: n }, (_, i) => {
        const t = -totalArc / 2 + (totalArc * i) / (n - 1);
        const s = makeSource(REF, `SUB ${String(i + 1).padStart(2, '0')}`, {
          x: radius * Math.sin(t),
          y: -radius * (1 - Math.cos(t)),
          z: deckZ(REF),
        });
        s.rotation.azimuthDeg = (t * 180) / Math.PI;
        return s;
      });
      return { doc: doc(sources, AUDIENCE_POINTS, 'Arc Array'), sim: sim({ frequencyHz: 63 }) };
    },
  },
  {
    id: 'cardioid-cabinets',
    name: 'Cardioid Cabinets',
    description:
      '6 analytical-cardioid cabinets in a broadside line. Rotate them to see the pattern follow the boxes.',
    build: () => ({
      doc: doc(line('btr-ref-cardioid-218', 6, 2.4), AUDIENCE_POINTS, 'Cardioid Cabinets'),
      sim: sim({ frequencyHz: 63 }),
    }),
  },
  {
    id: 'steered',
    name: 'Steered Broadside (−25°)',
    description:
      '12 cabinets on a 1.4 m pitch with a plane-wave delay taper aiming the beam 25° off axis. Open the Array panel to re-aim it.',
    build: () => {
      const spacing = 1.4;
      const sources = line(REF, 12, spacing);
      const positions = sources.map((s) => s.position.x);
      const delays = steeringDelays({ positions, steerDeg: -25, speedOfSound: C20 });
      sources.forEach((s, i) => (s.delayS = delays[i]));
      return { doc: doc(sources, AUDIENCE_POINTS, 'Steered Broadside'), sim: sim({ frequencyHz: 63 }) };
    },
  },
  {
    id: 'arc-delay',
    name: 'Arc Delay (80° dispersion)',
    description:
      '10 cabinets in a straight line, delayed onto a virtual arc so they cover 80° instead of beaming forward. The "delay for nominal dispersion" function.',
    build: () => {
      const sources = line(REF, 10, 2);
      const positions = sources.map((s) => s.position.x);
      const delays = steeringDelays({ positions, dispersionDeg: 80, speedOfSound: C20 });
      sources.forEach((s, i) => (s.delayS = delays[i]));
      return { doc: doc(sources, AUDIENCE_POINTS, 'Arc Delay 80°'), sim: sim({ frequencyHz: 63 }) };
    },
  },
  {
    id: 'flown-column',
    name: 'Flown Column (tilt 9°)',
    description:
      '8 cabinets flown in a vertical column, delay-tilted 9° down. Switch to the Side view to see the beam aim into the audience.',
    build: () => {
      const h = 0.585;
      const top = 9;
      const n = 8;
      // Left facing the default +Y, into the audience, because the side view is a
      // section ALONG the room. This preset used to aim the column at +X, which
      // was right while the side view drew X/Z; after that was corrected to Y/Z
      // the column fired straight out of the drawn section and the preset showed
      // a cardioid's flank instead of its beam.
      const sources = Array.from({ length: n }, (_, i) =>
        makeSource('db-sl-sub', `SUB ${String(i + 1).padStart(2, '0')}`, {
          x: 0,
          y: 0,
          z: top - h / 2 - i * h,
        }),
      );
      const positions = sources.map((s) => s.position.z);
      // positive tilt steers toward +Z, so aim downwards with a negative angle
      const delays = steeringDelays({ positions, steerDeg: -9, speedOfSound: C20 });
      sources.forEach((s, i) => (s.delayS = delays[i]));
      return {
        doc: doc(sources, AUDIENCE_POINTS, 'Flown Column'),
        sim: sim({
          frequencyHz: 63,
          plane: 'side',
          area: { xMin: -5, xMax: 55, vMin: -1, vMax: 14, planeOffset: 0 },
        }),
      };
    },
  },
  {
    id: 'demo',
    name: 'DEMO: 16 x KS28 broadside',
    description:
      'The shipped demo project: 16 L-Acoustics KS28 in a 1.5 m-pitch broadside line with a full set of measurement points. Change spacing or frequency and watch the pattern move.',
    build: () => {
      const sources = line('la-ks28', 16, 1.5).map((s, i) => ({
        ...s,
        label: `KS28 ${String(i + 1).padStart(2, '0')}`,
      }));
      return {
        doc: doc(sources, AUDIENCE_POINTS, 'DEMO: 16 x KS28 broadside'),
        sim: sim({ frequencyHz: 63, quality: 'normal' }),
      };
    },
  },
];

export const DEMO_RIG_ID = 'demo';

// Appended rather than written inline so the seven stay together.
for (const b of KS28_BLOCKS) EXAMPLE_RIGS.push(ks28BlockRig(b, KS28_BLOCK_NOTES[b.id]));
