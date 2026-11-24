// @vitest-environment jsdom
/**
 * Eksport Soundvision skalibrowany na pliku wzorcowym.
 *
 * WZORZEC: "untitled corrected perfect result (max left position)" z 22.10.2026
 * — lewa pozycja rigu 6 × 4 KS28 na boku, wzór F F B F, zbudowana
 * ręcznie w Soundvision tak, jak ma wyglądać. Pliku nie ma w repozytorium;
 * jego fakty są przepisane poniżej jako literały, pole po polu.
 *
 * UWAGA — wzorzec był zbudowany na LUSTRZANYM eksporcie. Pomiar w samym
 * Soundvision (24.10.2026, pliki-sondy) pokazał, że plik trzyma (−x, z, y)
 * środka przedniej ściany klastra i azymut z przeciwnym znakiem; stary eksport
 * pisał (x, y, z). Właściciel ustawił więc pozycję tam, gdzie na ekranie
 * wyglądała dobrze — w odbiciu. Z wzorca biorę to, czego odbicie nie zmienia
 * (konfiguracje, presety, delaye, wzmacniacz, kolejność slotów względem
 * odwróconej obudowy); położenie i numerację obudów — z pomiaru. Ta sama
 * pozycja, która we wzorcu ma odwróconą obudowę jako #3, ma ją teraz jako #2:
 * w Soundvision #1 to obudowa na końcu +X.
 *
 * Przed kalibracją ten sam rig wychodził jako 24 klastry po jednej obudowie,
 * z odwróconą obudową jako osobnym klastrem obróconym o 180° i z ręcznym d/c
 * i fazą — zamiast obudowy `horizontal_cardioid` z presetem KS28_60_C_R,
 * który realizuje gradient sam.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { useStore } from '../../state/store';
import { toVendorModel } from './internalModel';
import { soundvisionDeviceFor } from './deviceMap';
import { buildSvDocument, writeSoundvisionXml } from './soundvision/writer';
import { readSoundvisionXml } from './soundvision/reader';
import { sceneToProject } from './sceneToProject';

const st = () => useStore.getState();
const TPL = readFileSync('src/io/vendor/templates/soundvision-template.xml', 'utf8');

/** 6 pozycji × 4 KS28 na boku, F F B F, rozstaw 3.3 m — rig wzorcowy. */
function referenceRig(centreZ = 1.34 / 2) {
  st().createSubArray({ speakerId: 'la-ks28', count: 6, spacingM: 3.3, axis: 'x' });
  const ids = st().sources.map((x) => x.id);
  st().applyArrayLayout(ids, {
    count: 6,
    spacingM: 3.3,
    axis: 'x',
    centreM: 0,
    cross: { y: 0, z: centreZ },
    perPosition: 4,
    stackPitchM: 0.555,
    acrossM: 0.555,
    rollDeg: 90,
    reversePattern: [false, false, true, false],
    forwardAzimuthDeg: 0,
    reverseDelayS: 0.719 / st().sim.speedOfSound,
  });
}

function exportXml(): string {
  const m = toVendorModel(st().toProject(), st().provider);
  const doc = buildSvDocument(
    m.sources,
    m.groupName,
    (s) => soundvisionDeviceFor(s.btrSpeakerId).device,
    m.groupRelativeDelayMs,
  );
  return writeSoundvisionXml(doc, TPL);
}

const clustersOf = (xml: string) => xml.match(/<cluster><uid>[\s\S]*?<\/cluster>/g) ?? [];
/** X na EKRANIE Soundvision (= x BTR, przedniej ściany): plik trzyma −X */
const xOf = (c: string) => -Number(/<position>([^<]*)/.exec(c)![1].split(' ')[0]);

beforeEach(() => {
  st().newProject();
  useStore.setState({ undoStack: [], redoStack: [] });
});

