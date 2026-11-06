import { describe, expect, it } from 'vitest';
import {
  buildBalloonModel,
  describeUnreadableSpeakerFile,
  normaliseBalloon,
  parseBalloonJson,
  parseBalloonText,
} from './balloonImport';
import { computePoint } from '../../engine/engine';
import { boxSize } from '../../speakers/schema';
import type { EngineSource } from '../../engine/types';

/* A tiny 2 x 5 x 1 grid: two frequencies, five azimuths, one elevation.
   Magnitudes are absolute-looking so the normalisation has something to do. */
const AZ = [-180, -90, 0, 90, 180];
const F = [50, 100];

function csv(rows: Array<[number, number, number, number, number]>, header = 'freq_hz,az_deg,el_deg,mag_db,phase_deg') {
  return [header, ...rows.map((r) => r.join(','))].join('\n');
}

/** cardioid-ish: full level forward, deep null behind */
const MAG: Record<number, number> = { [-180]: 100, [-90]: 130, 0: 136, 90: 130, 180: 100 };

function fullRows(): Array<[number, number, number, number, number]> {
  const out: Array<[number, number, number, number, number]> = [];
  for (const f of F) for (const az of AZ) out.push([f, az, 0, MAG[az], az / 2]);
  return out;
}

describe('unreadable formats', () => {
  it('explains a .GLL instead of failing blankly, and names the way out', () => {
    const msg = describeUnreadableSpeakerFile('KS28.GLL');
    expect(msg).toBeTruthy();
    expect(msg!.toLowerCase()).toContain('licence');
    expect(msg!.toLowerCase()).toContain('export');
  });

  it('distinguishes the .XGLL authoring source from a dataset', () => {
    expect(describeUnreadableSpeakerFile('thing.xgll')).toContain('authoring source');
  });

  it('says nothing about formats it can actually read', () => {
    expect(describeUnreadableSpeakerFile('balloon.csv')).toBeNull();
    expect(describeUnreadableSpeakerFile('balloon.json')).toBeNull();
  });
});

describe('delimited import', () => {
  it('reads a complete grid and infers the axes from the rows', () => {
    const { raw, warnings } = parseBalloonText(csv(fullRows()));
    expect(raw.frequenciesHz).toEqual(F);
    expect(raw.azimuthDeg).toEqual(AZ);
    expect(raw.elevationDeg).toEqual([0]);
    expect(raw.phaseAssumed).toBe(false);
    // one elevation means a horizontal-plane dataset, which is worth saying
    expect(warnings.join(' ')).toContain('one elevation');
  });

  it('accepts tabs, semicolons and alias column names', () => {
    const rows = fullRows().map((r) => r.join('\t'));
    const text = ['Frequency\tAzimuth\tElevation\tSPL (dB)\tPhase', ...rows].join('\n');
    const { raw } = parseBalloonText(text);
    expect(raw.azimuthDeg).toEqual(AZ);
  });

  it('refuses an incomplete grid rather than filling the holes', () => {
    const rows = fullRows().slice(0, -1);
    expect(() => parseBalloonText(csv(rows))).toThrow(/grid is not complete/i);
  });

  it('refuses a duplicated cell', () => {
    const rows = fullRows();
    rows[3] = [...rows[2]] as typeof rows[3];
    expect(() => parseBalloonText(csv(rows))).toThrow(/duplicate/i);
  });

  it('names the missing column when the header is wrong', () => {
    const text = ['hz,degrees,level', '50,0,100'].join('\n');
    expect(() => parseBalloonText(text)).toThrow(/missing a column/i);
  });

  it('takes phase as zero when the file has none, and says so', () => {
    const rows = fullRows().map((r) => [r[0], r[1], r[2], r[3]].join(','));
    const { raw, warnings } = parseBalloonText(['freq_hz,az_deg,el_deg,mag_db', ...rows].join('\n'));
    expect(raw.phaseAssumed).toBe(true);
    expect(warnings.join(' ')).toMatch(/graded B/);
  });
});

