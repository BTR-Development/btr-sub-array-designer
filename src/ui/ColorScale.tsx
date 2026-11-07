import { colorForFraction, legendTicks } from '../render/colormap';
import { useStore } from '../state/store';
import { useT } from '../i18n/useT';
import { Icon } from './icons';
import type { GridResult } from '../engine/types';

/**
 * Relative SPL scale.
 *
 * Levels in this program are deliberately numberless: the map answers "where does
 * the energy go", not "how loud is it". So the ramp is anchored to the loudest
 * point of the current solve and every tick is dB below that peak — the same
 * mapping `colorize()` applies, so bar and plot always agree.
 */
const SEGMENTS = 64;

export function ColorScale({ result }: { result: GridResult | null }) {
  const s = useStore();
  const t = useT();
  const range = Math.max(1e-6, s.sim.dynamicRangeDb);
  const ticks = legendTicks(s.sim.dynamicRangeDb);
  // The SAME band count `colorize` uses for the map. Without it the map went
  // banded and this bar stayed smooth, so the legend described a picture that
  // was no longer on screen — harmless while nothing could switch banding on,
  // and wrong the moment the Contour control existed.
  const bands =
    s.sim.dbPerDivision && s.sim.dbPerDivision > 0
      ? Math.round(range / s.sim.dbPerDivision)
      : 0;

  const calibrated = s.calibratedRefDb != null;

  return (
    <div className="colorscale">
      {/* Dwuklik przypina czerwień do NAJGŁOŚNIEJSZEGO punktu bieżącego
          rozwiązania. Od tej chwili skala nie jedzie za głośnością: co
          głośniejsze od kalibracji, mapa maluje jednolitą bielą — +10 dB
          i +30 dB ponad nią wyglądają tak samo. Sam słupek się nie zmienia:
          u góry zawsze stoi czerwień, biel nie jest kolorem rampy, tylko
          znakiem "ponad nią". Kolejny dwuklik kalibruje od nowa. */}
      <div
        className="colorscale-bar"
        title={t(calibrated ? 'scale.calHintOn' : 'scale.calHint')}
        onDoubleClick={() => {
          if (result) s.setCalibratedRef(result.refDb);
        }}
      >
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <span
            key={i}
            style={{ background: colorForFraction(s.palette, 1 - (i + 0.5) / SEGMENTS, bands) }}
          />
        ))}
      </div>

      {calibrated && (
        <button
          className="colorscale-cal"
          title={t('scale.calOff')}
          onClick={() => s.setCalibratedRef(null)}
        >
          {t('scale.calibrated')} <Icon name="close" />
        </button>
      )}

      <div className="colorscale-ticks">
        {ticks.map((db) => (
          <i key={db} style={{ top: `${(-db / range) * 100}%` }}>
            {db === 0 ? '0 dB' : db}
          </i>
        ))}
      </div>

      {!result && <div className="colorscale-idle">{t('scale.noSolve')}</div>}
    </div>
  );
}