describe('a position goes to Soundvision as one cluster, as built in the reference file', () => {
  it('six positions, six clusters of four — not 24 single boxes', () => {
    referenceRig();
    const cs = clustersOf(exportXml());
    expect(cs).toHaveLength(6);
    for (const c of cs) expect((c.match(/<enclosure>/g) ?? []).length).toBe(4);
  });

  it('the left position matches the reference, field by field', () => {
    referenceRig();
    const xml = exportXml();
    const left = clustersOf(xml).sort((a, b) => xOf(a) - xOf(b))[0]!;
    const head = left.slice(0, left.indexOf('<elements>'));
    const tail = left.slice(left.indexOf('</elements>'));

    expect(/<configuration>([^<]*)/.exec(head)![1]).toBe('horizontal_stacked');
    expect(/<deployment_orientation>([^<]*)/.exec(head)![1]).toBe('1');

    const encs = left.match(/<enclosure>[\s\S]*?<\/enclosure>/g)!;
    const enc = encs.map((e) => [
      /<configuration>([^<]*)/.exec(e)![1],
      /<preset>([^<]*)/.exec(e)![1],
      Number(/<acoustics><delay>([^<]*)/.exec(e)![1]),
      /<inverted>([01])/.exec(e)![1],
    ]);
    // #1 at the +X end: F F B F read left to right is F B F F from #1
    expect(enc).toEqual([
      ['horizontal', 'KS28_60_C_F', 0, '0'],
      // the reversed box: the PRESET does the gradient — no d/c, no inversion
      ['horizontal_cardioid', 'KS28_60_C_R', 0, '0'],
      ['horizontal', 'KS28_60_C_F', 0, '0'],
      ['horizontal', 'KS28_60_C_F', 0, '0'],
    ]);

    expect([...tail.matchAll(/<connection_set>([^<]*)<\/connection_set>/g)].map((m) => m[1])).toEqual([
      '',
      'horizontal/horizontal_cardioid',
      'horizontal_cardioid/horizontal',
      'horizontal/horizontal',
    ]);
    expect([...tail.matchAll(/<angle>([^<]*)<\/angle>/g)].map((m) => m[1])).toEqual([
      '',
      '0.000000000e+00',
      '0.000000000e+00',
      '0.000000000e+00',
    ]);
    const pos = /<position>([^<]*)/.exec(tail)![1].split(' ').map(Number);
    // file (−x, z_bottom, y) of the front face: on screen X −8.25 (middle of
    // the position), Z 0 (on the deck), Y +0.36 (half a KS28 ahead of centre)
    expect(pos[0]).toBeCloseTo(8.25, 6);
    expect(pos[1]).toBeCloseTo(0, 6);
    expect(pos[2]).toBeCloseTo(0.719 / 2, 6);
    expect(/<orientation>([^<]*)/.exec(tail)![1]).toBe('0.000000000e+00 0.000000000e+00 0.000000000e+00');
    const ca = /<acoustics><delay>([^<]*)<\/delay><gain>([^<]*)<\/gain><inverted>([01])<\/inverted><source_usage>/.exec(tail)!;
    expect([Number(ca[1]), Number(ca[2]), ca[3]]).toEqual([0, 0, '0']);

    // amplifier: one LA12X, one cardioid channel set, the reversed box on slot 1
    const uid = /<uid>([^<]*)/.exec(left)![1];
    const unit = xml.match(/<unit>[\s\S]*?<\/unit>/g)!.filter((u) => u.includes(uid));
    expect(unit).toHaveLength(1);
    expect(/<preset>([^<]*)/.exec(unit[0])![1]).toBe('KS28_60_C');
    // the slot rule (reference [2, 1, 0, 3]): reversed first, then
    // toward #1, then the rest — with the reversed box now #2
    expect([...unit[0].matchAll(/<indices>(\d+)<\/indices>/g)].map((m) => Number(m[1]))).toEqual([1, 0, 2, 3]);
  });

  it('the arc delay goes on the cluster, never the gradient a second time', () => {
    referenceRig();
    // an arc: the outer positions later than the inner, one time per position
    const byKey = new Map<string, string[]>();
    for (const x of st().sources) byKey.set(x.positionKey!, [...(byKey.get(x.positionKey!) ?? []), x.id]);
    const outer = [...byKey.values()].sort(
      (a, b) =>
        st().sources.find((x) => x.id === a[0])!.position.x -
        st().sources.find((x) => x.id === b[0])!.position.x,
    )[0];
    st().patchSources(outer, { delayS: 0.0095 });
    // EVERY cluster carrying a box of the left position (x −9.075 … −7.425)
    // says 9.5 ms and every enclosure in it 0 — including the reversed box,
    // whose 2.09 ms hidden gradient lives in the preset now. The per-box export
    // wrote that box as its own cluster at 11.6 ms: d/c on top of a preset
    // that already does d/c.
    const leftClusters = clustersOf(exportXml()).filter((c) => xOf(c) < -6);
    expect(leftClusters.length).toBeGreaterThan(0);
    for (const c of leftClusters) {
      const tail = c.slice(c.indexOf('</elements>'));
      const ca = /<acoustics><delay>([^<]*)<\/delay>[\s\S]*?<source_usage>/.exec(tail)!;
      expect(Number(ca[1])).toBeCloseTo(9.5, 6);
      for (const e of c.match(/<enclosure>[\s\S]*?<\/enclosure>/g)!) {
        expect(Number(/<acoustics><delay>([^<]*)/.exec(e)![1])).toBe(0);
      }
    }
  });

  it('our own reader takes the reversed box back as reversed', () => {
    referenceRig();
    const scene = readSoundvisionXml(exportXml());
    const srcs = scene.groups.flatMap((g) => g.sources);
    expect(srcs).toHaveLength(24);
    // three forward, one reversed in every cluster of four. The pattern is
    // mirrored about the array centre (F F B F left, F B F F right), so counted
    // from #1 at the +X end it is #2 on the left half and #3 on the right.
    const byCluster = new Map<string, { x: number; flags: boolean[] }>();
    for (const s of srcs) {
      const c = byCluster.get(s.cluster!.id) ?? { x: s.x_m, flags: [] };
      c.flags.push(!!s.reversed);
      byCluster.set(s.cluster!.id, c);
    }
    for (const { x, flags } of byCluster.values()) {
      expect(flags).toEqual(x < 0 ? [false, true, false, false] : [false, false, true, false]);
    }
  });

  it('round trip puts every box back where it was, the reversed one included', () => {
    referenceRig();
    const before = st().sources.map((x) => ({ x: x.position.x, y: x.position.y, z: x.position.z, inv: x.invertPolarity }));
    const scene = readSoundvisionXml(exportXml());
    const back = sceneToProject(scene, scene.groups.map((g) => g.id), st().provider).project.sources;
    expect(back).toHaveLength(24);
    // A Soundvision cluster has no gap between its boxes: the rig's 0.555 m
    // pitch comes back as the KS28's 0.55, so the outer boxes move ≤ 7.5 mm.
    for (const s of back) {
      const b = before.reduce((best, c) =>
        Math.hypot(c.x - s.position.x, c.z - s.position.z) < Math.hypot(best.x - s.position.x, best.z - s.position.z) ? c : best,
      );
      expect(Math.abs(b.x - s.position.x)).toBeLessThan(0.008);
      expect(s.position.z).toBeCloseTo(b.z, 6);
      expect(s.position.y).toBeCloseTo(b.y, 6);
      expect(s.invertPolarity).toBe(b.inv);
    }
  });
});

