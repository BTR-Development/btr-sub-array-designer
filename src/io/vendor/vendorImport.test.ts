import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';

import { BRANDING } from '../../branding';
import {
  defaultSimulationSettings,
  speedOfSoundFromTemp,
  type BTRProject,
  type Source,
} from '../../core/types';
import { builtinProvider, CompositeSpeakerDataProvider } from '../../speakers/provider';
import { UNKNOWN_BOX } from '../../speakers/schema';
import { toVendorModel } from './internalModel';
import { soundvisionDeviceFor } from './deviceMap';
import { buildSvDocument, writeSoundvisionXml } from './soundvision/writer';
import { readSoundvisionXml } from './soundvision/reader';
import { writeDbpr } from './arraycalc/writeDbpr';
import { readDbpr } from './arraycalc/readDbpr';
import { sceneToProject } from './sceneToProject';
import { VendorReadError } from './importTypes';

const HERE = dirname(fileURLToPath(import.meta.url));
const SV_TEMPLATE = readFileSync(join(HERE, 'templates/soundvision-template.xml'), 'utf8');
const AC_TEMPLATE = new Uint8Array(readFileSync(join(HERE, 'templates/arraycalc-template.dbpr')));

const allGroups = (s: { groups: { id: string }[] }) => s.groups.map((g) => g.id);

function src(over: Partial<Source> = {}): Source {
  return {
    id: 's1', label: 'SUB 01', speakerId: 'la-ks28',
    position: { x: 0, y: 0, z: 0 },
    rotation: { azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 },
    levelDb: 0, delayS: 0, invertPolarity: false, mute: false, groupId: null,
    ...over,
  };
}

/** KS28 cabinet height; a BTR z is the centre, so the deck is half of it. */
const KS28_H = 0.55;

/** Four KS28 on the deck, outer pair toed and trimmed, 4.6 ms module offset. */
function referenceProject(): BTRProject {
  const mk = (i: number, x: number, az: number, level: number, delayMs: number) =>
    src({
      id: `src-00${i}`, label: `SUB 0${i}`,
      position: { x, y: 0, z: KS28_H / 2 },
      rotation: { azimuthDeg: az, elevationDeg: 0, rollDeg: 0 },
      levelDb: level, delayS: delayMs / 1000, groupId: 'g1',
    });
  return {
    format: BRANDING.formatId, version: 1, project: { name: 'Example sub array' },
    sources: [mk(1, -15, -40, -6, 12.4), mk(2, -5, 0, 0, 0.3), mk(3, 5, 0, 0, 0.3), mk(4, 15, 40, -6, 12.4)],
    groups: [{
      id: 'g1', name: 'SUBS', offset: { x: 0, y: 0, z: 0 }, rotationOffsetDeg: 0,
      anchor: { x: 0, y: 0, z: 0 }, levelOffsetDb: 0, delayOffsetS: 0.0046, mute: false,
    }],
    measurementPoints: [], simulationSettings: defaultSimulationSettings(), customSpeakers: [],
  };
}

/** Provider that also knows the placeholders an import created. */
function providerWith(customs: { id: string }[]) {
  return new CompositeSpeakerDataProvider(builtinProvider, customs as never);
}

