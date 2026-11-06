import { describe, it, expect } from 'vitest';
import { btrJsonExporter, legacyYawNotice, parseBTRProject } from './btrJson';
import { ImportError } from './types';
import { BRANDING } from '../branding';
import { defaultSimulationSettings } from '../core/types';
import type { BTRProject } from '../core/types';

function sampleProject(): BTRProject {
  return {
    format: BRANDING.formatId,
    version: 1,
    project: { name: 'Round trip' },
    sources: [
      {
        id: 'a',
        label: 'SUB 01',
        speakerId: 'la-ks28',
        position: { x: 1.5, y: -2, z: 0.25 },
        rotation: { azimuthDeg: 30, elevationDeg: -3, rollDeg: 1 },
        levelDb: -4.5,
        delayS: 0.00292,
        invertPolarity: true,
        mute: false,
        groupId: 'g1',
        // the stored position identity has to survive the file, or every
        // open merges a shrunken rig back into one position
        positionKey: 'pos_rt',
        // and the hidden cardioid gradient has to survive it, or every open
        // quietly disarms the rear null
        gradientDelayS: 0.0021,
      },
    ],
    groups: [
      {
        id: 'g1',
        name: 'MAIN',
        offset: { x: 0.5, y: 0, z: 0 },
        rotationOffsetDeg: 12,
        anchor: { x: 0, y: 0, z: 0 },
        levelOffsetDb: -2,
        delayOffsetS: 0.001,
        mute: false,
      },
    ],
    measurementPoints: [{ id: 'm1', name: 'FOH', position: { x: 0, y: 25, z: 1.6 } }],
    simulationSettings: { ...defaultSimulationSettings(), frequencyHz: 80, temperatureC: 25 },
    customSpeakers: [],
  };
}

describe('BTR JSON round trip', () => {
  it('survives export -> import unchanged', async () => {
    const p = sampleProject();
    const blob = await btrJsonExporter.export(p);
    const back = parseBTRProject(await blob.text());
    expect(back.sources).toEqual(p.sources);
    expect(back.groups).toEqual(p.groups);
    expect(back.measurementPoints).toEqual(p.measurementPoints);
    expect(back.simulationSettings.frequencyHz).toBe(80);
    expect(back.simulationSettings.temperatureC).toBe(25);
  });

  it('stores delay in seconds, not milliseconds', async () => {
    const blob = await btrJsonExporter.export(sampleProject());
    const json = JSON.parse(await blob.text());
    expect(json.sources[0].delayS).toBeCloseTo(0.00292, 9);
    expect(json.sources[0]).not.toHaveProperty('delayMs');
  });

  it('rejects a foreign file', () => {
    expect(() => parseBTRProject('{"format":"soundvision","version":1}')).toThrow(/Not a BTR project file/);
  });

  it('rejects a file from a newer format version', () => {
    expect(() => parseBTRProject(`{"format":"${BRANDING.formatId}","version":99}`)).toThrow(/newer version/);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseBTRProject('{ nope')).toThrow(/valid JSON/);
  });

  it('drops dangling group references instead of importing broken links', () => {
    const p = sampleProject();
    p.groups = [];
    const back = parseBTRProject(JSON.stringify(p));
    expect(back.sources[0].groupId).toBeNull();
  });

  it('fills in defaults for a minimal file', () => {
    const back = parseBTRProject(`{"format":"${BRANDING.formatId}","version":1}`);
    expect(back.sources).toEqual([]);
    expect(back.simulationSettings.frequencyHz).toBe(63);
    // the textbook figure for dry air at the 20 C default, which is what
    // 331.3*sqrt(1 + T/273.15) gives; the linear approximation this replaced
    // read 343.42 here
    expect(back.simulationSettings.speedOfSound).toBeCloseTo(343.21, 2);
  });
});

describe('a project saved before the group-yaw fix', () => {
  const withYaw = (version: number, rotationOffsetDeg: number) =>
    ({
      format: BRANDING.formatId,
      version,
      project: { name: 'p' },
      sources: [],
      groups: [
        {
          id: 'g1', name: 'SUBS',
          offset: { x: 0, y: 0, z: 0 },
          rotationOffsetDeg,
          anchor: { x: 0, y: 0, z: 0 },
          levelOffsetDb: 0, delayOffsetS: 0, mute: false,
        },
      ],
      measurementPoints: [],
      simulationSettings: defaultSimulationSettings(),
      customSpeakers: [],
    }) as BTRProject;

  it('says so, and names the groups that moved', () => {
    // Old builds turned member positions one way and headings the other. Reading
    // such a file correctly moves its cabinets, and the user has to be told
    // rather than handed a different layout in silence.
    const notice = legacyYawNotice(withYaw(1, 30));
    expect(notice).toContain('"SUBS"');
    expect(notice).toMatch(/before a fix to group rotation/i);
  });

  it('stays quiet for the overwhelming majority of files', () => {
    // no yaw: an old file resolves identically in both builds
    expect(legacyYawNotice(withYaw(1, 0))).toBeNull();
    // already written by this build
    expect(legacyYawNotice(withYaw(2, 30))).toBeNull();
  });

  it('preserves the version the file claimed, so the check can be made at all', () => {
    const text = JSON.stringify(withYaw(1, 30));
    expect(parseBTRProject(text).version).toBe(1);
    expect(legacyYawNotice(parseBTRProject(text))).not.toBeNull();
  });
});

