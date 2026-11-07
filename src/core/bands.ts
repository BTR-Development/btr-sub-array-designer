/**
 * Standard 1/3-octave band centres (ISO 266 preferred series) across the range
 * this program predicts in. The engine works at a single continuous frequency;
 * these are only the values a system engineer actually asks for by name.
 */
export const THIRD_OCTAVE_HZ = [
  16, 20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250,
] as const;

/** Label as it is spoken: "31.5 Hz", not "31.50 Hz". */
export function bandLabel(hz: number): string {
  return `${hz} Hz`;
}

/**
 * The band a frequency sits in, or null when it is off the series. Used to tell
 * a band selector whether to show a band or "custom" — the frequency field and
 * slider remain free, so any value between bands stays reachable.
 */
export function bandOf(hz: number): number | null {
  return THIRD_OCTAVE_HZ.find((f) => Math.abs(f - hz) < 0.01) ?? null;
}
