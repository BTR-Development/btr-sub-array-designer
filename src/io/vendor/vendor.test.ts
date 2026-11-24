import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';

import { BRANDING } from '../../branding';
import { defaultSimulationSettings, type BTRProject, type Source } from '../../core/types';
import { builtinProvider, CompositeSpeakerDataProvider } from '../../speakers/provider';
import type { SpeakerModel } from '../../speakers/schema';
import {
  toArrayCalcGeometry,
  toSoundvisionGeometry,
  svPlacement,
  fromSvPlacement,
  toVendorModel,
  validateForTarget,
} from './internalModel';
import { arraycalcDeviceFor, soundvisionDeviceFor, describeMapping } from './deviceMap';
import { buildSvDocument, writeSoundvisionXml, uidFor } from './soundvision/writer';
import { writeDbpr, SUBS_GROUP_ID } from './arraycalc/writeDbpr';
import { XMLC_UNAVAILABLE, xmlcCodecAvailable } from './soundvision/xmlcCodec';
import { soundvisionExporter } from './soundvision/exporter';
import { soundvisionImporter } from './soundvision/importer';

const HERE = dirname(fileURLToPath(import.meta.url));
const SV_TEMPLATE = readFileSync(join(HERE, 'templates/soundvision-template.xml'), 'utf8');
const AC_TEMPLATE = new Uint8Array(readFileSync(join(HERE, 'templates/arraycalc-template.dbpr')));

function src(over: Partial<Source> = {}): Source {
  return {
    id: 's1',
    label: 'SUB 01',
    speakerId: 'la-ks28',
    position: { x: 0, y: 0, z: 0 },
    rotation: { azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 },
    levelDb: 0,
    delayS: 0,
    invertPolarity: false,
    mute: false,
    groupId: null,
    ...over,
  };
}

function project(sources: Source[], over: Partial<BTRProject> = {}): BTRProject {
  return {
    format: BRANDING.formatId,
    version: 1,
    project: { name: 'Example sub array' },
    sources,
    groups: [],
    measurementPoints: [],
    simulationSettings: defaultSimulationSettings(),
    customSpeakers: [],
    ...over,
  };
}

/** KS28 cabinet height, the one dimension the vertical datum turns on. */
const KS28_H = 0.55;
const KS28_D = 0.719;
/** The same cabinet laid on its end face stands this tall. */
const KS28_W = 1.34;

/** A cabinet whose height nobody published — what a vendor import leaves behind. */
const UNMEASURED: SpeakerModel = {
  id: 'unmeasured-sub',
  manufacturer: 'Unknown',
  model: 'UNMEASURED',
  type: 'omnidirectional',
  dimensions: { widthM: null, heightM: null, depthM: null },
  maxSpl: null,
  predictionData: { kind: 'omni' },
  dataQuality: 'D',
};

/**
 * The reference case from the format handoff, which is also the ArrayCalc project the
 * golden .dbpr was taken from: four subs on the lateral axis, outer pair toed and
 * trimmed, with a 4.6 ms module offset.
 */
function referenceProject(): BTRProject {
  const mk = (i: number, x: number, az: number, level: number, delayMs: number) =>
    src({
      id: `src-00${i}`,
      label: `SUB 0${i}`,
      position: { x, y: 0, z: 0 },
      rotation: { azimuthDeg: az, elevationDeg: 0, rollDeg: 0 },
      levelDb: level,
      // the source carries only its DESIGN delay; the group adds the 4.6 ms offset
      delayS: delayMs / 1000,
      groupId: 'g1',
    });
  return project(
    [mk(1, -15, -40, -6, 12.4), mk(2, -5, 0, 0, 0.3), mk(3, 5, 0, 0, 0.3), mk(4, 15, 40, -6, 12.4)],
    {
      groups: [
        {
          id: 'g1',
          name: 'SUBS',
          offset: { x: 0, y: 0, z: 0 },
          rotationOffsetDeg: 0,
          anchor: { x: 0, y: 0, z: 0 },
          levelOffsetDb: 0,
          delayOffsetS: 0.0046,
          mute: false,
        },
      ],
    },
  );
}