describe('custom speakers in a project file', () => {
  const file = (customSpeakers: unknown) =>
    JSON.stringify({ ...sampleProject(), customSpeakers });

  /** A cabinet as the app's own "Custom" tab builds one. */
  const custom = () => ({
    id: 'custom-abc',
    manufacturer: 'Acme',
    model: 'Big One',
    dimensions: { widthM: 0.6, heightM: 0.5, depthM: 0.7 },
    weightKg: null,
    type: 'cardioid',
    construction: 'user-defined',
    radiation: 'cardioid (proxied)',
    maxSpl: null,
    frequencyRange: { minHz: 30, maxHz: 100 },
    predictionData: {
      kind: 'elements',
      elements: [
        { position: { x: 0, y: 0, z: 0 }, gain: 1, delayS: 0, invert: false },
        { position: { x: 0, y: -0.7, z: 0 }, gain: 1, delayS: 0.002, invert: true },
      ],
      normaliseOnAxis: true,
    },
    dataQuality: 'D',
    isCustom: true,
    proxyOfId: 'la-ks28',
    proxyNote: 'matched on cardioid radiation',
  });

  it('opens a project whose custom cabinet is intact', () => {
    const back = parseBTRProject(file([custom()]));
    expect(back.customSpeakers).toHaveLength(1);
    const m = back.customSpeakers[0];
    expect(m.dimensions).toEqual({ widthM: 0.6, heightM: 0.5, depthM: 0.7 });
    expect(m.maxSpl).toBeNull();
    expect(m.predictionData).toEqual(custom().predictionData);
    expect(m.dataQuality).toBe('D');
  });

  it('refuses the whole file rather than crashing on render', () => {
    // This entry used to pass the parser and throw on `m.dimensions.widthM`
    // while drawing — AFTER loadDoc had replaced the open project, and again from
    // the crash snapshot, which contains the same entry. Refusing here leaves the
    // open project exactly where it was.
    expect(() => parseBTRProject(file([{ id: 'cust-x', model: 'old' }]))).toThrow(ImportError);
    expect(() => parseBTRProject(file([{ id: 'cust-x', model: 'old' }]))).toThrow(/"cust-x"/);
  });

  it('refuses the quiet variant, which used to become silence', () => {
    // `maxSpl` is the source's reference SPL, which is a DRIVE LEVEL: a string
    // there made the amplitude NaN, and the engine answers a NaN with -400 dB —
    // a cabinet missing from the sum, on a map that looks correct.
    const m = { ...custom(), maxSpl: 'loud' };
    expect(() => parseBTRProject(file([m]))).toThrow(/max SPL should be a number/);
  });

  it('reads an absent figure as unknown and a wrong one as a broken file', () => {
    const noDims = { ...custom(), dimensions: undefined, weightKg: undefined };
    const back = parseBTRProject(file([noDims]));
    expect(back.customSpeakers[0].dimensions).toEqual({ widthM: null, heightM: null, depthM: null });

    const zeroWidth = { ...custom(), dimensions: { widthM: 0, heightM: 0.5, depthM: 0.7 } };
    expect(() => parseBTRProject(file([zeroWidth]))).toThrow(/not a length/);
  });

  it('will not let a file claim measured data it does not carry', () => {
    // A and B both mean an imported dataset. An analytical element model graded A
    // is a provenance claim with nothing behind it, and the badge the interface
    // prints from this field is one of the places the program promises not to
    // overstate what it knows.
    const lying = { ...custom(), proxyOfId: undefined, dataQuality: 'A' };
    expect(parseBTRProject(file([lying])).customSpeakers[0].dataQuality).toBe('C');

    // a borrowed directivity is D whatever the file says
    const proxy = { ...custom(), dataQuality: 'A' };
    expect(parseBTRProject(file([proxy])).customSpeakers[0].dataQuality).toBe('D');

    // and a grade has to be a grade
    expect(() => parseBTRProject(file([{ ...custom(), dataQuality: 'excellent' }]))).toThrow(
      /data-quality grade/,
    );
  });

  it('refuses two cabinets under one id', () => {
    // The provider indexes by id, so one of the two would be a cabinet nothing
    // on screen can refer to.
    expect(() => parseBTRProject(file([custom(), custom()]))).toThrow(/appears twice/);
  });

  describe('a balloon carried inside the project', () => {
    const balloonModel = () => ({
      ...custom(),
      id: 'custom-balloon',
      dataQuality: 'B',
      proxyOfId: undefined,
      predictionData: {
        kind: 'balloon',
        frequenciesHz: [40, 63],
        azimuthDeg: [-90, 0, 90],
        elevationDeg: [0],
        magnitudeDb: Float32Array.from([-3, 0, -3, -4, 0, -4]),
        phaseDeg: new Float32Array(6),
      },
    });

    it('survives export and import as a real array', async () => {
      // JSON.stringify writes a Float32Array as an object keyed by index, so a
      // balloon used to come back as {"0":-3,...}: valid JSON that is no longer
      // the array the schema declares, and whose length the sampler cannot read.
      const p = { ...sampleProject(), customSpeakers: [balloonModel()] } as unknown as BTRProject;
      const text = await (await btrJsonExporter.export(p)).text();
      const asJson = JSON.parse(text);
      expect(Array.isArray(asJson.customSpeakers[0].predictionData.magnitudeDb)).toBe(true);

      const data = parseBTRProject(text).customSpeakers[0].predictionData;
      expect(data.kind).toBe('balloon');
      if (data.kind !== 'balloon') throw new Error('unreachable');
      expect(data.magnitudeDb).toBeInstanceOf(Float32Array);
      expect(Array.from(data.magnitudeDb)).toEqual([-3, 0, -3, -4, 0, -4]);
      expect(parseBTRProject(text).customSpeakers[0].dataQuality).toBe('B');
    });

    it('still reads a file this program wrote before that was fixed', () => {
      const m = balloonModel();
      const asObject = {
        ...m,
        predictionData: {
          ...m.predictionData,
          magnitudeDb: { 0: -3, 1: 0, 2: -3, 3: -4, 4: 0, 5: -4 },
          phaseDeg: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        },
      };
      const data = parseBTRProject(file([asObject])).customSpeakers[0].predictionData;
      if (data.kind !== 'balloon') throw new Error('unreachable');
      expect(Array.from(data.magnitudeDb)).toEqual([-3, 0, -3, -4, 0, -4]);
    });

    it('refuses a grid that does not match its own axes', () => {
      const m = balloonModel();
      m.predictionData.magnitudeDb = Float32Array.from([0, 0, 0]);
      expect(() => parseBTRProject(file([m]))).toThrow(/axes describe 6 directions/);
    });

    it('refuses an axis that is not in order', () => {
      // The sampler binary-searches these. An unsorted axis reads the wrong
      // direction's magnitude and never fails.
      const m = balloonModel();
      m.predictionData.azimuthDeg = [0, -90, 90];
      expect(() => parseBTRProject(file([m]))).toThrow(/out of order/);
    });
  });
});

