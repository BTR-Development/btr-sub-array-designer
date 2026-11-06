/**
 * Native BTR project format — versioned JSON.
 *
 * All persisted units are SI-ish and explicit: metres, SECONDS, degrees, Hz, dB.
 * The UI displays delay in ms; the file never does.
 */

import { BRANDING } from '../branding';
import {
  defaultSimulationSettings,
  speedOfSoundFromTemp,
  type BTRProject,
  type Group,
  type MeasurementPoint,
  type SimulationSettings,
  type Source,
  type Vec3,
} from '../core/types';
import type {
  BalloonDataset,
  DataProvenance,
  DataQuality,
  ElementDataset,
  PredictionDataset,
  RadiatingElement,
  SpeakerModel,
  SpeakerType,
} from '../speakers/schema';
import { ImportError, type ProjectExporter, type ProjectImporter } from './types';

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}

function vec3(v: unknown, fallback: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const o = (v ?? {}) as Partial<Vec3>;
  return { x: num(o.x, fallback.x), y: num(o.y, fallback.y), z: num(o.z, fallback.z) };
}

function parseSource(raw: unknown, i: number): Source {
  const o = (raw ?? {}) as Record<string, unknown>;
  const rot = (o.rotation ?? {}) as Record<string, unknown>;
  return {
    id: typeof o.id === 'string' ? o.id : `src_import_${i}`,
    label: typeof o.label === 'string' ? o.label : `SUB ${String(i + 1).padStart(2, '0')}`,
    speakerId: typeof o.speakerId === 'string' ? o.speakerId : 'btr-ref-omni-18',
    position: vec3(o.position),
    rotation: {
      azimuthDeg: num(rot.azimuthDeg, 0),
      elevationDeg: num(rot.elevationDeg, 0),
      rollDeg: num(rot.rollDeg, 0),
    },
    levelDb: num(o.levelDb, 0),
    delayS: num(o.delayS, 0),
    invertPolarity: !!o.invertPolarity,
    mute: !!o.mute,
    groupId: typeof o.groupId === 'string' ? o.groupId : null,
    // Zapisana tożsamość pozycji i zaszyty gradient. Parser buduje obiekt
    // jawnie, więc pole nie wymienione tutaj ginęłoby przy każdym otwarciu.
    positionKey: typeof o.positionKey === 'string' ? o.positionKey : undefined,
    gradientDelayS:
      typeof o.gradientDelayS === 'number' && isFinite(o.gradientDelayS) && o.gradientDelayS > 0
        ? o.gradientDelayS
        : undefined,
  };
}

function parseGroup(raw: unknown, i: number): Group {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof o.id === 'string' ? o.id : `grp_import_${i}`,
    name: typeof o.name === 'string' ? o.name : `GROUP ${i + 1}`,
    offset: vec3(o.offset),
    rotationOffsetDeg: num(o.rotationOffsetDeg, 0),
    anchor: vec3(o.anchor),
    levelOffsetDb: num(o.levelOffsetDb, 0),
    delayOffsetS: num(o.delayOffsetS, 0),
    mute: !!o.mute,
  };
}

function parsePoint(raw: unknown, i: number): MeasurementPoint {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof o.id === 'string' ? o.id : `mp_import_${i}`,
    name: typeof o.name === 'string' ? o.name : `POINT ${i + 1}`,
    position: vec3(o.position),
  };
}

