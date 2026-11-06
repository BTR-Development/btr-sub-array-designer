import { describe, it, expect } from 'vitest';
import { BUILTIN_SPEAKERS } from './library';
import { buildCustomSpeaker, findProxy } from './proxy';
import { acousticOrigin, analyticCardioidDataset, boxSize } from './schema';
import { buildModels, validateRecord } from './loadExtra';

describe('library integrity', () => {
  it('has unique ids', () => {
    const ids = BUILTIN_SPEAKERS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('records provenance for every dimension set', () => {
    for (const m of BUILTIN_SPEAKERS) {
      expect(m.source?.dimensions, `${m.id} has no dimension provenance`).toBeTruthy();
      expect(m.source?.prediction, `${m.id} has no prediction provenance`).toBeTruthy();
    }
  });

  it('never ships a model claiming manufacturer prediction data', () => {
    // BTR ships no manufacturer prediction data: everything bundled is analytical.
    for (const m of BUILTIN_SPEAKERS) {
      expect(['C', 'D'], `${m.id} claims quality ${m.dataQuality}`).toContain(m.dataQuality);
    }
  });

  it('uses plausible physical dimensions where they are known', () => {
    for (const m of BUILTIN_SPEAKERS) {
      for (const [k, v] of Object.entries(m.dimensions)) {
        if (v == null) continue;
        expect(v, `${m.id}.${k}`).toBeGreaterThan(0.05);
        expect(v, `${m.id}.${k}`).toBeLessThan(3);
      }
    }
  });

  it('gives cardioid variants a two-element gradient model', () => {
    const cards = BUILTIN_SPEAKERS.filter((m) => m.type === 'cardioid');
    expect(cards.length).toBeGreaterThan(0);
    for (const m of cards) {
      expect(m.predictionData.kind).toBe('elements');
      if (m.predictionData.kind === 'elements') {
        expect(m.predictionData.elements).toHaveLength(2);
        expect(m.predictionData.elements[1].invert).toBe(true);
      }
    }
  });

  it('falls back to a nominal drawing size only when dimensions are unknown', () => {
    const known = BUILTIN_SPEAKERS.find((m) => m.id === 'la-ks28')!;
    expect(boxSize(known).unknown).toBe(false);
    expect(boxSize(known).widthM).toBe(1.34);
  });
});

describe('sourcing policy', () => {
  it('records a datasheet as a datasheet, with the page it was read from', () => {
    const rec = {
      id: 'x-sub', manufacturer: 'X', model: 'SUB',
      widthMm: 600, heightMm: 600, depthMm: 700,
      type: 'omnidirectional' as const,
      sourceUrl: 'https://example.com/sub-datasheet.pdf',
      sourceType: 'manufacturer-datasheet' as const,
      sourcePage: 3,
      retrieved: '2026-08-20',
      note: 'Dimensions W x H x D',
    };
    expect(validateRecord(rec)).toEqual([]);
    const [m] = buildModels([rec]);
    expect(m.source?.dimensions?.type).toBe('manufacturer-datasheet');
    expect(m.source?.dimensions?.note).toContain('p. 3');
    // A datasheet gives geometry and published specs, never a balloon — so it
    // cannot lift the acoustic grade on its own.
    expect(m.dataQuality).toBe('C');
  });

  it('still refuses a record with no source, and a guessed dimension', () => {
    expect(validateRecord({ id: 'a', manufacturer: 'A', model: 'B', type: 'omnidirectional',
      widthMm: 600, heightMm: 600, depthMm: 700, retrieved: '2026-08-20' }).join())
      .toContain('sourceUrl');
    expect(validateRecord({ id: 'a', manufacturer: 'A', model: 'B', type: 'omnidirectional',
      heightMm: 600, depthMm: 700, sourceUrl: 'https://x.test/d.pdf', retrieved: '2026-08-20' }).join())
      .toContain('widthMm');
  });

  it('rejects an unknown source kind rather than silently mislabelling it', () => {
    const errs = validateRecord({
      id: 'a', manufacturer: 'A', model: 'B', type: 'omnidirectional',
      widthMm: 600, heightMm: 600, depthMm: 700,
      sourceUrl: 'https://x.test/d.pdf', retrieved: '2026-08-20',
      sourceType: 'a-forum-post',
    });
    expect(errs.join()).toContain('sourceType');
  });
});

describe('custom speaker proxy selection', () => {
  it('respects the omni / cardioid split before anything else', () => {
    const m = findProxy(
      { name: 'x', widthM: 1.34, heightM: 0.55, depthM: 0.72, type: 'cardioid' },
      BUILTIN_SPEAKERS,
    );
    expect(m?.model.type).toBe('cardioid');
  });

  it('prefers the closest width among same-type candidates', () => {
    const small = findProxy(
      { name: 'x', widthM: 0.76, heightM: 0.57, depthM: 0.6, type: 'omnidirectional' },
      BUILTIN_SPEAKERS,
    );
    const big = findProxy(
      { name: 'x', widthM: 1.44, heightM: 0.6, depthM: 0.89, type: 'omnidirectional' },
      BUILTIN_SPEAKERS,
    );
    expect(small?.model.dimensions.widthM).toBeLessThan(1);
    expect(big?.model.dimensions.widthM).toBeGreaterThan(1.3);
  });

  it('marks the built model as a proxy and keeps the user dimensions', () => {
    const m = buildCustomSpeaker(
      { name: 'My Sub', widthM: 1.1, heightM: 0.5, depthM: 0.8, type: 'omnidirectional' },
      BUILTIN_SPEAKERS,
    );
    expect(m.dataQuality).toBe('D');
    expect(m.isCustom).toBe(true);
    expect(m.proxyOfId).toBeTruthy();
    expect(m.dimensions).toEqual({ widthM: 1.1, heightM: 0.5, depthM: 0.8 });
    expect(m.proxyNote).toMatch(/\w/);
  });

  it('borrows the proxy directivity, but never the proxy geometry', () => {
    // 1.34 m wide picks the SL-SUB (1.065 m deep, a REAL cardioid product) as
    // the proxy, while the cabinet the user drew is 0.40 m deep. Inheriting the
    // proxy's element dataset would put the rear radiator far outside this box
    // and quote another cabinet's cardioid delay for it.
    const m = buildCustomSpeaker(
      { name: 'C', widthM: 1.34, heightM: 0.55, depthM: 0.4, type: 'cardioid' },
      BUILTIN_SPEAKERS,
    );
    expect(m.proxyOfId).toBe('db-sl-sub');
    if (m.predictionData.kind !== 'elements') throw new Error('expected a gradient dataset');

    const rear = m.predictionData.elements[1];
    expect(rear.position.y).toBeCloseTo(-0.4, 9);
    expect(rear.delayS).toBeCloseTo(0.4 / 343, 9);

    // The elements are relative to the acoustic origin, which is the front
    // baffle, so the rear one lands exactly on the back baffle of the user's own
    // box rather than somewhere behind it.
    const backFaceFromCentre = -0.4 / 2;
    expect(acousticOrigin(m).y + rear.position.y).toBeCloseTo(backFaceFromCentre, 9);
  });

  it('does not lend the proxy its max SPL', () => {
    const m = buildCustomSpeaker(
      { name: 'C', widthM: 0.6, heightM: 0.6, depthM: 0.4, type: 'omnidirectional' },
      BUILTIN_SPEAKERS,
    );
    // the proxy has a published rating; this cabinet does not, and a proxy
    // rating would be read as a measurement AND used as a drive level
    expect(BUILTIN_SPEAKERS.find((x) => x.id === m.proxyOfId)!.maxSpl).toBeTruthy();
    expect(m.maxSpl).toBeNull();
  });

  it('keeps a max SPL the user states', () => {
    const m = buildCustomSpeaker(
      { name: 'C', widthM: 0.6, heightM: 0.6, depthM: 0.4, type: 'omnidirectional', maxSpl: 132 },
      BUILTIN_SPEAKERS,
    );
    expect(m.maxSpl).toBe(132);
  });
});

describe('a gradient cardioid needs a real separation', () => {
  it('refuses to build one without a published depth', () => {
    expect(() => analyticCardioidDataset(0)).toThrow(/published cabinet depth/);
    expect(() => analyticCardioidDataset(Number.NaN)).toThrow(/published cabinet depth/);
  });

  it('uses a small declared depth as declared instead of floors of 0.15 m', () => {
    const d = analyticCardioidDataset(0.09);
    expect(d.elements[1].position.y).toBeCloseTo(-0.09, 9);
  });

  it('separates every library cardioid by its own cabinet depth', () => {
    for (const m of BUILTIN_SPEAKERS.filter((x) => x.predictionData.kind === 'elements')) {
      if (m.predictionData.kind !== 'elements') continue;
      expect(m.dimensions.depthM, `${m.id} has a gradient model but no depth`).not.toBeNull();
      expect(m.predictionData.elements[1].position.y, m.id).toBeCloseTo(-m.dimensions.depthM!, 9);
    }
  });

  it('refuses a cardioid record that publishes no depth, instead of guessing one', () => {
    const rec = {
      id: 'x-card', manufacturer: 'X', model: 'CARD',
      widthMm: 600, heightMm: 600, depthMm: null,
      type: 'cardioid' as const,
      sourceUrl: 'https://example.com/card.pdf',
      retrieved: '2026-09-28',
    };
    expect(validateRecord(rec).join()).toContain('depthMm');
    expect(buildModels([rec])).toEqual([]);
    // the same record as an omni cabinet is fine: only the gradient needs the depth
    expect(validateRecord({ ...rec, type: 'omnidirectional' as const })).toEqual([]);
  });

  it('builds no "(cardioid)" twin, whatever a record asks for', () => {
    // The old `cardioidVariant` flag stamped an analytical gradient onto a
    // front-firing box and shipped it as a product. Removed: a cardioid in the
    // library is a cabinet that is cardioid in reality, and a cardioid rig made
    // of front-firing boxes is built the way it is on the deck — by reversing
    // cabinets in the position.
    const rec = {
      id: 'x-omni', manufacturer: 'X', model: 'OMNI',
      widthMm: 600, heightMm: 600, depthMm: 700,
      type: 'omnidirectional' as const,
      sourceUrl: 'https://example.com/omni.pdf',
      retrieved: '2026-09-28',
      cardioidVariant: true,
    };
    const models = buildModels([rec as never]);
    expect(models).toHaveLength(1);
    expect(models[0].model).not.toContain('(cardioid)');
  });
});