describe('Soundvision reader', () => {
  it('reads a real Soundvision export', () => {
    const scene = readSoundvisionXml(SV_TEMPLATE);
    expect(scene.format).toBe('soundvision');
    expect(scene.groups).toHaveLength(1);

    // 4 clusters, two of which are 2-box stacks => 6 physical cabinets
    const s = scene.groups[0].sources;
    expect(s).toHaveLength(6);
    // The file says x −15 / azimuth −40 for the first cluster; Soundvision
    // shows it at X +15 toed to +40 (file frame measured 24.10.2026: x and
    // azimuth negated). The reader returns what the screen shows.
    expect(s.map((x) => x.x_m)).toEqual([15, 15, 5, -5, -15, -15]);
    expect(s.map((x) => x.yaw_deg)).toEqual([40, 40, 0, 0, -40, -40]);
    // height and depth are the file's second and third numbers, not the reverse
    expect(s.every((x) => x.z_m === 0 && x.y_m === 0 && x.frontRef)).toBe(true);
    expect(s.map((x) => x.delay_ms)).toEqual([12.4, 12.4, 0.3, 0.3, 12.4, 12.4]);
    expect(scene.groups[0].boxType).toBe('KS28');
  });

  it('anchors on source_usage instead of the zeroed enclosure blocks', () => {
    // every enclosure carries its own <delay>0</delay>; a loose parse reads those
    const scene = readSoundvisionXml(SV_TEMPLATE);
    expect(scene.groups[0].sources.some((s) => s.delay_ms === 12.4)).toBe(true);
    expect(scene.groups[0].sources.every((s) => s.delay_ms !== 0 || s.x_m === 0)).toBe(true);
  });

  it('flags multi-box clusters, whose per-box height is not in the file', () => {
    const scene = readSoundvisionXml(SV_TEMPLATE);
    expect(scene.warnings.join(' ')).toMatch(/stack of 2 cabinets/);
    expect(scene.groups[0].sources.filter((s) => s.stack).length).toBe(4);
  });

  it('refuses a file that is not a Soundvision configuration', () => {
    expect(() => readSoundvisionXml('<html><body>nope</body></html>')).toThrow(VendorReadError);
  });
});

describe('ArrayCalc reader', () => {
  async function read(bytes: Uint8Array) {
    return readDbpr(await initSqlJs(), bytes);
  }

  it('reads a real ArrayCalc project and converts coordinates', async () => {
    const scene = await read(AC_TEMPLATE);
    expect(scene.format).toBe('arraycalc');
    const subs = scene.groups.find((g) => g.name === 'SUBS')!;
    expect(subs.relativeDelayMs).toBeCloseTo(4.6, 6);
    expect(subs.looksLikeSubs).toBe(true);
    expect(subs.boxType).toBe('B2-SUB');

    // OriginY 15,5,-5,-15 (+2 stacked) -> neutral x = -OriginY
    expect(subs.sources.map((s) => s.x_m)).toEqual([-15, -15, -5, 5, 15, 15]);
    // HorizontalAngle 40,0,0,-40 -> yaw = -Horiz
    expect(subs.sources.map((s) => s.yaw_deg)).toEqual([-40, -40, 0, 0, 40, 40]);
  });

  it('recovers the design delay from the stored total', async () => {
    const scene = await read(AC_TEMPLATE);
    const subs = scene.groups.find((g) => g.name === 'SUBS')!;
    // stored 16.998053 ms - 4.6 = 12.4 ; stored 4.9 - 4.6 = 0.3
    expect(subs.sources[0].delay_ms).toBeCloseTo(12.4, 3);
    expect(subs.sources[2].delay_ms).toBeCloseTo(0.3, 3);
  });

  it('reads the non-sub group too, marked as not looking like subs', async () => {
    const scene = await read(AC_TEMPLATE);
    const other = scene.groups.find((g) => g.name !== 'SUBS')!;
    expect(other.looksLikeSubs).toBe(false);
    expect(other.sources.length).toBe(16);
  });

  it('refuses a file that is not SQLite', async () => {
    await expect(read(new TextEncoder().encode('not a database at all, really'))).rejects.toThrow(VendorReadError);
  });
});

