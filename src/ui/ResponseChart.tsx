import { useMemo } from 'react';
import { computeSpectrumComplex, logFrequencies } from '../engine/engine';
import { resolveAll, toEngineSources } from '../state/resolve';
import { useStore } from '../state/store';
import { useT } from '../i18n/useT';
import type { Vec3 } from '../core/types';

const F_MIN = 20;
const F_MAX = 200;
const N = 180;
const W = 300;
const H_MAG = 118;
const H_PHASE = 74;
const H = H_MAG + H_PHASE;
const PAD_L = 30;
const PAD_B = 18;
const PAD_T = 8;
const PAD_R = 6;

const GRID_F = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200];
const LABEL_F = new Set([20, 31.5, 50, 80, 125, 200]);

const xOf = (f: number) =>
  PAD_L + ((Math.log10(f) - Math.log10(F_MIN)) / (Math.log10(F_MAX) - Math.log10(F_MIN))) * (W - PAD_L - PAD_R);

/**
 * Summed magnitude and phase at one point, 20–200 Hz.
 *
 * Magnitude alone is not enough to judge a sub array: two arrivals that look
 * flat can still be tearing through 360° across the crossover, and that is what
 * decides whether the subs add to the tops. So the phase runs underneath on the
 * same frequency axis, unwrapped, and both share the frequency cursor.
 */
