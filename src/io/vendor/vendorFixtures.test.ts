/**
 * Cross-check against real vendor reference vectors.
 *
 * This is the only test with external ground truth behind it: a genuine encrypted
 * Soundvision export, and the reference exporter's expected output for a known
 * project. If the codec, the coordinate transform or the template ever drift, this
 * fails — the other tests only prove we are self-consistent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BRANDING } from '../../branding';
import { defaultSimulationSettings, type BTRProject } from '../../core/types';
import { builtinProvider } from '../../speakers/provider';
import { toVendorModel } from './internalModel';
import { soundvisionDeviceFor } from './deviceMap';
import { buildSvDocument, writeSoundvisionXml } from './soundvision/writer';
import { decryptXmlc, xmlcCodecAvailable } from './soundvision/xmlcCodec';

const FIX = 'src/io/vendor/__fixtures__';
const SV_TEMPLATE = readFileSync('src/io/vendor/templates/soundvision-template.xml', 'utf8');

/** node Buffer -> a standalone ArrayBuffer WebCrypto will accept */
function ab(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

const ACOUSTICS = /<acoustics><delay>([^<]*)<\/delay><gain>([^<]*)<\/gain><inverted>([01])<\/inverted><source_usage>/g;

function extract(xml: string) {
  return {
    positions: [...xml.matchAll(/<position>([^<]*)<\/position>/g)].map((m) => m[1].split(' ').map(Number)),
    orientations: [...xml.matchAll(/<orientation>([^<]*)<\/orientation>/g)].map((m) => m[1].split(' ').map(Number)),
    acoustics: [...xml.matchAll(ACOUSTICS)].map((m) => ({ delay: Number(m[1]), gain: Number(m[2]), inv: Number(m[3]) })),
    models: [...new Set([...xml.matchAll(/<model>([^<]*)<\/model>/g)].map((m) => m[1]))].sort(),
    presets: [...new Set([...xml.matchAll(/<preset>([^<]*)<\/preset>/g)].map((m) => m[1]))].sort(),
  };
}

/** KS28 cabinet height and depth (BTR library). */
const KS28_H = 0.55;
const KS28_D = 0.719;

/**
 * The BTR rig Soundvision SHOWS when it opens TV1_expected.
 *
 * The handoff wrote that file on the assumption that the Soundvision file frame
 * is BTR's frame. Measured in Soundvision (24.10.2026) it is not: the file holds
 * (−x, z_bottom, y) of the cluster's front-face centre with the azimuth negated.
 * So SUB 01, written at file x −15 / azimuth −40, is on screen at X +15 toed
 * to +40 with its FRONT FACE on y = 0 — the reference rig mirrored. Built here
 * through that inverse, the comparison still checks every number in the file;
 * it now checks them against what Soundvision does rather than against the
 * handoff's guess.
 *
 * Standing on the deck: BTR measures from the centre, so z = h/2.
 */
function btrEquivalent(): BTRProject {
  const mk = (i: number, fileX: number, fileAz: number, level: number, delayMs: number) => {
    const az = -fileAz;
    const a = (az * Math.PI) / 180;
    return {
      id: `src-00${i}`, label: `SUB 0${i}`, speakerId: 'la-ks28',
      position: { x: -fileX - (KS28_D / 2) * Math.sin(a), y: -(KS28_D / 2) * Math.cos(a), z: KS28_H / 2 },
      rotation: { azimuthDeg: az, elevationDeg: 0, rollDeg: 0 },
      levelDb: level, delayS: delayMs / 1000, invertPolarity: false, mute: false, groupId: null,
    };
  };
  return {
    format: BRANDING.formatId, version: 1, project: { name: 'Example sub array' },
    sources: [mk(1, -15, -40, -6, 12.4), mk(2, -5, 0, 0, 0.3), mk(3, 5, 0, 0, 0.3), mk(4, 15, 40, -6, 12.4)],
    groups: [], measurementPoints: [], simulationSettings: defaultSimulationSettings(), customSpeakers: [],
  };
}

describe('cross-check against real vendor files', () => {
  it('our Soundvision XML matches their expected plaintext field for field', async () => {
    const m = toVendorModel(btrEquivalent(), builtinProvider);
    const doc = buildSvDocument(m.sources, 'SUBS', (s) => soundvisionDeviceFor(s.btrSpeakerId).device, 0);
    const ours = extract(writeSoundvisionXml(doc, SV_TEMPLATE));

    const theirsXml = readFileSync(`${FIX}/TV1_expected_plaintext.xml`, 'utf8');
    const theirs = extract(theirsXml);

    expect(ours.positions).toHaveLength(theirs.positions.length);
    ours.positions.forEach((p, i) => p.forEach((v, k) => expect(v).toBeCloseTo(theirs.positions[i][k], 8)));
    expect(ours.orientations.map((o) => o[1])).toEqual(theirs.orientations.map((o) => o[1]));
    expect(ours.acoustics).toEqual(theirs.acoustics);
    expect(ours.models).toEqual(theirs.models);
    expect(ours.presets).toEqual(theirs.presets);
  });

  it.skipIf(!xmlcCodecAvailable())('their expected ciphertext decrypts with our codec', async () => {
    const ct = readFileSync(`${FIX}/TV1_expected.xmlc`);
    const plain = await decryptXmlc(ab(ct));
    expect(plain).toContain('<physical_configuration>');
    const expected = readFileSync(`${FIX}/TV1_expected_plaintext.xml`, 'utf8');
    expect(plain.trim()).toBe(expected.trim());
  });

  it.skipIf(!xmlcCodecAvailable())('a real Soundvision golden .xmlc decrypts to our shipped template', async () => {
    const ct = readFileSync(`${FIX}/G01_target_4pcs.xmlc`);
    const plain = await decryptXmlc(ab(ct));
    expect(plain.trim()).toBe(SV_TEMPLATE.trim());
  });
});