describe('a project file is the other door into the speaker library', () => {
  const withSpeaker = (over: Record<string, unknown>) =>
    JSON.stringify({
      format: BRANDING.formatId, version: 2, project: { name: 'p' },
      sources: [], groups: [], measurementPoints: [],
      simulationSettings: defaultSimulationSettings(),
      customSpeakers: [{
        id: 'cust-1', manufacturer: 'M', model: 'X',
        dimensions: { widthM: 0.6, heightM: 0.5, depthM: 0.5 },
        type: 'omnidirectional', dataQuality: 'D',
        predictionData: { kind: 'omni' },
        ...over,
      }],
    });

  it('bounds max SPL the way the library file does', () => {
    // maxSpl is not a caption. resolve.ts drives every UNGRADED cabinet in the
    // project at the loudest graded reference, so one absurd value here moves
    // the drive level of cabinets that have nothing to do with it — it
    // reshapes the complex sum rather than mislabelling one readout.
    // loadExtra.validateRecord has bounded it since it was written; this door
    // did not, and a project file is the easier one to hand somebody.
    expect(() => parseBTRProject(withSpeaker({ maxSpl: 1e6 }))).toThrow(/max SPL/);
    expect(() => parseBTRProject(withSpeaker({ maxSpl: 3 }))).toThrow(/max SPL/);
    expect(() => parseBTRProject(withSpeaker({ maxSpl: 143 }))).not.toThrow();
    expect(() => parseBTRProject(withSpeaker({ maxSpl: null }))).not.toThrow();
  });

  it('bounds the box the way the library file does', () => {
    expect(() => parseBTRProject(withSpeaker({ dimensions: { widthM: 900, heightM: 0.5, depthM: 0.5 } }))).toThrow(/width/);
    expect(() => parseBTRProject(withSpeaker({ dimensions: { widthM: 0.001, heightM: 0.5, depthM: 0.5 } }))).toThrow(/width/);
    expect(() => parseBTRProject(withSpeaker({ dimensions: { widthM: null, heightM: null, depthM: null } }))).not.toThrow();
  });
});
