/**
 * The third-octave series, which nothing in the suite imported.
 *
 * These thirteen numbers are not ours to choose: they are the ISO 266
 * preferred series, which is what a system engineer means when they say "the
 * 63". The band selector, the response chart's ticks and the frequency field's
 * "custom" state all read them, so a transposed digit — 315 for 31.5, 60 for
 * 63 — would quietly move a named band off the frequency it names.
 *
 * So the series is checked against the standard's own definition rather than
 * against a second copy of the list: ISO 266 builds the preferred frequencies
 * on the base-ten system, band n being 10^(n/10) Hz rounded to the published
 * value, and every one of them is inside 1% of that.
 */
import { describe, expect, it } from 'vitest';
import { bandLabel, bandOf, THIRD_OCTAVE_HZ } from './bands';

describe('the series', () => {
  it('is the ISO 266 preferred series, to within its own rounding', () => {
    // 16 Hz is band 12 (10^1.2 = 15.849), and the program predicts up to 250,
    // which is band 24 (10^2.4 = 251.19).
    THIRD_OCTAVE_HZ.forEach((hz, i) => {
      const exact = Math.pow(10, (12 + i) / 10);
      expect(Math.abs(hz - exact) / exact, `${hz} Hz`).toBeLessThan(0.01);
    });
  });

  it('runs from 16 to 250 with no band missing in between', () => {
    // The count follows from the two ends: bands 12..24 inclusive is 13 of
    // them. A dropped entry would still pass the ratio test above, because
    // every survivor would just be checked against the wrong band number —
    // which is why the ends and the length are pinned as well.
    expect(THIRD_OCTAVE_HZ).toHaveLength(13);
    expect(THIRD_OCTAVE_HZ[0]).toBe(16);
    expect(THIRD_OCTAVE_HZ[THIRD_OCTAVE_HZ.length - 1]).toBe(250);
  });

  it('rises, one third of an octave at a time', () => {
    const step = Math.pow(2, 1 / 3);
    for (let i = 1; i < THIRD_OCTAVE_HZ.length; i++) {
      const ratio = THIRD_OCTAVE_HZ[i] / THIRD_OCTAVE_HZ[i - 1];
      expect(ratio, `${THIRD_OCTAVE_HZ[i - 1]} -> ${THIRD_OCTAVE_HZ[i]}`).toBeGreaterThan(step * 0.97);
      expect(ratio, `${THIRD_OCTAVE_HZ[i - 1]} -> ${THIRD_OCTAVE_HZ[i]}`).toBeLessThan(step * 1.03);
    }
  });

  it('encloses the travel of the frequency slider', () => {
    // The slider runs 20..200 Hz. A series that stopped inside that leaves part
    // of the slider's own travel with no band to name, and the selector stuck
    // on "custom" where a named band exists.
    expect(THIRD_OCTAVE_HZ[0]).toBeLessThanOrEqual(20);
    expect(THIRD_OCTAVE_HZ[THIRD_OCTAVE_HZ.length - 1]).toBeGreaterThanOrEqual(200);
  });
});

describe('the label', () => {
  it('says the number the way it is spoken', () => {
    expect(bandLabel(31.5)).toBe('31.5 Hz');
    expect(bandLabel(63)).toBe('63 Hz');
  });

  it('never trails a zero onto a whole band', () => {
    // toFixed(1) here would print "63.0 Hz", which reads as a measured value
    // rather than the name of a band.
    for (const hz of THIRD_OCTAVE_HZ) expect(bandLabel(hz)).toBe(`${hz} Hz`);
  });
});

describe('which band a frequency is in', () => {
  it('recognises every band by its own centre', () => {
    for (const hz of THIRD_OCTAVE_HZ) expect(bandOf(hz)).toBe(hz);
  });

  it('says nothing for a frequency between bands', () => {
    // The field and the slider are free, so anything off the series has to read
    // as "custom" rather than being snapped to a neighbour. 31.6 is a tenth of
    // a hertz off 31.5 and is already not the 31.5 band.
    expect(bandOf(31.6)).toBeNull();
    expect(bandOf(70)).toBeNull();
    expect(bandOf(0)).toBeNull();
    expect(bandOf(1000)).toBeNull();
  });

  it('tolerates the rounding a slider introduces and nothing wider', () => {
    // The slider steps in halves of a hertz, so it lands on 31.5 exactly and
    // float arithmetic can still miss it by ~1e-13. The window is 0.01 Hz,
    // which admits that and admits nothing a user could have meant.
    expect(bandOf(31.5 + 1e-12)).toBe(31.5);
    expect(bandOf(63 - 0.009)).toBe(63);
    expect(bandOf(63 - 0.02)).toBeNull();
  });
});
