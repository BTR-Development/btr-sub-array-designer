import { describe, expect, it } from 'vitest';
import { makeSource } from '../state/store';
import { builtinProvider } from '../speakers/provider';
import { buildDelaySheet, fmt, sheetRows, toCsv, toTsv, type SheetColumns } from './delaySheet';
import type { Group, Source } from '../core/types';

const COLS: SheetColumns = {
  array: 'Array', position: 'Pos', cabinet: 'Cab', model: 'Model', fb: 'F/B', x: 'X', y: 'Y', z: 'Z',
  azimuth: 'Az', delay: 'Delay', polarity: 'Pol', level: 'Level', mute: 'Mute',
  front: 'F', back: 'B', inverted: 'INV', yes: 'yes',
};

const group = (over: Partial<Group> = {}): Group => ({
  id: 'g1', name: 'SUB ARRAY 1', offset: { x: 0, y: 0, z: 0 }, rotationOffsetDeg: 0,
  anchor: { x: 0, y: 0, z: 0 }, levelOffsetDb: 0, delayOffsetS: 0, mute: false, ...over,
});

/** three cardioid positions of two KS28 across the stage, right to left in the list */
function cardioidRow(): Source[] {
  const out: Source[] = [];
  for (const [i, x] of [[0, 4], [1, -4], [2, 0]] as const) {
    const front = { ...makeSource('la-ks28', `F${i}`, { x, y: 0, z: 0.275 }), groupId: 'g1', positionKey: `p${i}` };
    const back = {
      ...makeSource('la-ks28', `B${i}`, { x, y: 0, z: 0.825 }),
      groupId: 'g1',
      positionKey: `p${i}`,
      rotation: { azimuthDeg: 180, elevationDeg: 0, rollDeg: 0 },
      invertPolarity: true,
      gradientDelayS: 0.0035,
    };
    out.push(back, front);
  }
  return out;
}

const input = (sources: Source[], groups: Group[]) => ({
  project: { name: 'Gig', author: 'Karol' },
  sources,
  groups,
  sim: { temperatureC: 20, speedOfSound: 343.2 },
  provider: builtinProvider,
  now: new Date(2026, 10, 3),
});

describe('buildDelaySheet', () => {
  it('numbers positions along the array and puts the bottom box first', () => {
    const sheet = buildDelaySheet(input(cardioidRow(), [group()]), 'Loose');
    expect(sheet.arrays).toHaveLength(1);
    const [a] = sheet.arrays;
    expect(a.positions.map((p) => p.cabinets[0].x)).toEqual([-4, 0, 4]);
    for (const p of a.positions) {
      expect(p.cabinets.map((c) => c.reversed)).toEqual([false, true]);
      expect(p.cabinets[0].z).toBeLessThan(p.cabinets[1].z);
    }
    expect(sheet.date).toBe('2026-11-03');
    expect(sheet.grade).toBe('C');
    expect(sheet.cabinetCount).toBe(6);
  });

  it('gives the RESULTANT delay and level, and the world position, with the array offsets in', () => {
    const g = group({ delayOffsetS: 0.002, levelOffsetDb: -3, offset: { x: 10, y: 5, z: 0 }, rotationOffsetDeg: 90 });
    const sources = cardioidRow().map((s) => ({ ...s, delayS: 0.001, levelDb: -1 }));
    const sheet = buildDelaySheet(input(sources, [g]), 'Loose');
    const a = sheet.arrays[0];
    expect(a.delayOffsetMs).toBeCloseTo(2);
    const all = a.positions.flatMap((p) => p.cabinets);
    const back = all.find((c) => c.label === 'B0')!;
    const front = all.find((c) => c.label === 'F0')!;
    expect(front.delayMs).toBeCloseTo(1 + 2, 9);
    expect(back.delayMs).toBeCloseTo(1 + 3.5 + 2, 9);
    expect(front.levelDb).toBeCloseTo(-4, 9);
    expect(back.inverted).toBe(true);
    // turned 90 degrees about the anchor and moved: (4, 0) -> (0, -4) -> (10, 1)
    expect(front.x).toBeCloseTo(10, 6);
    expect(front.y).toBeCloseTo(1, 6);
    expect(front.azimuthDeg).toBeCloseTo(90, 9);
    expect(back.azimuthDeg).toBeCloseTo(-90, 9);
    // the array turned 90 degrees now runs along Y, so numbering follows Y
    const ys = a.positions.map((p) => p.cabinets[0].y);
    expect([...ys].sort((p, q) => p - q)).toEqual(ys);
  });

  it('lists cabinets outside any array under their own heading, and flags a negative delay', () => {
    const loose = { ...makeSource('la-ks21', 'L1', { x: 0, y: 2, z: 0.3 }), delayS: -0.0015 };
    const sheet = buildDelaySheet(input([...cardioidRow(), loose], [group()]), 'Loose');
    expect(sheet.arrays.map((a) => a.name)).toEqual(['SUB ARRAY 1', 'Loose']);
    expect(sheet.negativeMinMs).toBeCloseTo(-1.5, 9);
    expect(sheet.grade).toBe('C');
    expect(sheet.models.map((m) => m.grade).sort()).toEqual(['C', 'C']);
  });

  it('does not count a muted cabinet against the delays', () => {
    const loose = { ...makeSource('la-ks21', 'L1', { x: 0, y: 2, z: 0.3 }), delayS: -0.0015, mute: true };
    expect(buildDelaySheet(input([loose], []), 'Loose').negativeMinMs).toBeNull();
  });
});

describe('the sheet as text', () => {
  const sheet = () => buildDelaySheet(input(cardioidRow().map((s) => ({ ...s, delayS: 0.0012 })), [group()]), 'Loose');

  it('writes one row per cabinet under a header', () => {
    const rows = sheetRows(sheet(), COLS, 'en');
    expect(rows).toHaveLength(7);
    expect(rows[0][0]).toBe('Array');
    expect(rows[1]).toEqual(['SUB ARRAY 1', '1', 'F1', 'L-Acoustics KS28', 'F', '-4.00', '0.00', '0.28', '0.0', '1.20', '', '0.0', '']);
    expect(rows[2].slice(4, 11)).toEqual(['B', '-4.00', '0.00', '0.82', '180.0', '4.70', 'INV']);
  });

  it('uses a decimal comma and a semicolon where the language does, and keeps the diacritics', () => {
    const rows = sheetRows(sheet(), { ...COLS, array: 'Szyk;główny' }, 'pl');
    expect(rows[1][9]).toBe('1,20');
    const csv = toCsv(rows, 'pl');
    expect(csv.startsWith('﻿"Szyk;główny";Pos;')).toBe(true);
    expect(csv).toContain(';1,20;');
    expect(toCsv(sheetRows(sheet(), COLS, 'en'), 'en')).toContain(',1.20,');
  });

  it('pastes as tab-separated cells', () => {
    const tsv = toTsv(sheetRows(sheet(), COLS, 'en'));
    expect(tsv.split('\n')[1].split('\t')).toHaveLength(13);
  });

  it('never prints minus zero', () => {
    expect(fmt(-0.0001, 2, 'en')).toBe('0.00');
    expect(fmt(1.5, 1, 'pl', true)).toBe('+1,5');
  });
});