function parseSim(raw: unknown): SimulationSettings {
  const d = defaultSimulationSettings();
  const o = (raw ?? {}) as Record<string, unknown>;
  const area = (o.area ?? {}) as Record<string, unknown>;
  const tempC = num(o.temperatureC, d.temperatureC);
  return {
    frequencyHz: num(o.frequencyHz, d.frequencyHz),
    temperatureC: tempC,
    speedOfSound: num(o.speedOfSound, speedOfSoundFromTemp(tempC)),
    plane: o.plane === 'side' ? 'side' : 'top',
    area: {
      xMin: num(area.xMin, d.area.xMin),
      xMax: num(area.xMax, d.area.xMax),
      vMin: num(area.vMin, d.area.vMin),
      vMax: num(area.vMax, d.area.vMax),
      planeOffset: num(area.planeOffset, d.area.planeOffset),
    },
    quality: o.quality === 'draft' || o.quality === 'high' ? o.quality : 'normal',
    ground: o.ground === 'rigid' ? 'rigid' : 'off',
    splMode: o.splMode === 'absolute' ? 'absolute' : 'relative',
    absoluteRefDb: num(o.absoluteRefDb, d.absoluteRefDb),
    dynamicRangeDb: num(o.dynamicRangeDb, d.dynamicRangeDb),
    dbPerDivision: num(o.dbPerDivision, d.dbPerDivision),
    // Absent in files written before band averaging existed; those projects
    // were drawn as single tones and must reopen looking the same.
    bandOct: num(o.bandOct, d.bandOct),
    // I sprzed szumu różowego: brak pola znaczy 'tone', jak było.
    signal: o.signal === 'pink' ? 'pink' : 'tone',
    pinkLoHz: num(o.pinkLoHz, d.pinkLoHz),
    pinkHiHz: num(o.pinkHiHz, d.pinkHiHz),
  };
}

/* ───────────────────────────────────────────────── custom speaker models ──
 *
 * A custom speaker is the one part of a project file that cannot be defaulted.
 * Everywhere else in this parser a missing or malformed field falls back to a
 * number the user can SEE: a source at the origin, a group with no offset, a
 * 63 Hz centre frequency. A speaker model is different in two ways.
 *
 * It is load bearing for the RENDER: this entry used to be cast straight to
 * `SpeakerModel[]`, so `{"id":"cust-x","model":"old"}` parsed happily and then
 * threw on `m.dimensions.widthM` while drawing — after `loadDoc` had already
 * replaced the open project, and again from the crash snapshot, which contains
 * the same entry.
 *
 * It is load bearing for the ACOUSTICS, invisibly: `maxSpl: "loud"` threw
 * nothing at all. It became the source's `refSplDb`, which is a DRIVE LEVEL, so
 * the amplitude went NaN, the summed power went NaN, and `bandDb` turns a NaN
 * into the silence floor — a cabinet missing from the sum and a map that looks
 * like a correct result.
 *
 * So the rule here is not "default it", it is:
 *
 *   absent            -> unknown, which the schema already spells `null`
 *   present but wrong -> the file is corrupt, refuse it and say which entry
 *
 * Refusing is what protects the open project: `parseBTRProject` runs before
 * `loadDoc`, so an ImportError leaves the current project exactly where it was,
 * and `CrashRecovery` already reports an unreadable snapshot instead of dying on
 * it. Nothing is invented to keep a bad file alive — a dimension, a sensitivity
 * or a directivity that came out of this parser rather than out of the file
 * would be exactly the fabrication the whole speaker-data policy exists to
 * prevent.
 */