describe('JSON import', () => {
  const doc = {
    manufacturer: 'ACME',
    model: 'SUB-1',
    dimensions: { widthM: 1.2, heightM: 0.6, depthM: 0.8 },
    frequenciesHz: F,
    azimuthDeg: AZ,
    elevationDeg: [0],
    magnitudeDb: F.flatMap(() => AZ.map((az) => MAG[az])),
    phaseDeg: F.flatMap(() => AZ.map((az) => az / 2)),
  };

  it('reads the documented format including metadata', () => {
    const { raw, meta } = parseBalloonJson(JSON.stringify(doc));
    expect(meta.manufacturer).toBe('ACME');
    expect(meta.widthM).toBe(1.2);
    expect(raw.magnitudeDb.length).toBe(F.length * AZ.length);
  });

  it('rejects a payload whose length disagrees with its axes', () => {
    const bad = { ...doc, magnitudeDb: doc.magnitudeDb.slice(1) };
    expect(() => parseBalloonJson(JSON.stringify(bad))).toThrow(/but the axes describe/);
  });

  it('rejects a non-monotonic axis', () => {
    const bad = { ...doc, azimuthDeg: [0, -90, 90, 180, -180] };
    expect(() => parseBalloonJson(JSON.stringify(bad))).toThrow(/must increase/);
  });

  /**
   * A file that says "I do not know this dimension" must not come back as a
   * confirmed zero: `boxSize` would report 0 x 0 x 0 mm as a measurement, and a
   * max SPL of 0 is a 0 dB drive level in the sum.
   */
  it('keeps a stated null a null rather than coercing it to zero', () => {
    const { raw, meta } = parseBalloonJson(
      JSON.stringify({ ...doc, dimensions: { widthM: null, heightM: 0.6, depthM: '' }, maxSpl: null }),
    );
    expect(meta.widthM).toBeNull();
    expect(meta.depthM).toBeNull();
    expect(meta.heightM).toBe(0.6);
    expect(meta.maxSpl).toBeNull();

    const { model } = buildBalloonModel(raw, { id: 'imported', quality: 'B', meta });
    expect(model.dimensions.widthM).toBeNull();
    expect(boxSize(model).unknown).toBe(true);
  });
});

describe('normalisation', () => {
  it('divides out the on-axis value so what is left is pure directivity', () => {
    const { raw } = parseBalloonText(csv(fullRows()));
    const n = normaliseBalloon(raw, 50);

    const nAz = AZ.length;
    const at = (fi: number, ai: number) => fi * nAz + ai;
    const onAxis = AZ.indexOf(0);
    const behind = AZ.indexOf(180);

    expect(n.onAxisDb).toBeCloseTo(136, 6);
    expect(n.dataset.magnitudeDb[at(0, onAxis)]).toBeCloseTo(0, 5);
    // the SHAPE survives: 100 dB behind against 136 on axis is -36 dB
    expect(n.dataset.magnitudeDb[at(0, behind)]).toBeCloseTo(-36, 5);
  });

  it('keeps the on-axis frequency response instead of flattening it', () => {
    // make 100 Hz 6 dB hotter on axis than 50 Hz
    const rows = fullRows().map((r) =>
      r[0] === 100 && r[1] === 0 ? ([r[0], r[1], r[2], r[3] + 6, r[4]] as typeof r) : r,
    );
    const { raw } = parseBalloonText(csv(rows));
    const n = normaliseBalloon(raw, 50);
    const onAxis = AZ.indexOf(0);
    const row = (fi: number) => fi * AZ.length + onAxis;
    expect(n.dataset.magnitudeDb[row(0)]).toBeCloseTo(0, 5);
    expect(n.dataset.magnitudeDb[row(1)]).toBeCloseTo(6, 5);
  });
});

describe('model building', () => {
  it('will not grade phase-less data as A, whatever was asked for', () => {
    const rows = fullRows().map((r) => [r[0], r[1], r[2], r[3]].join(','));
    const { raw } = parseBalloonText(['freq_hz,az_deg,el_deg,mag_db', ...rows].join('\n'));
    const { model } = buildBalloonModel(raw, {
      id: 'x', quality: 'A', meta: { manufacturer: 'ACME', model: 'SUB-1' },
    });
    expect(model.dataQuality).toBe('B');
  });

  it('grades data carrying real phase as asked, and records the provenance', () => {
    const { raw } = parseBalloonText(csv(fullRows()));
    const { model } = buildBalloonModel(raw, {
      id: 'x', quality: 'A', refHz: 50,
      meta: { manufacturer: 'ACME', model: 'SUB-1', sourceNote: 'SpeakerLab export' },
    });
    expect(model.dataQuality).toBe('A');
    expect(model.isCustom).toBe(true);
    expect(model.source?.prediction?.note).toContain('SpeakerLab export');
    expect(model.source?.prediction?.note).toContain('divided out');
  });
});

describe('the imported balloon actually drives the engine', () => {
  it('reproduces the rear attenuation the file described', () => {
    const { raw } = parseBalloonText(csv(fullRows()));
    const { model } = buildBalloonModel(raw, {
      id: 'imported', quality: 'A', refHz: 50, meta: { manufacturer: 'ACME', model: 'SUB-1' },
    });
    if (model.predictionData.kind !== 'balloon') throw new Error('expected a balloon dataset');

    const source: EngineSource = {
      id: 's',
      position: { x: 0, y: 0, z: 0 },
      azimuthDeg: 0,
      elevationDeg: 0,
      rollDeg: 0,
      levelDb: 0,
      delayS: 0,
      invertPolarity: false,
      refSplDb: 135,
      elements: null,
      normaliseOnAxis: false,
      balloon: model.predictionData,
    };

    const C = 343.4;
    // +Y is the cabinet front, so the receiver behind it sits at -Y
    const front = computePoint([source], { x: 0, y: 30, z: 0 }, 50, C);
    const rear = computePoint([source], { x: 0, y: -30, z: 0 }, 50, C);

    // the file said 136 dB forward against 100 dB behind
    expect(front.splDb - rear.splDb).toBeCloseTo(36, 1);
  });
});