export function ResponseChart({ position }: { position: Vec3 }) {
  const sources = useStore((s) => s.sources);
  const groups = useStore((s) => s.groups);
  const provider = useStore((s) => s.provider);
  const sim = useStore((s) => s.sim);
  const t = useT();

  const freqs = useMemo(() => logFrequencies(F_MIN, F_MAX, N), []);

  const { db, phase, lo, hi, pLo, pHi } = useMemo(() => {
    const engineSources = toEngineSources(resolveAll(sources, groups, provider));
    if (!engineSources.length) {
      return { db: null as Float32Array | null, phase: null as Float32Array | null, lo: 0, hi: 1, pLo: -180, pHi: 180 };
    }
    const spec = computeSpectrumComplex(engineSources, position, freqs, sim.speedOfSound, sim.ground);

    let max = -Infinity;
    for (const v of spec.db) if (isFinite(v) && v > max) max = v;
    const top = Math.ceil(max / 5) * 5;

    // The phase axis is padded out to whole half-turns so the gridlines land on
    // values an engineer reads directly (0, ±180, ±360…).
    let pMin = Infinity;
    let pMax = -Infinity;
    for (const v of spec.phaseDeg) {
      if (!isFinite(v)) continue;
      if (v < pMin) pMin = v;
      if (v > pMax) pMax = v;
    }
    if (!isFinite(pMin)) { pMin = -180; pMax = 180; }
    const span = Math.max(360, pMax - pMin);
    const mid = (pMax + pMin) / 2;
    return {
      db: spec.db,
      phase: spec.phaseDeg,
      lo: top - 40,
      hi: top,
      pLo: Math.floor((mid - span / 2) / 180) * 180,
      pHi: Math.ceil((mid + span / 2) / 180) * 180,
    };
  }, [sources, groups, provider, position, freqs, sim.speedOfSound, sim.ground]);

  const yMag = (v: number) => PAD_T + (1 - (v - lo) / (hi - lo)) * (H_MAG - PAD_T - PAD_B);
  const yPhase = (v: number) =>
    H_MAG + PAD_T + (1 - (v - pLo) / (pHi - pLo)) * (H_PHASE - PAD_T - PAD_B);

  const magPath = useMemo(() => {
    if (!db) return '';
    let d = '';
    for (let i = 0; i < db.length; i++) {
      const v = Math.max(lo - 5, Math.min(hi + 5, db[i]));
      d += `${i === 0 ? 'M' : 'L'}${xOf(freqs[i]).toFixed(2)},${yMag(v).toFixed(2)}`;
    }
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, lo, hi, freqs]);

  const phasePath = useMemo(() => {
    if (!phase) return '';
    let d = '';
    for (let i = 0; i < phase.length; i++) {
      d += `${i === 0 ? 'M' : 'L'}${xOf(freqs[i]).toFixed(2)},${yPhase(phase[i]).toFixed(2)}`;
    }
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, pLo, pHi, freqs]);

  if (!db || !phase) return <p className="hint">{t('rc.noSources')}</p>;

  const cursorX = xOf(Math.max(F_MIN, Math.min(F_MAX, sim.frequencyHz)));
  const dbTicks: number[] = [];
  for (let v = Math.ceil(lo / 10) * 10; v <= hi; v += 10) dbTicks.push(v);
  // A sub array's phase falls through many turns across 20-200 Hz, so a fixed
  // 180 deg tick would draw dozens of gridlines and stack their labels into an
  // unreadable smear. Step up through half-turn multiples until the axis carries
  // at most four divisions.
  const phaseTicks: number[] = [];
  let phaseStep = 180;
  while ((pHi - pLo) / phaseStep > 4) phaseStep *= 2;
  for (let v = Math.ceil(pLo / phaseStep) * phaseStep; v <= pHi; v += phaseStep) {
    phaseTicks.push(v);
  }

  return (
    <svg className="response-chart" viewBox={`0 0 ${W} ${H}`} width="100%">
      {/* ── magnitude ── */}
      <rect x={PAD_L} y={PAD_T} width={W - PAD_L - PAD_R} height={H_MAG - PAD_T - PAD_B} className="rc-bg" />
      {/* ── phase ── */}
      <rect
        x={PAD_L}
        y={H_MAG + PAD_T}
        width={W - PAD_L - PAD_R}
        height={H_PHASE - PAD_T - PAD_B}
        className="rc-bg"
      />

      {GRID_F.map((f) => (
        <g key={f}>
          <line x1={xOf(f)} y1={PAD_T} x2={xOf(f)} y2={H_MAG - PAD_B} className="rc-grid" />
          <line x1={xOf(f)} y1={H_MAG + PAD_T} x2={xOf(f)} y2={H - PAD_B} className="rc-grid" />
          {LABEL_F.has(f) && (
            <text x={xOf(f)} y={H - 6} className="rc-label" textAnchor="middle">
              {f}
            </text>
          )}
        </g>
      ))}

      {dbTicks.map((v) => (
        <g key={v}>
          <line x1={PAD_L} y1={yMag(v)} x2={W - PAD_R} y2={yMag(v)} className="rc-grid" />
          <text x={PAD_L - 4} y={yMag(v) + 3} className="rc-label" textAnchor="end">
            {v.toFixed(0)}
          </text>
        </g>
      ))}
      {phaseTicks.map((v) => (
        <g key={v}>
          <line x1={PAD_L} y1={yPhase(v)} x2={W - PAD_R} y2={yPhase(v)} className={v === 0 ? 'rc-grid zero' : 'rc-grid'} />
          <text x={PAD_L - 4} y={yPhase(v) + 3} className="rc-label" textAnchor="end">
            {v}
          </text>
        </g>
      ))}

      <line x1={cursorX} y1={PAD_T} x2={cursorX} y2={H_MAG - PAD_B} className="rc-cursor" />
      <line x1={cursorX} y1={H_MAG + PAD_T} x2={cursorX} y2={H - PAD_B} className="rc-cursor" />

      <path d={magPath} className="rc-trace" />
      <path d={phasePath} className="rc-trace phase" />

      <text x={PAD_L + 2} y={PAD_T + 9} className="rc-label">dB SPL</text>
      {/* "dB SPL" is a unit and stays put; only the quantity is translated. */}
      <text x={PAD_L + 2} y={H_MAG + PAD_T + 9} className="rc-label">{t('rc.phaseAxis')}</text>
    </svg>
  );
}