function speakerFault(i: number, id: unknown, what: string): never {
  const which = typeof id === 'string' && id ? `"${id}"` : `#${i + 1}`;
  throw new ImportError(`Custom speaker ${which} ${what}. The project was not opened.`);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A number that is there, or null when it is not. A wrong type is a fault. */
/** 20 mm to 4 m, and 80 to 170 dB: the bounds loadExtra.validateRecord uses. */
const BOX_M: [number, number] = [0.02, 4];
const MAX_SPL_DB: [number, number] = [80, 170];

function optNum(
  v: unknown,
  i: number,
  id: unknown,
  field: string,
  opts: { positive?: boolean; range?: [number, number] } = {},
): number | null {
  if (v == null) return null;
  if (typeof v !== 'number' || !isFinite(v)) {
    speakerFault(i, id, `has ${JSON.stringify(v)} where ${field} should be a number`);
  }
  if (opts.positive && v <= 0) speakerFault(i, id, `has ${field} ${v}, which is not a length`);
  if (opts.range && (v < opts.range[0] || v > opts.range[1])) {
    speakerFault(i, id, `has ${field} ${v}, outside the plausible range ${opts.range[0]}-${opts.range[1]}`);
  }
  return v;
}

function optStr(v: unknown, i: number, id: unknown, field: string): string | undefined {
  if (v == null) return undefined;
  if (typeof v !== 'string') speakerFault(i, id, `has a non-text ${field}`);
  return v;
}

const SPEAKER_TYPES: SpeakerType[] = ['omnidirectional', 'cardioid', 'infra', 'other'];
const QUALITIES: DataQuality[] = ['A', 'B', 'C', 'D'];

/**
 * A magnitude or phase grid, as a Float32Array.
 *
 * `JSON.stringify` writes a Float32Array as an OBJECT keyed by index, so a
 * balloon this program exported reads back as `{"0":-1.2,"1":...}` rather than as
 * an array. The exporter now writes a real array (see `jsonSafe`), and this
 * accepts both so that projects already written to disk still open.
 */
function grid(v: unknown, expected: number, i: number, id: unknown, field: string): Float32Array {
  const values: unknown[] =
    v instanceof Float32Array || v instanceof Float64Array
      ? Array.from(v)
      : Array.isArray(v)
        ? v
        : isObj(v)
          ? // its own index keys, in order, so a short grid is reported as the
            // wrong LENGTH rather than as a hole in the middle of it
            Object.keys(v)
              .filter((k) => /^\d+$/.test(k))
              .sort((a, b) => Number(a) - Number(b))
              .map((k) => v[k])
          : [];
  if (values.length !== expected) {
    speakerFault(
      i,
      id,
      `has ${values.length} values in ${field} but its axes describe ${expected} directions`,
    );
  }
  const out = new Float32Array(expected);
  for (let k = 0; k < expected; k++) {
    const x = values[k];
    if (typeof x !== 'number' || !isFinite(x)) {
      speakerFault(i, id, `has a missing or non-numeric value in ${field}`);
    }
    out[k] = x;
  }
  return out;
}

/** An angle or frequency axis: finite and strictly increasing, because the
 * sampler binary-searches it. An unsorted axis reads the wrong direction's
 * magnitude without ever failing. */
function axis(v: unknown, i: number, id: unknown, field: string): number[] {
  if (!Array.isArray(v) || v.length === 0) speakerFault(i, id, `has no ${field} axis`);
  const out: number[] = [];
  for (const x of v as unknown[]) {
    if (typeof x !== 'number' || !isFinite(x)) speakerFault(i, id, `has a non-numeric ${field}`);
    if (out.length && x <= out[out.length - 1]) {
      speakerFault(i, id, `lists ${field} out of order; the axis has to increase`);
    }
    out.push(x);
  }
  return out;
}

function parseElements(v: unknown, i: number, id: unknown): RadiatingElement[] {
  if (!Array.isArray(v) || v.length === 0) speakerFault(i, id, 'has an element model with no elements');
  return (v as unknown[]).map((raw) => {
    if (!isObj(raw)) speakerFault(i, id, 'has an element that is not an object');
    const pos = raw.position;
    if (!isObj(pos)) speakerFault(i, id, 'has an element with no position');
    const at = (k: 'x' | 'y' | 'z') => {
      const n = optNum(pos[k], i, id, `element position ${k}`);
      if (n === null) speakerFault(i, id, `has an element with no ${k} position`);
      return n;
    };
    const gain = optNum(raw.gain, i, id, 'element gain');
    const delayS = optNum(raw.delayS, i, id, 'element delay');
    if (gain === null) speakerFault(i, id, 'has an element with no gain');
    if (typeof raw.invert !== 'boolean') speakerFault(i, id, 'has an element with no polarity');
    return {
      position: { x: at('x'), y: at('y'), z: at('z') },
      gain,
      // A missing element delay is 0 seconds, which is the only reading of
      // "not stated" that adds nothing to the geometry.
      delayS: delayS ?? 0,
      invert: raw.invert,
    };
  });
}

function parsePrediction(v: unknown, i: number, id: unknown): PredictionDataset {
  if (!isObj(v)) speakerFault(i, id, 'carries no prediction data');
  if (v.kind === 'omni') return { kind: 'omni' };
  if (v.kind === 'elements') {
    const out: ElementDataset = {
      kind: 'elements',
      elements: parseElements(v.elements, i, id),
      // Absent means the file makes no claim, and modelling a processor EQ that
      // flattens the on-axis response is an active claim: it changes the level
      // at every angle. No claim, no normalisation.
      normaliseOnAxis: v.normaliseOnAxis === true,
    };
    return out;
  }
  if (v.kind === 'balloon') {
    const frequenciesHz = axis(v.frequenciesHz, i, id, 'frequency');
    const azimuthDeg = axis(v.azimuthDeg, i, id, 'azimuth');
    const elevationDeg = axis(v.elevationDeg, i, id, 'elevation');
    const expected = frequenciesHz.length * azimuthDeg.length * elevationDeg.length;
    const out: BalloonDataset = {
      kind: 'balloon',
      frequenciesHz,
      azimuthDeg,
      elevationDeg,
      magnitudeDb: grid(v.magnitudeDb, expected, i, id, 'magnitudeDb'),
      phaseDeg: grid(v.phaseDeg, expected, i, id, 'phaseDeg'),
    };
    return out;
  }
  speakerFault(i, id, `declares an unknown prediction model "${String(v.kind)}"`);
}

function parseProvenance(v: unknown, i: number, id: unknown, field: string): DataProvenance | undefined {
  if (v == null) return undefined;
  if (!isObj(v) || typeof v.type !== 'string') {
    speakerFault(i, id, `has a ${field} provenance that does not say where the figure came from`);
  }
  return {
    type: v.type,
    url: optStr(v.url, i, id, 'provenance url'),
    retrieved: optStr(v.retrieved, i, id, 'provenance date'),
    note: optStr(v.note, i, id, 'provenance note'),
  };
}

/**
 * The grade the file may claim, against the data it actually carries.
 *
 * A and B both mean an imported dataset — manufacturer prediction data, or a
 * measured balloon. A file that grades an analytical element model or a bare
 * omni as A is claiming provenance for data it does not contain, and the badge
 * the interface prints from this field is one of the places the program is
 * explicitly promising not to overstate what it knows. A borrowed directivity is
 * D by definition, whatever the file says.
 *
 * Downgrading rather than refusing, because the acoustics in the file are still
 * usable; it is only the label that was wrong.
 */
function honestQuality(
  declared: DataQuality,
  prediction: PredictionDataset,
  proxyOfId: string | undefined,
): DataQuality {
  if (proxyOfId) return 'D';
  if (prediction.kind !== 'balloon' && (declared === 'A' || declared === 'B')) return 'C';
  return declared;
}

function parseCustomSpeaker(raw: unknown, i: number): SpeakerModel {
  if (!isObj(raw)) speakerFault(i, undefined, 'is not an object');
  const id = raw.id;
  if (typeof id !== 'string' || !id) speakerFault(i, undefined, 'has no id');
  if (typeof raw.manufacturer !== 'string' || typeof raw.model !== 'string') {
    speakerFault(i, id, 'is missing its manufacturer or model name');
  }
  if (raw.type != null && !SPEAKER_TYPES.includes(raw.type as SpeakerType)) {
    speakerFault(i, id, `declares an unknown type "${String(raw.type)}"`);
  }
  if (typeof raw.dataQuality !== 'string' || !QUALITIES.includes(raw.dataQuality as DataQuality)) {
    speakerFault(i, id, 'does not carry a data-quality grade');
  }
  const dims = raw.dimensions;
  if (dims != null && !isObj(dims)) speakerFault(i, id, 'has dimensions that are not an object');
  const d = isObj(dims) ? dims : {};
  const range = raw.frequencyRange;
  if (range != null && !isObj(range)) speakerFault(i, id, 'has a frequency range that is not an object');
  const origin = raw.acousticOriginM;
  if (origin != null && !isObj(origin)) speakerFault(i, id, 'has an acoustic origin that is not a point');

  const prediction = parsePrediction(raw.predictionData, i, id);
  const proxyOfId = optStr(raw.proxyOfId, i, id, 'proxy id');
  const src = raw.source;
  if (src != null && !isObj(src)) speakerFault(i, id, 'has a source block that is not an object');
  const sources = isObj(src) ? src : {};

  return {
    id,
    manufacturer: raw.manufacturer,
    model: raw.model,
    // Same bounds loadExtra.validateRecord applies to a library record. A
    // project file is the other door into the same state and it was unguarded:
    // maxSpl is not a caption, it is a per-source drive level AND the
    // project-wide reference every ungraded cabinet is driven at, so a value
    // outside the plausible range reshapes the complex sum rather than
    // mislabelling it.
    dimensions: {
      widthM: optNum(d.widthM, i, id, 'width', { positive: true, range: BOX_M }),
      heightM: optNum(d.heightM, i, id, 'height', { positive: true, range: BOX_M }),
      depthM: optNum(d.depthM, i, id, 'depth', { positive: true, range: BOX_M }),
    },
    weightKg: optNum(raw.weightKg, i, id, 'weight', { positive: true }),
    // Nothing said means nothing classified, which is what 'other' is for.
    type: (raw.type as SpeakerType | undefined) ?? 'other',
    construction: optStr(raw.construction, i, id, 'construction'),
    radiation: optStr(raw.radiation, i, id, 'radiation'),
    maxSpl: optNum(raw.maxSpl, i, id, 'max SPL', { range: MAX_SPL_DB }),
    frequencyRange: isObj(range)
      ? {
          minHz: optNum(range.minHz, i, id, 'minimum frequency', { positive: true }),
          maxHz: optNum(range.maxHz, i, id, 'maximum frequency', { positive: true }),
        }
      : null,
    predictionData: prediction,
    dataQuality: honestQuality(raw.dataQuality as DataQuality, prediction, proxyOfId),
    source: {
      dimensions: parseProvenance(sources.dimensions, i, id, 'dimensions'),
      prediction: parseProvenance(sources.prediction, i, id, 'prediction'),
      general: parseProvenance(sources.general, i, id, 'general'),
    },
    acousticOriginM: isObj(origin)
      ? {
          x: optNum(origin.x, i, id, 'acoustic origin x') ?? 0,
          y: optNum(origin.y, i, id, 'acoustic origin y') ?? 0,
          z: optNum(origin.z, i, id, 'acoustic origin z') ?? 0,
        }
      : null,
    // Whatever the file says: a model carried inside a project IS project-local,
    // and `findProxy` reads this flag to keep custom cabinets out of the pool it
    // borrows acoustics from.
    isCustom: true,
    proxyOfId,
    proxyNote: optStr(raw.proxyNote, i, id, 'proxy note'),
  };
}

export function parseCustomSpeakers(raw: unknown): SpeakerModel[] {
  if (!Array.isArray(raw)) return [];
  const out = raw.map(parseCustomSpeaker);
  const seen = new Set<string>();
  for (const m of out) {
    // Two models under one id: the provider indexes by id, so one of the two
    // would be the cabinet nothing on screen refers to.
    if (seen.has(m.id)) throw new ImportError(`Custom speaker "${m.id}" appears twice in this project file.`);
    seen.add(m.id);
  }
  return out;
}

export function parseBTRProject(text: string): BTRProject {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ImportError('File is not valid JSON.');
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.format !== BRANDING.formatId) {
    throw new ImportError(
      `Not a ${BRANDING.shortName} project file (expected format "${BRANDING.formatId}", got "${String(o.format)}").`,
    );
  }
  const version = num(o.version, 0);
  if (version > BRANDING.formatVersion) {
    throw new ImportError(
      `Project was written by a newer version of ${BRANDING.productName} (file v${version}, this build reads v${BRANDING.formatVersion}).`,
    );
  }

  const sources = Array.isArray(o.sources) ? o.sources.map(parseSource) : [];
  const groups = Array.isArray(o.groups) ? o.groups.map(parseGroup) : [];
  // drop dangling group references rather than silently keeping a broken link
  const groupIds = new Set(groups.map((g) => g.id));
  for (const s of sources) if (s.groupId && !groupIds.has(s.groupId)) s.groupId = null;

  const meta = (o.project ?? {}) as Record<string, unknown>;

  return {
    format: BRANDING.formatId,
    // the version the FILE claimed, not this build's. Saving writes the current
    // one (store.toProject); keeping the original here is what lets a reader
    // tell that an old file's group yaw means something different.
    version,
    project: {
      name: typeof meta.name === 'string' ? meta.name : 'Imported project',
      author: typeof meta.author === 'string' ? meta.author : undefined,
      notes: typeof meta.notes === 'string' ? meta.notes : undefined,
      createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : undefined,
      modifiedAt: typeof meta.modifiedAt === 'string' ? meta.modifiedAt : undefined,
    },
    sources,
    groups,
    measurementPoints: Array.isArray(o.measurementPoints) ? o.measurementPoints.map(parsePoint) : [],
    simulationSettings: parseSim(o.simulationSettings),
    customSpeakers: parseCustomSpeakers(o.customSpeakers),
  };
}