describe('scene -> BTR project', () => {
  it('maps known vendor models onto library cabinets', async () => {
    const scene = readSoundvisionXml(SV_TEMPLATE);
    const r = sceneToProject(scene, allGroups(scene), builtinProvider);
    expect(r.stats.sources).toBe(6);
    expect(r.stats.placeholders).toBe(0);
    expect(new Set(r.project.sources.map((s) => s.speakerId))).toEqual(new Set(['la-ks28']));
    expect(r.diagnostics.mapping.join(' ')).toMatch(/6 × KS28 → BTR library cabinet/);
  });

  it('creates one flagged placeholder per unstocked vendor model', async () => {
    const scene = readDbpr(await initSqlJs(), AC_TEMPLATE);
    const r = sceneToProject(scene, allGroups(scene), builtinProvider);
    // B2-SUB, Linear and M4-act-70x50 are not in the BTR library
    expect(r.stats.placeholders).toBe(3);
    for (const ph of r.project.customSpeakers) {
      expect(ph.dimensions).toEqual({ widthM: null, heightM: null, depthM: null });
      expect(ph.dataQuality).toBe('D');
      expect(ph.proxyNote).toMatch(/dimensions and radiation are unknown/);
    }
    expect(r.diagnostics.warnings.join(' ')).toMatch(/not in the BTR library/);
  });

  it('turns the group relative delay into a BTR module offset', async () => {
    const scene = readDbpr(await initSqlJs(), AC_TEMPLATE);
    const r = sceneToProject(scene, [scene.groups.find((g) => g.name === 'SUBS')!.id], builtinProvider);
    expect(r.project.groups[0].delayOffsetS).toBeCloseTo(0.0046, 9);
    // design delay on the source, offset on the group => total is preserved
    const total = r.project.sources[0].delayS + r.project.groups[0].delayOffsetS;
    expect(total * 1000).toBeCloseTo(17.0, 3);
  });

  it('imports only the groups it was given', async () => {
    const scene = readDbpr(await initSqlJs(), AC_TEMPLATE);
    const subs = scene.groups.find((g) => g.name === 'SUBS')!;
    const r = sceneToProject(scene, [subs.id], builtinProvider);
    expect(r.stats.groups).toBe(1);
    expect(r.stats.sources).toBe(6);
  });

  /*
   * A Soundvision cluster position is the stack's GROUND height; a BTR position
   * is the cabinet's geometric centre. The old expectation here was [0, 0.55] —
   * this test pinning the missing half box, i.e. seating the bottom cabinet's
   * CENTRE on the deck and burying its lower half under it.
   */
  it('seats a Soundvision stack on the deck and spaces it by the cabinet height', () => {
    const H = 0.55; // KS28
    const scene = readSoundvisionXml(SV_TEMPLATE);
    const r = sceneToProject(scene, allGroups(scene), builtinProvider);
    // ±15 plus the half-depth step back from the front face at ±40°
    const stacked = r.project.sources.filter((s) => Math.abs(s.position.x) > 10);
    expect(stacked).toHaveLength(4);

    const zs = [...new Set(stacked.map((s) => s.position.z))].sort((a, b) => a - b);
    expect(zs).toHaveLength(2);
    expect(zs[0]).toBeCloseTo(H / 2, 9); // bottom face on the deck, not the centre
    expect(zs[1]).toBeCloseTo(H + H / 2, 9); // the boxes touch: one full height apart
  });

  it('seats a single cabinet the same way, stack or no stack', () => {
    const scene = readSoundvisionXml(SV_TEMPLATE);
    const r = sceneToProject(scene, allGroups(scene), builtinProvider);
    const single = r.project.sources.filter((s) => Math.abs(s.position.x) === 5);
    expect(single).toHaveLength(2);
    for (const s of single) expect(s.position.z).toBeCloseTo(0.55 / 2, 9);
    // the file places the FRONT face on y = 0; the box centre is half a KS28 behind it
    for (const s of single) expect(s.position.y).toBeCloseTo(-0.719 / 2, 9);
  });

  it('refuses to seat a cabinet whose height nobody published, and says so', () => {
    const scene = readSoundvisionXml(SV_TEMPLATE.replace(/<model>KS28<\/model>/g, '<model>MYSTERY-SUB</model>'));
    const r = sceneToProject(scene, allGroups(scene), builtinProvider);
    // an unknown vendor model imports as a placeholder with no dimensions at all
    expect(r.stats.placeholders).toBe(1);
    // no lift, because half of an unknown box is unknown: the bottom cabinet of
    // each cluster stays at the height the file gives. The spacing inside a
    // stack still falls back to the nominal drawing height, which is the one
    // substitution the import already declares.
    const zs = [...new Set(r.project.sources.map((s) => s.position.z))].sort((a, b) => a - b);
    expect(zs).toEqual([0, UNKNOWN_BOX.heightM]);
    expect(r.diagnostics.warnings.join(' ')).toMatch(/could not be seated on the deck/);
  });
});