describe('neutral model', () => {
  it('resolves group transforms into absolute coordinates', () => {
    const p = project([src({ position: { x: 2, y: 0, z: 0 }, groupId: 'g1' })], {
      groups: [
        {
          id: 'g1',
          name: 'SUBS',
          offset: { x: 1, y: 5, z: 0.5 },
          rotationOffsetDeg: 0,
          anchor: { x: 0, y: 0, z: 0 },
          levelOffsetDb: -3,
          delayOffsetS: 0,
          mute: false,
        },
      ],
    });
    const m = toVendorModel(p, builtinProvider);
    expect(m.sources[0].x_m).toBe(3);
    expect(m.sources[0].y_m).toBe(5);
    expect(m.sources[0].z_m).toBe(0.5);
    expect(m.sources[0].gain_db).toBe(-3);
  });

  it('carries the group delay separately and keeps the total intact', () => {
    const m = toVendorModel(referenceProject(), builtinProvider);
    expect(m.groupRelativeDelayMs).toBeCloseTo(4.6, 9);
    // design delays, i.e. what the operator typed
    expect(m.sources.map((s) => s.delay_ms)).toEqual([12.4, 0.3, 0.3, 12.4]);
    // total is design + relative, matching the golden project
    expect(m.sources[0].delay_ms + m.groupRelativeDelayMs).toBeCloseTo(17.0, 6);
    expect(m.sources[1].delay_ms + m.groupRelativeDelayMs).toBeCloseTo(4.9, 6);
  });
});

describe('coordinate transforms', () => {
  it('writes the measured Soundvision file frame: (−x, z_bottom, y) of the front face, azimuth negated', () => {
    // Measured by opening crafted files in Soundvision: XML (1, 2, 3) shows as
    // X −1, Y 3, Z 2, and XML orientation 30 as azimuth −30. The UI frame is
    // BTR's, and a cluster is placed by the middle of its FRONT face.
    const m = toVendorModel(project([src({ position: { x: 1.5, y: -2, z: 0.6 }, rotation: { azimuthDeg: 30, elevationDeg: 0, rollDeg: 0 } })]), builtinProvider);
    const g = toSoundvisionGeometry(m.sources[0]);
    const half = KS28_D / 2;
    const a = (30 * Math.PI) / 180;
    expect(g.position[0]).toBeCloseTo(-(1.5 + half * Math.sin(a)), 9);
    expect(g.position[2]).toBeCloseTo(-2 + half * Math.cos(a), 9);
    // a BTR z is the cabinet CENTRE, Soundvision measures from the bottom
    expect(g.position[1]).toBeCloseTo(0.6 - KS28_H / 2, 9);
    expect(g.orientation).toEqual([0, -30, 0]);
  });

  it('is undone exactly by the reader-side inverse', () => {
    const at = svPlacement(4.2, -1.1, 0.3, -25);
    expect(fromSvPlacement(at.position, at.orientation)).toEqual({ refX: 4.2, refY: -1.1, bottomZ: 0.3, azimuthDeg: -25 });
  });

  it('writes a cabinet standing on the deck as a Soundvision ground of zero', () => {
    const m = toVendorModel(project([src({ position: { x: 0, y: 0, z: KS28_H / 2 } })]), builtinProvider);
    expect(toSoundvisionGeometry(m.sources[0]).position[1]).toBeCloseTo(0, 9);
  });

  it('drops a rolled cabinet to the deck by the height it is STANDING in', () => {
    // A KS28 on its end face is 1.34 m tall, not 0.55. Halving the datasheet
    // height instead put the exported cluster 0.39 m off the deck, which is
    // exactly the kind of silent half-box error the datum rule exists to stop.
    const onEnd = project([
      src({
        position: { x: 0, y: 0, z: KS28_W / 2 },
        rotation: { azimuthDeg: 0, elevationDeg: 0, rollDeg: 90 },
      }),
    ]);
    const m = toVendorModel(onEnd, builtinProvider);
    expect(toSoundvisionGeometry(m.sources[0]).position[1]).toBeCloseTo(0, 9);
  });

  it('leaves the height alone when the cabinet publishes none, and says which', () => {
    const p = project([src({ speakerId: UNMEASURED.id, position: { x: 0, y: 0, z: 1.2 } })], {
      customSpeakers: [UNMEASURED],
    });
    const m = toVendorModel(p, new CompositeSpeakerDataProvider(builtinProvider, [UNMEASURED]));
    // half of an unknown box is unknown, so nothing is subtracted
    expect(toSoundvisionGeometry(m.sources[0]).position[1]).toBe(1.2);
    expect(validateForTarget(m, 'soundvision').warnings.join(' ')).toMatch(
      /No cabinet height is published for unmeasured-sub/,
    );
  });

  it('applies the confirmed ArrayCalc inversions', () => {
    const m = toVendorModel(project([src({ position: { x: 15, y: 3, z: 0.6 }, rotation: { azimuthDeg: 40, elevationDeg: 0, rollDeg: 0 } })]), builtinProvider);
    const g = toArrayCalcGeometry(m.sources[0]);
    expect(g.originY).toBe(-15); // Y_ac = -X_sv   CONFIRMED
    expect(g.originX).toBe(3); //    X_ac =  Y_sv   depth
    expect(g.originZ).toBe(0.6); //  Z_ac =  Z_sv   CONFIRMED
    expect(g.horizontalAngle).toBe(-40); // az_ac = -az_sv  CONFIRMED
  });

  it('reproduces the golden reference table exactly', () => {
    // ArrayCalc Y | Soundvision X | ArrayCalc Horiz | Soundvision azimuth
    const table = [
      { svX: -15, svAz: -40, acY: 15, acHoriz: 40 },
      { svX: -5, svAz: 0, acY: 5, acHoriz: 0 },
      { svX: 5, svAz: 0, acY: -5, acHoriz: 0 },
      { svX: 15, svAz: 40, acY: -15, acHoriz: -40 },
    ];
    for (const row of table) {
      const m = toVendorModel(
        project([src({ position: { x: row.svX, y: 0, z: 0 }, rotation: { azimuthDeg: row.svAz, elevationDeg: 0, rollDeg: 0 } })]),
        builtinProvider,
      );
      const ac = toArrayCalcGeometry(m.sources[0]);
      expect(ac.originY).toBeCloseTo(row.acY, 9);
      expect(ac.horizontalAngle).toBeCloseTo(row.acHoriz, 9);
    }
  });

  it('keeps the cross-target identity for every source', () => {
    const m = toVendorModel(referenceProject(), builtinProvider);
    for (const s of m.sources) {
      const sv = toSoundvisionGeometry(s);
      const ac = toArrayCalcGeometry(s);
      // both files negate x and the azimuth; Soundvision then steps to the front face
      const a = (s.yaw_deg * Math.PI) / 180;
      expect(sv.position[0] + (KS28_D / 2) * Math.sin(a)).toBeCloseTo(ac.originY, 9);
      expect(sv.orientation[1]).toBeCloseTo(ac.horizontalAngle, 9);
    }
  });
});