/**
 * Was this project written before the group-yaw sign was corrected, and does it
 * actually contain a rotated group?
 *
 * Until format version 2 a group yaw turned member POSITIONS one way and member
 * HEADINGS the other, so it was not a rigid rotation and an array aimed at
 * roughly minus the angle that was typed. Fixing that changes where an old file
 * puts its cabinets: every member of a yawed group moves by a rotation of twice
 * the yaw about the group anchor.
 *
 * There is no migration that preserves what the user saw, because what they saw
 * was already self-contradictory — negating the stored yaw would restore the old
 * positions and then point every cabinet the wrong way instead. So the file is
 * read as written and the difference is stated.
 *
 * Returns null when there is nothing to say, which is the overwhelming majority
 * of files: a project with no group yaw resolves identically in both builds.
 */
export function legacyYawNotice(p: BTRProject): string | null {
  if (p.version >= 2) return null;
  const rotated = p.groups.filter((g) => g.rotationOffsetDeg !== 0);
  if (!rotated.length) return null;
  const names = rotated.map((g) => `"${g.name}"`).join(', ');
  return (
    `This project was saved before a fix to group rotation. ` +
    `${rotated.length === 1 ? 'Group' : 'Groups'} ${names} ` +
    `${rotated.length === 1 ? 'was' : 'were'} rotated the wrong way by older builds, ` +
    `so the cabinets now sit where the yaw actually points them. Check the layout before using it.`
  );
}

export const btrJsonImporter: ProjectImporter = {
  id: 'btr-json',
  label: `${BRANDING.shortName} JSON`,
  // .btrsub now (an extension of its own, so a double-click can
  // open it); .json and .btr.json are the projects written before that
  extensions: ['.btrsub', '.json', '.btr.json'],
  canImport(file) {
    return /\.(btrsub|json)$/i.test(file.name);
  },
  async import(file) {
    return parseBTRProject(await file.text());
  },
};

/**
 * A balloon's magnitude and phase are Float32Arrays, and `JSON.stringify` writes
 * a typed array as an object keyed by index — valid JSON that no longer looks
 * like the array the schema declares. Written as a real array it round-trips
 * through the parser, and an older build reading it indexes it exactly as it
 * indexed the object.
 */
function jsonSafe(_key: string, value: unknown): unknown {
  return value instanceof Float32Array || value instanceof Float64Array ? Array.from(value) : value;
}

export const btrJsonExporter: ProjectExporter = {
  id: 'btr-json',
  label: `${BRANDING.shortName} JSON`,
  extension: BRANDING.fileExtension,
  mimeType: 'application/json',
  async export(project) {
    return new Blob([JSON.stringify(project, jsonSafe, 2)], { type: 'application/json' });
  },
};