describe('file sniffing', () => {
  /**
   * Regression: the encrypted/plaintext test must be a strict PREFIX check.
   * An earlier version asked whether the head merely *contained* '<', which is
   * true for roughly one encrypted file in five (0x3C turns up in random
   * ciphertext), and those files silently skipped decryption.
   */
  const isPlaintextXml = (bytes: Uint8Array): boolean => {
    let i = 0;
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
    while (i < bytes.length && bytes[i] <= 0x20) i++;
    const head = new TextDecoder('utf-8').decode(bytes.slice(i, i + 32));
    return head.startsWith('<?xml') || head.startsWith('<physical_configuration');
  };

  it('accepts real plaintext, with or without a BOM', () => {
    expect(isPlaintextXml(new TextEncoder().encode('<?xml version="1.0"?><physical_configuration/>'))).toBe(true);
    expect(isPlaintextXml(new TextEncoder().encode('\n  <physical_configuration></physical_configuration>'))).toBe(true);
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('<?xml ')]);
    expect(isPlaintextXml(bom)).toBe(true);
  });

  it('rejects ciphertext that happens to contain a "<" byte', () => {
    const ct = new Uint8Array(64);
    ct.fill(0x9a);
    ct[7] = 0x3c; // '<' — enough to fool a "contains" check
    expect(isPlaintextXml(ct)).toBe(false);
  });

  it('rejects the real encrypted fixture', () => {
    const ct = new Uint8Array(readFileSync(join(HERE, '__fixtures__/G01_target_4pcs.xmlc')));
    expect(isPlaintextXml(ct)).toBe(false);
    expect(ct.length % 16).toBe(0);
  });
});