describe('device mapping', () => {
  it('keeps KS28 as itself and falls back to KS28 for everything else', () => {
    expect(soundvisionDeviceFor('la-ks28').device.model).toBe('KS28');
    expect(soundvisionDeviceFor('la-ks28').isEquivalent).toBe(true);

    const foreign = soundvisionDeviceFor('db-b22-sub');
    expect(foreign.device.model).toBe('KS28');
    expect(foreign.isEquivalent).toBe(false);
    expect(foreign.device.verified).toBe(true);
  });

  it('only writes an unverified native L-Acoustics model when asked to', () => {
    expect(soundvisionDeviceFor('la-ks21').device.model).toBe('KS28'); // default: safe
    const native = soundvisionDeviceFor('la-ks21', true);
    expect(native.device.model).toBe('KS21');
    expect(native.device.verified).toBe(false);
  });

  it('reports the substitution when a native model is downgraded to the fallback', () => {
    // The one case the two-tier verified/native design used to invert: a model
    // that HAS a native entry, exported as something else because the entry is
    // unverified, was reported as not substituted. KS21 is 764x571x601 mm and
    // 138 dB; KS28 is 1340x550x719 mm and 143 dB. Silently swapping them
    // describes a different array in Soundvision.
    for (const id of ['la-ks21', 'la-sb18']) {
      const swapped = soundvisionDeviceFor(id);
      expect(swapped.device.model).toBe('KS28');
      expect(swapped.isEquivalent).toBe(false);
      expect(describeMapping('soundvision', [id])[0].substituted).toBe(true);
    }
    // and it stops being a substitution once the native model is actually asked for
    expect(soundvisionDeviceFor('la-ks21', true).isEquivalent).toBe(true);
    expect(describeMapping('soundvision', ['la-ks21'], true)[0].substituted).toBe(false);
  });

  it('calls a cardioid a substitution however the flag is set', () => {
    // A BTR cardioid is one cabinet with a modelled rear element; a vendor
    // cardioid is an arrangement of cabinets. No preset carries that, so what
    // goes out radiates omnidirectionally in the vendor's own prediction. That
    // is true whether the name on the device matches or not, which is why it
    // cannot be inferred from the model string.
    for (const nativeModels of [false, true]) {
      for (const id of ['la-ks28-cardioid', 'la-ks21-cardioid', 'la-sb18-cardioid']) {
        expect(soundvisionDeviceFor(id, nativeModels).isEquivalent).toBe(false);
        expect(describeMapping('soundvision', [id], nativeModels)[0].substituted).toBe(true);
      }
      // the plain models are unaffected by the cardioid rule
      expect(soundvisionDeviceFor('la-ks28', nativeModels).isEquivalent).toBe(true);
    }
  });

  it('distinguishes "no equivalent" from "equivalent withheld"', () => {
    // Both are substitutions, and the fix routed a new case into a sentence
    // written for the other one. A user told a KS21 has "no L-Acoustics
    // equivalent" goes looking for a product that is one checkbox away.
    const withheld = validateForTarget(
      toVendorModel(project([src({ speakerId: 'la-ks21' })]), builtinProvider),
      'soundvision',
    );
    expect(withheld.substitutions[0]).toContain('never been confirmed');
    expect(withheld.substitutions[0]).not.toContain('no L-Acoustics equivalent');

    const absent = validateForTarget(
      toVendorModel(project([src({ speakerId: 'db-b22-sub' })]), builtinProvider),
      'soundvision',
    );
    expect(absent.substitutions[0]).toContain('no L-Acoustics equivalent');
  });

  it('uses the confirmed SL-SUB speaker id and falls back to B2-SUB', () => {
    const sl = arraycalcDeviceFor('db-sl-sub');
    expect(sl.device).toMatchObject({ model: 'SL-SUB', speakerId: 114, verified: true });
    const other = arraycalcDeviceFor('la-ks28');
    expect(other.device).toMatchObject({ model: 'B2-SUB', speakerId: 24 });
    expect(other.isEquivalent).toBe(false);
  });

  it('describes what a target will do to a mixed project', () => {
    const rows = describeMapping('soundvision', ['la-ks28', 'db-b22-sub', 'nexo-msub18']);
    expect(rows.find((r) => r.btrSpeakerId === 'la-ks28')!.substituted).toBe(false);
    expect(rows.filter((r) => r.substituted).map((r) => r.model)).toEqual(['KS28', 'KS28']);
  });
});