describe('an upright cardioid stack goes out as Soundvision writes one itself', () => {
  /** 1 pozycja, 2 KS28 w pionie, górna odwrócona */
  function stack() {
    st().createSubArray({ speakerId: 'la-ks28', count: 1, spacingM: 1, axis: 'x' });
    const ids = st().sources.map((x) => x.id);
    st().applyArrayLayout(ids, {
      count: 1,
      spacingM: 1,
      axis: 'x',
      centreM: 0,
      cross: { y: 0, z: 0.55 / 2 },
      perPosition: 2,
      stackPitchM: 0.55,
      acrossM: 0,
      rollDeg: 0,
      reversePattern: [false, true],
      forwardAzimuthDeg: 0,
      reverseDelayS: 0.719 / st().sim.speedOfSound,
    });
  }

  it('Columns, stacked / stacked_cardioid, connection sets per enclosure, one cardioid channel set', () => {
    stack();
    const byZ = [...st().sources].sort((a, b) => a.position.z - b.position.z);
    const xml = exportXml();
    const cs = clustersOf(xml);
    expect(cs).toHaveLength(1);
    const c = cs[0]!;
    const head = c.slice(0, c.indexOf('<elements>'));
    const tail = c.slice(c.indexOf('</elements>'));
    expect(/<configuration>([^<]*)/.exec(head)![1]).toBe('vertical_stacked');
    expect(/<deployment_orientation>([^<]*)/.exec(head)![1]).toBe('0');
    // #1 at the bottom; the turned box gets the cardioid enclosure and preset
    const encs = c.match(/<enclosure>[\s\S]*?<\/enclosure>/g)!.map((e) => [
      /<configuration>([^<]*)/.exec(e)![1],
      /<preset>([^<]*)/.exec(e)![1],
    ]);
    const card = (inv: boolean) => (inv ? ['stacked_cardioid', 'KS28_60_C_R'] : ['stacked', 'KS28_60_C_F']);
    expect(encs).toEqual(byZ.map((x) => card(x.invertPolarity)));
    // Soundvision's own save of such a stack (probe6): cfg[i], not a pair
    expect([...tail.matchAll(/<connection_set>([^<]*)<\/connection_set>/g)].map((m) => m[1])).toEqual([
      '',
      encs[1][0],
    ]);
    // Amplified like a row: one KS28_60_C channel set, the turned box first.
    // Checked in Soundvision 25.10: without a <unit> the stack loads
    // unamplified, and an EMPTY <units></units> is refused outright.
    const uid = /<uid>([^<]*)/.exec(c)![1] ?? '';
    const units = (xml.match(/<unit>[\s\S]*?<\/unit>/g) ?? []).filter((u) => u.includes(uid));
    expect(units).toHaveLength(1);
    expect(/<preset>([^<]*)/.exec(units[0]!)![1]).toBe('KS28_60_C');
    const rev = byZ.findIndex((x) => x.invertPolarity);
    expect([...units[0]!.matchAll(/<indices>(\d+)<\/indices>/g)].map((m) => Number(m[1]))).toEqual([rev, 1 - rev]);
    expect(xml).not.toContain('<units></units>');
    expect(/<nparallelMode>(\d)<\/nparallelMode>/.exec(xml)![1]).toBe('2');
    // bottom of the lowest box, front face half a KS28 ahead
    const pos = /<position>([^<]*)/.exec(tail)![1].split(' ').map(Number);
    expect(pos[1]).toBeCloseTo(byZ[0].position.z - 0.55 / 2, 6);
    expect(pos[2]).toBeCloseTo(0.719 / 2, 6);
  });
});