describe('round trip', () => {
  it('BTR -> ArrayCalc -> BTR preserves geometry, level and delay', async () => {
    const SQL = await initSqlJs();
    const original = referenceProject();
    const model = toVendorModel(original, builtinProvider);
    const scene = readDbpr(SQL, writeDbpr(SQL, AC_TEMPLATE, model));

    const subs = scene.groups.find((g) => g.name === 'SUBS')!;
    const back = sceneToProject(scene, [subs.id], builtinProvider);

    expect(back.project.sources).toHaveLength(4);
    expect(back.project.sources.map((s) => s.position.x)).toEqual([-15, -5, 5, 15]);
    expect(back.project.sources.map((s) => s.rotation.azimuthDeg)).toEqual([-40, 0, 0, 40]);
    expect(back.project.sources.map((s) => s.levelDb)).toEqual([-6, 0, 0, -6]);
    expect(back.project.groups[0].delayOffsetS).toBeCloseTo(0.0046, 9);
    for (let i = 0; i < 4; i++) {
      expect(back.project.sources[i].delayS).toBeCloseTo(original.sources[i].delayS, 6);
    }
  });

  it('BTR -> Soundvision -> BTR preserves geometry and total delay', () => {
    const original = referenceProject();
    const model = toVendorModel(original, builtinProvider);
    const doc = buildSvDocument(
      model.sources, model.groupName,
      (s) => soundvisionDeviceFor(s.btrSpeakerId).device,
      model.groupRelativeDelayMs,
    );
    const scene = readSoundvisionXml(writeSoundvisionXml(doc, SV_TEMPLATE));
    const back = sceneToProject(scene, allGroups(scene), builtinProvider);

    expect(back.project.sources).toHaveLength(4);
    back.project.sources.forEach((s, i) => {
      expect(s.position.x).toBeCloseTo(original.sources[i].position.x, 8);
      expect(s.position.y).toBeCloseTo(original.sources[i].position.y, 8);
    });
    expect(back.project.sources.map((s) => s.rotation.azimuthDeg)).toEqual([-40, 0, 0, 40]);
    expect(back.project.sources.map((s) => s.levelDb)).toEqual([-6, 0, 0, -6]);
    /*
     * Height, which no round-trip test used to look at. The exporter writes the
     * ground the cluster stands on and the importer reads it back as a centre,
     * so the half box has to come off on the way out and go back on on the way
     * in. While only the importer did its half, this came back h/2 too high —
     * and every file BTR wrote for Soundvision stood half a box in the air.
     */
    for (const s of back.project.sources) expect(s.position.z).toBeCloseTo(KS28_H / 2, 9);
    // Soundvision has no group delay, so the module offset comes back folded in
    expect(back.project.groups[0].delayOffsetS).toBe(0);
    for (let i = 0; i < 4; i++) {
      const originalTotal = original.sources[i].delayS + 0.0046;
      expect(back.project.sources[i].delayS).toBeCloseTo(originalTotal, 6);
    }
  });

  it('carries polarity through Soundvision but not ArrayCalc', async () => {
    const SQL = await initSqlJs();
    const p = referenceProject();
    p.sources[1].invertPolarity = true;
    const model = toVendorModel(p, builtinProvider);

    const doc = buildSvDocument(model.sources, 'SUBS', (s) => soundvisionDeviceFor(s.btrSpeakerId).device, 0);
    const svScene = readSoundvisionXml(writeSoundvisionXml(doc, SV_TEMPLATE));
    // The reversed cabinet is written to channel 1, so it comes back first.
    // What has to survive is the FLAG and the geometry that goes with it, not
    // the index it happened to hold in the project.
    const back = sceneToProject(svScene, allGroups(svScene), builtinProvider).project;
    expect(back.sources.map((s) => s.invertPolarity)).toEqual([true, false, false, false]);
    expect(back.sources[0].label).toBe(p.sources[1].label);
    expect(back.sources[0].position.x).toBeCloseTo(p.sources[1].position.x, 6);
    // selecting no groups imports nothing
    expect(sceneToProject(svScene, [], builtinProvider).stats.sources).toBe(0);

    const acScene = readDbpr(SQL, writeDbpr(SQL, AC_TEMPLATE, model));
    const acSubs = acScene.groups.find((g) => g.name === 'SUBS')!;
    expect(sceneToProject(acScene, [acSubs.id], builtinProvider).project.sources.every((s) => !s.invertPolarity)).toBe(true);
  });

  /**
   * A Soundvision cluster of several enclosures is ONE physical pile with one
   * ground position: a cardioid block of four KS28 is a cluster, not four
   * cabinets that happen to share a coordinate. Expanded into loose sources it
   * arrived as four boxes the operator had to re-select by hand before they
   * could move what they had built as one object.
   */
  it('brings a multi-enclosure cluster in as one module, and several as a group of them', () => {
    const encl = '<enclosure><model>KS28</model></enclosure>';
    const acoustics =
      '<acoustics><delay>0.0</delay><gain>0.0</gain><inverted>0</inverted></acoustics>';
    const cluster = (name: string, n: number, x: number) =>
      `<cluster><uid>c0de-${x < 0 ? 1 : x > 0 ? 2 : 3}</uid><name>${name}</name><model>KS28</model>` +
      `<position>${x} 0 0</position><orientation>0 0 0</orientation>` +
      `<elements>${encl.repeat(n)}</elements>${acoustics}</cluster>`;
    const xml =
      '<physical_configuration><children><group><uid>aaaa-0001</uid><name>SUBS</name><ip>1</ip>' +
      '<children>' +
      cluster('STACK L', 4, -6) +
      cluster('STACK R', 4, 6) +
      cluster('FILL', 1, 0) +
      '</children><acoustics></acoustics></group></children></physical_configuration>';

    const scene = readSoundvisionXml(xml);
    const out = sceneToProject(scene, allGroups(scene), builtinProvider).project;
    expect(out.sources).toHaveLength(9);

    const byName = new Map(out.groups.map((g) => [g.name, g.id]));
    expect([...byName.keys()].sort()).toEqual(['STACK L', 'STACK R', 'SUBS']);
    const inGroup = (name: string) =>
      out.sources.filter((s) => s.groupId === byName.get(name)).length;
    expect(inGroup('STACK L')).toBe(4);
    expect(inGroup('STACK R')).toBe(4);
    // the single-box cluster stays where it was, in the vendor group
    expect(inGroup('SUBS')).toBe(1);
  });

  it('rebuilds the cabinet the file says is turned round, and says it computed the delay', () => {
    // Soundvision keeps ONE orientation per cluster, so the half-turn on a
    // cardioid enclosure is not in the geometry: it is in the enclosure's
    // configuration and in the amplifier preset. Read from the coordinates
    // alone, a cardioid block arrives as cabinets all facing the audience and
    // the thing it was built for is silently gone.
    const enc = (cardioid: boolean) =>
      `<enclosure><model>KS28</model><configuration>horizontal${cardioid ? '_cardioid' : ''}</configuration>` +
      `<preset>KS28_60_C_${cardioid ? 'R' : 'F'}</preset></enclosure>`;
    const xml =
      '<physical_configuration><children><cluster><uid>c0de-0001</uid><name>KS28 1</name>' +
      '<model>KS28</model><position>0 0 0</position><orientation>0 0 0</orientation>' +
      `<elements>${enc(true)}${enc(false)}${enc(false)}${enc(false)}</elements>` +
      '<acoustics><delay>0.0</delay><gain>0.0</gain><inverted>0</inverted></acoustics>' +
      '</cluster></children></physical_configuration>';

    const scene = readSoundvisionXml(xml);
    const r = sceneToProject(scene, scene.groups.map((g) => g.id), builtinProvider);
    const p = r.project;
    expect(p.sources).toHaveLength(4);
    expect(p.sources.map((x) => (x.invertPolarity ? 'B' : 'F')).join('')).toBe('BFFF');
    expect(p.sources[0].rotation.azimuthDeg).toBe(180);
    expect(p.sources.slice(1).every((x) => x.rotation.azimuthDeg === 0)).toBe(true);
    // one KS28 depth over c at 20 C, computed because the file cannot carry it
    expect(p.sources[0].delayS).toBeCloseTo(0.719 / speedOfSoundFromTemp(20), 9);
    expect(p.sources.slice(1).every((x) => x.delayS === 0)).toBe(true);
    expect(r.diagnostics.warnings.join(' ')).toMatch(/gradient delay computed from the cabinet depth/i);
  });

  it('leaves a plain cluster facing the way the file says', () => {
    // and the rule must not fire on an ordinary stack, or every import turns a
    // cabinet round that nobody asked it to.
    const enc = '<enclosure><model>KS28</model><configuration>horizontal</configuration></enclosure>';
    const xml =
      '<physical_configuration><children><cluster><uid>c0de-0002</uid><name>PLAIN</name>' +
      '<model>KS28</model><position>0 0 0</position><orientation>0 0 0</orientation>' +
      `<elements>${enc}${enc}</elements>` +
      '<acoustics><delay>0.0</delay><gain>0.0</gain><inverted>0</inverted></acoustics>' +
      '</cluster></children></physical_configuration>';
    const scene = readSoundvisionXml(xml);
    const r = sceneToProject(scene, scene.groups.map((g) => g.id), builtinProvider);
    expect(r.project.sources.every((x) => !x.invertPolarity && x.rotation.azimuthDeg === 0)).toBe(true);
    expect(r.project.sources.every((x) => x.delayS === 0)).toBe(true);
    expect(r.diagnostics.warnings.join(' ')).not.toMatch(/turned round/i);
  });

  it('does not leave an empty module behind when every cluster is a stack', () => {
    const encl = '<enclosure><model>KS28</model></enclosure>';
    const xml =
      '<physical_configuration><children><group><uid>aaaa-0001</uid><name>SUBS</name><ip>1</ip>' +
      '<children><cluster><uid>c0de-0001</uid><name>STACK</name><model>KS28</model>' +
      '<position>0 0 0</position><orientation>0 0 0</orientation>' +
      `<elements>${encl.repeat(2)}</elements>` +
      '<acoustics><delay>0.0</delay><gain>0.0</gain><inverted>0</inverted></acoustics>' +
      '</cluster></children><acoustics></acoustics></group></children></physical_configuration>';
    const out = sceneToProject(readSoundvisionXml(xml), ['aaaa-0001'], builtinProvider).project;
    expect(out.groups.map((g) => g.name)).toEqual(['STACK']);
    for (const g of out.groups) {
      expect(out.sources.some((s) => s.groupId === g.id), g.name).toBe(true);
    }
  });

  it('a placeholder from an import resolves through the project provider', async () => {
    const scene = readDbpr(await initSqlJs(), AC_TEMPLATE);
    const subs = scene.groups.find((g) => g.name === 'SUBS')!;
    const r = sceneToProject(scene, [subs.id], builtinProvider);
    const prov = providerWith(r.project.customSpeakers);
    for (const s of r.project.sources) expect(prov.get(s.speakerId)).toBeDefined();
  });
});