describe('validation', () => {
  it('refuses a project with nothing audible', () => {
    const m = toVendorModel(project([src({ mute: true })]), builtinProvider);
    expect(validateForTarget(m, 'soundvision').errors[0]).toMatch(/No unmuted sources/);
  });

  it('reports substitutions with a count', () => {
    const m = toVendorModel(
      project([src({ id: 'a', speakerId: 'db-b22-sub' }), src({ id: 'b', speakerId: 'db-b22-sub' })]),
      builtinProvider,
    );
    const d = validateForTarget(m, 'soundvision');
    expect(d.errors).toEqual([]);
    expect(d.substitutions[0]).toMatch(/2 × "db-b22-sub".*exported as KS28/);
  });

  it('warns about what each format cannot carry', () => {
    const m = toVendorModel(
      project([src({ invertPolarity: true, rotation: { azimuthDeg: 0, elevationDeg: 5, rollDeg: 0 } })]),
      builtinProvider,
    );
    expect(validateForTarget(m, 'arraycalc').warnings.join(' ')).toMatch(/polarity/i);
    expect(validateForTarget(m, 'arraycalc').warnings.join(' ')).toMatch(/Pitch is not writable/i);
    // and a cabinet that is NOT rolled must not collect the roll warning, or the
    // sentence below means nothing.
    expect(validateForTarget(m, 'arraycalc').warnings.join(' ')).not.toMatch(/end face/i);
  });

  /*
   * Roll stopped being a rounding error the moment the interface exposed it. A
   * cabinet on its end face is a different shape in the world — width and
   * height swapped — so an export that silently drops the roll does not lose an
   * aim, it ships a box of the wrong shape. Neither format has the field, so
   * the diagnostic has to name the consequence rather than the omission.
   */
  it('says what dropping a roll actually costs', () => {
    const m = toVendorModel(
      project([src({ rotation: { azimuthDeg: 0, elevationDeg: 0, rollDeg: 90 } })]),
      builtinProvider,
    );
    for (const target of ['arraycalc', 'soundvision'] as const) {
      const w = validateForTarget(m, target).warnings.join(' ');
      expect(w).toMatch(/rolled about the front axis/i);
      expect(w).toMatch(/width and height the other way round/i);
    }
  });

  it('does not claim a swapped box for a cabinet that is merely upside down', () => {
    // 180 degrees about the front axis leaves the extents exactly as published,
    // so warning that the width and height come out the other way round
    // describes a change the export does not make.
    const m = toVendorModel(
      project([src({ rotation: { azimuthDeg: 0, elevationDeg: 0, rollDeg: 180 } })]),
      builtinProvider,
    );
    expect(validateForTarget(m, 'arraycalc').warnings.join(' ')).not.toMatch(/end face/i);
  });

  /*
   * The ArrayCalc leg is deliberately NOT given the Soundvision datum shift.
   * OriginZ is confirmed to be the vertical axis; which face of the cabinet d&b
   * measures it from is not confirmed anywhere, and a guess would move every
   * exported cabinet by half a box on nothing but a hunch. So the number goes
   * out as BTR holds it and the diagnostic says what that means.
   */
  it('tells the operator that the ArrayCalc height datum is unconfirmed', () => {
    const m = toVendorModel(referenceProject(), builtinProvider);
    expect(validateForTarget(m, 'arraycalc').warnings.join(' ')).toMatch(
      /not which face of the cabinet it measures/,
    );
    expect(validateForTarget(m, 'soundvision').warnings.join(' ')).not.toMatch(/which face/);
  });
});

describe('Soundvision writer', () => {
  const build = (p: BTRProject, native = false) => {
    const m = toVendorModel(p, builtinProvider);
    const doc = buildSvDocument(
      m.sources,
      m.groupName,
      (s) => soundvisionDeviceFor(s.btrSpeakerId, native).device,
      m.groupRelativeDelayMs,
    );
    return { m, doc, xml: writeSoundvisionXml(doc, SV_TEMPLATE) };
  };

  it('emits one cluster per source with the right geometry', () => {
    const { xml } = build(referenceProject());
    const positions = [...xml.matchAll(/<position>([^<]*)<\/position>/g)].map((x) => x[1]);
    expect(positions).toHaveLength(4);
    // File frame (−x, z_bottom, y) of the FRONT face: the cabinet at x −15
    // toed to −40 lands at file x +15.23 (its front face is 0.36 m ahead of
    // the centre, along the −40 heading), half a KS28 below its centre, and
    // 0.28 m forward in depth. On screen that is X −15.23, azimuth −40.
    const half = KS28_D / 2;
    const s40 = Math.sin((40 * Math.PI) / 180);
    const c40 = Math.cos((40 * Math.PI) / 180);
    const close = (got: string, want: number[]) =>
      got.split(' ').map(Number).forEach((v, i) => expect(v).toBeCloseTo(want[i], 8));
    close(positions[0], [15 + half * s40, -KS28_H / 2, half * c40]);
    close(positions[3], [-15 - half * s40, -KS28_H / 2, half * c40]);

    const orientations = [...xml.matchAll(/<orientation>([^<]*)<\/orientation>/g)].map((x) =>
      x[1].split(' ').map(Number),
    );
    expect(orientations[0]).toEqual([0, 40, 0]);
    expect(orientations[3]).toEqual([0, -40, 0]);
  });

  it('bakes the module offset into the cluster delay', () => {
    const { xml } = build(referenceProject());
    // anchor on <source_usage>: every enclosure has its own zeroed acoustics block first
    const acoustics = [
      ...xml.matchAll(
        /<acoustics><delay>([^<]*)<\/delay><gain>([^<]*)<\/gain><inverted>([01])<\/inverted><source_usage>/g,
      ),
    ].map((mm) => ({ delay: Number(mm[1]), gain: Number(mm[2]), inverted: Number(mm[3]) }));
    expect(acoustics).toHaveLength(4);
    // 12.4 design + 4.6 module = 17.0 total
    expect(acoustics[0].delay).toBeCloseTo(17.0, 6);
    expect(acoustics[1].delay).toBeCloseTo(4.9, 6);
    expect(acoustics[0].gain).toBeCloseTo(-6, 9);
    expect(acoustics[1].gain).toBeCloseTo(0, 9);
  });

  it('writes polarity inversion into the cluster that asked for it, on channel 1', () => {
    // Cluster order is channel order on the other side, and the cabinet that
    // plays backwards is the one box in a cardioid block that is patched and
    // processed differently — so it goes out first, whichever place it holds
    // in the project.
    const p = referenceProject();
    p.sources[1].invertPolarity = true;
    const { xml } = build(p);
    const inverted = [
      ...xml.matchAll(/<inverted>([01])<\/inverted><source_usage>/g),
    ].map((mm) => Number(mm[1]));
    expect(inverted).toEqual([1, 0, 0, 0]);
  });

  it('leaves a project with nothing reversed in the order it was built', () => {
    const p = referenceProject();
    const { xml } = build(p);
    const names = [...xml.matchAll(/<cluster><uid>[0-9a-f-]+<\/uid><name>([^<]*)<\/name>/g)].map((m) => m[1]);
    expect(names).toEqual(p.sources.map((s) => s.label));
  });

  it('substitutes foreign cabinets as KS28 and keeps the preset consistent', () => {
    const p = project([src({ speakerId: 'db-b22-sub' })]);
    const { xml } = build(p);
    expect(xml).toContain('<model>KS28</model>');
    expect(xml).not.toContain('B22');
    expect(xml).toContain('<preset>KS28_60</preset>');
  });

  it('writes a native model consistently in model and preset when opted in', () => {
    const p = project([src({ speakerId: 'la-ks21' })]);
    const { xml } = build(p, true);
    expect(xml).toContain('<model>KS21</model>');
    expect(xml).toContain('<preset>KS21_60</preset>');
    // the amplifier units must reference the same preset
    expect(xml).toMatch(/<channelSet><firstOutput>0<\/firstOutput><preset>KS21_60<\/preset>/);
  });

  it('produces well-formed XML with one amplifier unit per cluster', () => {
    const { xml } = build(referenceProject());
    expect((xml.match(/<unit><model>LA12X<\/model>/g) || []).length).toBe(4);
    expect((xml.match(/<cluster refId="/g) || []).length).toBe(4);
    // every <cluster> opened (4 source clusters + 4 refId params) is closed
    const opens = (xml.match(/<cluster><uid>/g) || []).length + (xml.match(/<cluster refId="/g) || []).length;
    expect(opens).toBe((xml.match(/<\/cluster>/g) || []).length);
  });

  it('is deterministic — the same project yields the same bytes', () => {
    expect(build(referenceProject()).xml).toBe(build(referenceProject()).xml);
  });

  it('derives stable, distinct uids', () => {
    expect(uidFor('a')).toBe(uidFor('a'));
    expect(uidFor('a')).not.toBe(uidFor('b'));
    expect(uidFor('a')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe.skipIf(!xmlcCodecAvailable())('Soundvision codec (needs the key, see xmlcCodec.ts)', () => {
  it('round-trips through AES-256-CBC with the ASCII key', async () => {
    const { encryptXmlc, decryptXmlc } = await import('./soundvision/xmlcCodec');
    const text = '<physical_configuration>hello ąę</physical_configuration>';
    const ct = await encryptXmlc(text);
    expect(ct.length % 16).toBe(0);
    expect(await decryptXmlc(ct.buffer as ArrayBuffer)).toBe(text);
  });

  it('decrypts a real Soundvision golden file to the expected plaintext', async () => {
    const { decryptXmlc } = await import('./soundvision/xmlcCodec');
    // the shipped template is the decrypted form of the handoff's golden .xmlc
    const { encryptXmlc } = await import('./soundvision/xmlcCodec');
    const ct = await encryptXmlc(SV_TEMPLATE);
    expect(await decryptXmlc(ct.buffer as ArrayBuffer)).toBe(SV_TEMPLATE);
  });
});

describe.runIf(!xmlcCodecAvailable())('a build without the Soundvision key', () => {
  it('says why it cannot export instead of failing on the button', () => {
    const d = soundvisionExporter.describe(project([src()]), builtinProvider);
    expect(d.errors[0]).toBe(XMLC_UNAVAILABLE);
  });

  it('refuses an encrypted .xmlc with the same reason', async () => {
    const f = new File([new Uint8Array(32)], 'x.xmlc');
    await expect(soundvisionImporter.read(f)).rejects.toThrow(XMLC_UNAVAILABLE);
  });
});

describe('ArrayCalc writer', () => {
  it('does not carry the template group uid into every export', async () => {
    // Cluster uids were always derived from the project; the group's was not, so
    // one constant from the Soundvision file the template came from went out in
    // every export, fingerprinting them all to a single source document.
    const templateUid = /<group><uid>([0-9a-f-]+)<\/uid>/.exec(SV_TEMPLATE)?.[1];
    expect(templateUid).toBeTruthy();

    const m = toVendorModel(referenceProject(), builtinProvider);
    const doc = buildSvDocument(m.sources, m.groupName, (s) => soundvisionDeviceFor(s.btrSpeakerId).device, m.groupRelativeDelayMs);
    const xml = writeSoundvisionXml(doc, SV_TEMPLATE);

    expect(xml).not.toContain(templateUid!);
    expect(/<group><uid>([0-9a-f-]+)<\/uid>/.exec(xml)?.[1]).toBe(uidFor(`group:${m.groupName}`));
  });

  it('carries no identity out of the template', async () => {
    // The template is a real ArrayCalc project. Its ProjectInformation row held
    // the author's own user name, a password hash and two session timestamps,
    // and the writer only ever set ProjectName — so every file this program
    // wrote, on anyone's machine, carried all of them out.
    //
    // The forbidden strings are NOT written here. Spelling them out in a tracked
    // source file would move the leak rather than close it, so they are read
    // back out of the last committed version of the template and asserted absent
    // from the shipped one. That also makes the test self-maintaining: whatever
    // a future template happens to contain is what gets checked.
    const SQL = await initSqlJs();

    const identity = (bytes: Uint8Array) => {
      const db = new SQL.Database(bytes);
      const [row] = db.exec(
        'SELECT ProjectName, AuthorName, Password, Comment, ProjectDateTime, AuthorDateTime' +
          ' FROM ProjectInformation',
      )[0].values;
      db.close();
      const [projectName, authorName, password, comment, projectAt, authorAt] = row;
      return { projectName, authorName, password, comment, projectAt, authorAt };
    };

    // the shipped template
    const shipped = identity(AC_TEMPLATE);
    expect(shipped.authorName).toBe('');
    expect(shipped.password).toBe('');
    expect(shipped.comment).toBeNull();

    // the written output
    const model = toVendorModel(referenceProject(), builtinProvider);
    const written = identity(writeDbpr(SQL, AC_TEMPLATE, model));
    expect(written.projectName).toBe(model.projectName);
    expect(written.authorName).toBe('');
    expect(written.password).toBe('');
    expect(written.comment).toBeNull();
    expect(written.projectAt).toBe(written.authorAt);

    // And the writer must scrub, not merely inherit a clean template.
    //
    // The previous version of this check read the OLD template out of git and
    // asserted its strings were absent. Once the scrubbed template was
    // committed, every needle equalled the shipped value and the loop skipped
    // all of them: a guard that ran no assertions at all, on the one rule this
    // repository most needs held. It also made the suite require a git
    // checkout to pass.
    //
    // So plant the identity instead. A template carrying an author, a hash and
    // real session timestamps goes in; the exported bytes must come out clean
    // at the SQL level AND in the raw bytes, which is what `secure_delete`
    // in writeDbpr is for — an UPDATE frees the old cell rather than
    // overwriting it, so without the pragma the strings survive in page slack.
    const AUTHOR = 'SomeOperator42';
    const HASH = 'd41d8cd98f00b204e9800998ecf8427e0123456789a';
    const WHEN = '2031-04-17T09:12:33.000Z';

    const dirty = new SQL.Database(AC_TEMPLATE);
    dirty.run(
      'UPDATE ProjectInformation SET AuthorName=?, Password=?, Comment=?,' +
        ' ProjectDateTime=?, AuthorDateTime=?',
      [AUTHOR, HASH, `notes by ${AUTHOR}`, WHEN, WHEN],
    );
    const planted = dirty.export();
    dirty.close();

    // the plant really took, otherwise the rest of this proves nothing
    const before = identity(planted);
    expect(before.authorName).toBe(AUTHOR);
    expect(new TextDecoder('latin1').decode(planted)).toContain(AUTHOR);

    const scrubbed = writeDbpr(SQL, planted, model);
    const after = identity(scrubbed);
    expect(after.authorName).toBe('');
    expect(after.password).toBe('');
    expect(after.comment).toBeNull();
    expect(after.projectAt).not.toBe(WHEN);
    expect(after.authorAt).not.toBe(WHEN);

    const bytes = new TextDecoder('latin1').decode(scrubbed);
    for (const needle of [AUTHOR, HASH, WHEN]) {
      expect(bytes, `${needle} survived into the exported bytes`).not.toContain(needle);
    }
  });

  async function exportRows(p: BTRProject) {
    const SQL = await initSqlJs();
    const model = toVendorModel(p, builtinProvider);
    const bytes = writeDbpr(SQL, AC_TEMPLATE, model);
    const db = new SQL.Database(bytes);
    const rows = db.exec(
      'SELECT c.CabinetId, c.SpeakerId, c.PositionIndex, c.OriginX, c.OriginY, c.OriginZ,' +
        ' c.HorizontalAngle, c.DeviceId, c.AmplifierChannel, a.Name, a.Level, a.Delay, a.Mute' +
        ` FROM Cabinets c JOIN CabinetsAdditionalData a USING(CabinetId) WHERE c.SourceGroupId=${SUBS_GROUP_ID}` +
        ' ORDER BY c.PositionIndex',
    );
    const groups = db.exec(`SELECT Name, RelativeDelay FROM SourceGroups WHERE SourceGroupId=${SUBS_GROUP_ID}`);
    const info = db.exec('SELECT ProjectName FROM ProjectInformation');
    const integrity = db.exec('PRAGMA integrity_check');
    const out = {
      rows: rows.length ? rows[0].values : [],
      group: groups[0].values[0],
      projectName: info[0].values[0][0],
      integrity: integrity[0].values[0][0],
      bytes,
      db,
    };
    return out;
  }

  it('writes a valid SQLite database that still passes integrity_check', async () => {
    const r = await exportRows(referenceProject());
    expect(r.integrity).toBe('ok');
    expect(new TextDecoder().decode(r.bytes.slice(0, 15))).toBe('SQLite format 3');
    r.db.close();
  });

  it('reproduces the golden project row for row', async () => {
    const r = await exportRows(referenceProject());
    expect(r.rows).toHaveLength(4);

    // [CabinetId, SpeakerId, PositionIndex, OriginX, OriginY, OriginZ, Horiz, DeviceId,
    //  AmplifierChannel, Name, Level, Delay, Mute]
    const originY = r.rows.map((x) => Number(x[4]));
    const horiz = r.rows.map((x) => Number(x[6]));
    const level = r.rows.map((x) => Number(x[10]));
    const delay = r.rows.map((x) => Number(x[11]));

    expect(originY).toEqual([15, 5, -5, -15]);
    expect(horiz).toEqual([40, 0, 0, -40]);
    expect(level).toEqual([-6, 0, 0, -6]);
    // Delay is the TOTAL, in seconds
    expect(delay[0]).toBeCloseTo(0.017, 9);
    expect(delay[1]).toBeCloseTo(0.0049, 9);

    // subs must stay unpatched or ArrayCalc would need amp/patch rows
    expect(r.rows.every((x) => Number(x[7]) === 0 && Number(x[8]) === 0)).toBe(true);
    expect(r.group[0]).toBe('SUBS');
    expect(Number(r.group[1])).toBeCloseTo(4.6, 9);
    expect(r.projectName).toBe('Example sub array');
    r.db.close();
  });

  it('applies the confirmed SpeakerId per model and substitutes the rest', async () => {
    const p = project([
      src({ id: 'a', speakerId: 'db-sl-sub', position: { x: 0, y: 0, z: 0 } }),
      src({ id: 'b', speakerId: 'nexo-msub18', position: { x: 2, y: 0, z: 0 } }),
    ]);
    const r = await exportRows(p);
    expect(r.rows.map((x) => Number(x[1]))).toEqual([114, 24]);
    expect(r.rows.map((x) => String(x[9]))).toEqual(['SL-SUB', 'B2-SUB']);
    r.db.close();
  });

  it('carries mute and drops the template cabinets it replaced', async () => {
    const p = project([src({ id: 'a' }), src({ id: 'b', mute: true, position: { x: 3, y: 0, z: 0 } })]);
    const r = await exportRows(p);
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map((x) => Number(x[12]))).toEqual([0, 1]);
    r.db.close();
  });

  it('preserves the untouched parts of the template', async () => {
    const SQL = await initSqlJs();
    const before = new SQL.Database(AC_TEMPLATE);
    const beforeTables = before.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0].values.flat();
    const beforeVersions = before.exec('SELECT COUNT(*) FROM TableVersions')[0].values[0][0];
    const beforeOther = before.exec('SELECT COUNT(*) FROM Cabinets WHERE SourceGroupId<>8')[0].values[0][0];
    before.close();

    const r = await exportRows(referenceProject());
    const after = new SQL.Database(r.bytes);
    const afterTables = after.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0].values.flat();
    expect(afterTables).toEqual(beforeTables);
    expect(after.exec('SELECT COUNT(*) FROM TableVersions')[0].values[0][0]).toBe(beforeVersions);
    // cabinets belonging to other groups must survive untouched
    expect(after.exec('SELECT COUNT(*) FROM Cabinets WHERE SourceGroupId<>8')[0].values[0][0]).toBe(beforeOther);
    after.close();
    r.db.close();
  });
});

describe('cross-target consistency', () => {
  it('both files describe the same array', async () => {
    const p = referenceProject();
    const m = toVendorModel(p, builtinProvider);

    const doc = buildSvDocument(m.sources, m.groupName, (s) => soundvisionDeviceFor(s.btrSpeakerId).device, m.groupRelativeDelayMs);
    const xml = writeSoundvisionXml(doc, SV_TEMPLATE);
    const svX = [...xml.matchAll(/<position>([^<]*)<\/position>/g)].map((x) => Number(x[1].split(' ')[0]));
    const svDelay = [
      ...xml.matchAll(
        /<acoustics><delay>([^<]*)<\/delay><gain>[^<]*<\/gain><inverted>[01]<\/inverted><source_usage>/g,
      ),
    ].map((x) => Number(x[1]));

    const SQL = await initSqlJs();
    const db = new SQL.Database(writeDbpr(SQL, AC_TEMPLATE, m));
    const rows = db.exec(
      'SELECT c.OriginY, a.Delay FROM Cabinets c JOIN CabinetsAdditionalData a USING(CabinetId)' +
        ` WHERE c.SourceGroupId=${SUBS_GROUP_ID} ORDER BY c.PositionIndex`,
    )[0].values;
    const acY = rows.map((x) => Number(x[0]));
    const acDelay = rows.map((x) => Number(x[1]) * 1000);
    db.close();

    for (let i = 0; i < 4; i++) {
      // both files negate x; Soundvision's sits on the front face, ±0.23 m at ±40°
      expect(svX[i]).toBeCloseTo(acY[i] - (KS28_D / 2) * Math.sin((p.sources[i].rotation.azimuthDeg * Math.PI) / 180), 7);
      expect(svDelay[i]).toBeCloseTo(acDelay[i], 6); // same total delay, both in ms
    }
  });
});
