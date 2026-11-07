import { useStore } from '../state/store';
import { ColorScale } from './ColorScale';
import { Inspector } from './Inspector';
import { Splitter } from './Splitter';
import { NumField, SegButtons } from './widgets';
import { holdDraft } from './holdDraft';
import { useSize } from './useSize';
import { useT } from '../i18n/useT';
import { areaSize, planeAxes, scaleAreaTo } from '../render/view';
import type { GridResult } from '../engine/types';
import type { PredictionState } from '../state/usePrediction';
import type { GroundModel, Quality } from '../core/types';
import type { PaletteId } from '../render/colormap';
import { THIRD_OCTAVE_HZ, bandLabel, bandOf } from '../core/bands';

/**
 * Colour scale, signal selection and calculation control — the instrumentation
 * side of the workspace. Below them, the inspector for whatever is selected.
 *
 * No absolute SPL appears here by design: levels in this program are relative to
 * the loudest point of the solve, because the map is read for distribution, not
 * for loudness.
 */
export function RightColumn({ prediction }: { prediction: PredictionState }) {
  const s = useStore();
  const t = useT();
  const pink = s.sim.signal === 'pink';
  const result: GridResult | null = prediction.result;
  const colSize = useSize('rightW', 'x');
  const colourSize = useSize('rightColourH', 'y');
  const signalSize = useSize('rightSignalH', 'y');
  const calcSize = useSize('rightCalcH', 'y');

  return (
    <aside className="col right-col" style={colSize}>
      <div className="col-scroll">
        {/* ─────────────────────────────────────────────────────── colour ── */}
        <section className="panel sized" style={colourSize}>
          <header className="panel-head" title={t('right.colourNote')}>
            {t('right.colour')}
          </header>
          <div className="panel-body">
            <div className="colour-row">
              <ColorScale result={result} />
              <div className="colour-ctls">
                <div className="ctl-stack">
                  {t('right.palette')}
                  <SegButtons<PaletteId>
                    label={t('right.palette')}
                    value={s.palette}
                    onChange={(v) => s.setPalette(v)}
                    options={[
                      { value: 'spl', label: 'SPL', title: t('right.paletteSpl') },
                      { value: 'viridis', label: 'Viridis' },
                      { value: 'grayscale', label: t('right.paletteGrayShort'), title: t('right.paletteGray') },
                    ]}
                  />
                </div>
                <div className="ctl-stack">
                  {t('right.contour')}
                  <SegButtons<number>
                    label={t('right.contour')}
                    value={s.sim.dbPerDivision}
                    onChange={(v) => s.patchSim({ dbPerDivision: v })}
                    options={[
                      { value: 0, label: '0dB', title: t('right.contourSmooth') },
                      { value: 3, label: '3dB', title: t('right.contourBands', { n: 3 }) },
                      { value: 6, label: '6dB', title: t('right.contourBands', { n: 6 }) },
                    ]}
                  />
                </div>
                <div className="ctl-stack">
                  {t('right.window')}
                  <SegButtons<number>
                    label={t('right.window')}
                    value={s.sim.dynamicRangeDb}
                    onChange={(v) => s.patchSim({ dynamicRangeDb: v })}
                    options={[18, 30, 42].map((db) => ({ value: db, label: `${db}dB` }))}
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        <Splitter axis="y" target="prev" sizeKey="rightColourH" min={90} max={900} />

        {/* ───────────────────────────────────────────── signal selection ── */}
        <section className="panel sized" style={signalSize}>
          <header className="panel-head">
            {t('right.signal')}
          </header>
          <div className="panel-body">
            <div className="ctl-row">
              <label>{t('right.frequency')}</label>
              {/*
                A NumField, not a second copy of one. This was the same markup
                with its own handler, and so it kept the per-keystroke commit
                and the two limits that disagreed with each other: the input
                declared a floor of 5 Hz and the handler clamped at 1. The
                declared one wins - nothing in a subwoofer tool happens below
                5 Hz, and the lowest band the list offers is 16.
              */}
              <NumField
                label={t('right.frequency')}
                value={s.sim.frequencyHz}
                onChange={(v) => s.patchSim({ frequencyHz: v })}
                min={5}
                max={500}
                step={0.5}
                unit="Hz"
                disabled={pink}
              />
            </div>
            <input
              className="slider full"
              type="range"
              aria-label={t('right.frequency')}
              min={20}
              max={200}
              step={0.5}
              value={s.sim.frequencyHz}
              disabled={pink}
              onChange={(e) => s.patchSim({ frequencyHz: parseFloat(e.target.value) })}
              onPointerDown={holdDraft}
            />
            <div className="ctl-row">
              <label>{t('right.band')}</label>
              <select
                value={bandOf(s.sim.frequencyHz) ?? ''}
                disabled={pink}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (isFinite(v)) s.patchSim({ frequencyHz: v });
                }}
              >
                {bandOf(s.sim.frequencyHz) === null && <option value="">{t('right.custom')}</option>}
                {THIRD_OCTAVE_HZ.map((f) => (
                  <option key={f} value={f}>
                    {bandLabel(f)}
                  </option>
                ))}
              </select>
            </div>
            <div className="ctl-row">
              {/* Averaging width, not a frequency picker: the combo above chooses
                  WHICH third octave, this chooses whether the map is that whole
                  band, the single tone at its centre — or pink noise across its
                  own band, which makes the frequency controls above moot. */}
              <label>{t('right.averaging')}</label>
              <SegButtons<string>
                label={t('right.averaging')}
                value={pink ? 'pink' : String(s.sim.bandOct)}
                onChange={(v) => {
                  if (v === 'pink') s.patchSim({ signal: 'pink' });
                  else s.patchSim({ signal: 'tone', bandOct: parseFloat(v) });
                }}
                options={[
                  { value: '0', label: t('right.avgTone'), title: t('right.singleTone') },
                  { value: String(1 / 3), label: '1/3', title: t('right.thirdOctave') },
                  { value: '1', label: '1/1', title: t('right.fullOctave') },
                  { value: 'pink', label: t('right.avgPink'), title: t('right.pinkNoise') },
                ]}
              />
            </div>
            {pink && (
              <div className="ctl-row">
                {/* Krawędzie pasma szumu. Źródła są w tym programie płaskie
                    (bez charakterystyki obudowy), więc pasmo wybiera UŻYTKOWNIK
                    — program nie zgaduje, co skrzynia przenosi. */}
                <label title={t('right.pinkBandHint')}>{t('right.pinkBand')}</label>
                <NumField
                  label={t('right.pinkBand') + ' min'}
                  value={s.sim.pinkLoHz}
                  onChange={(v) => s.patchSim({ pinkLoHz: Math.max(5, Math.min(v, s.sim.pinkHiHz - 1)) })}
                  min={5}
                  max={499}
                  step={5}
                  unit="Hz"
                />
                <NumField
                  label={t('right.pinkBand') + ' max'}
                  value={s.sim.pinkHiHz}
                  onChange={(v) => s.patchSim({ pinkHiHz: Math.min(500, Math.max(v, s.sim.pinkLoHz + 1)) })}
                  min={6}
                  max={500}
                  step={5}
                  unit="Hz"
                />
              </div>
            )}
            <div className="ctl-row">
              <label>{t('right.ground')}</label>
              <select
                value={s.sim.ground}
                onChange={(e) => s.patchSim({ ground: e.target.value as GroundModel })}
              >
                <option value="off">{t('right.freeField')}</option>
                <option value="rigid">{t('right.rigidGround')}</option>
              </select>
            </div>
          </div>
        </section>

        <Splitter axis="y" target="prev" sizeKey="rightSignalH" min={70} max={600} />

        {/* ─────────────────────────────────────────── SPL calculation ──── */}
        <section className="panel sized" style={calcSize}>
          <header className="panel-head">
            {t('right.splCalc')}
          </header>
          <div className="panel-body">
            {/* Rozmiar płaszczyzny: dłuższy bok obszaru, skalowany WZGLĘDEM
                RIGU, z zachowaniem proporcji i jego miejsca na mapie — patrz
                scaleAreaTo. Pełne krawędzie zostają w "Obszarze predykcji";
                to pole jest od tego, co robi się najczęściej: "pokaż więcej". */}
            <div className="ctl-row">
              <label title={t('right.planeSizeHint')}>{t('right.planeSize')}</label>
              <NumField
                label={t('right.planeSize')}
                value={Math.round(areaSize(s.sim.area) * 10) / 10}
                onChange={(v) => {
                  const size = Math.min(1000, Math.max(5, v));
                  const pts = s.sources.map((x) => planeAxes(s.sim.plane, x.position));
                  const pivot: [number, number] = pts.length
                    ? [
                        (Math.min(...pts.map((p) => p[0])) + Math.max(...pts.map((p) => p[0]))) / 2,
                        (Math.min(...pts.map((p) => p[1])) + Math.max(...pts.map((p) => p[1]))) / 2,
                      ]
                    : [
                        (s.sim.area.xMin + s.sim.area.xMax) / 2,
                        (s.sim.area.vMin + s.sim.area.vMax) / 2,
                      ];
                  s.patchSim({ area: scaleAreaTo(s.sim.area, size, pivot) });
                }}
                min={5}
                max={1000}
                step={5}
                unit="m"
              />
            </div>
            <div className="ctl-row">
              <label>{t('right.grid')}</label>
              <span className="readout mono">
                {result ? `${result.nx}×${result.nv}` : '-'}
                <em>
                  {/* Rozmiar komórki: budżet siatki jest stały, więc większa
                      płaszczyzna to grubsze komórki — widać to tutaj, obok. */}
                  {result && result.nx > 1
                    ? ` · ${((result.xMax - result.xMin) / (result.nx - 1)).toFixed(2)} m`
                    : ''}
                  {result ? ` · ${result.computeMs.toFixed(0)} ms` : ''}
                  {prediction.usingWorker ? ' · worker' : ' · main'}
                </em>
              </span>
            </div>
            <div className="ctl-row">
              <label>{t('right.quality')}</label>
              <select
                value={s.sim.quality}
                onChange={(e) => s.patchSim({ quality: e.target.value as Quality })}
              >
                <option value="draft">{t('right.draft')}</option>
                <option value="normal">{t('right.normal')}</option>
                <option value="high">{t('right.high')}</option>
              </select>
            </div>

            <div className="calc-buttons">
              <button
                className={s.autocalculate ? 'on' : ''}
                onClick={() => s.setAutocalculate(!s.autocalculate)}
                title={t('right.autocalculateHint')}
              >
                {t('right.autocalculate')}
              </button>
              <button
                className={s.renderStale ? 'attention' : ''}
                disabled={s.autocalculate}
                onClick={() => s.recalculate()}
              >
                {t('right.recalculate')}
              </button>
            </div>
            {/* Only what the button alone cannot say: the map is frozen on purpose.
                A stale map says so on the map itself. */}
            {!s.autocalculate && !s.renderStale && <p className="panel-note">{t('right.noteFrozen')}</p>}
          </div>
        </section>

        <Splitter axis="y" target="prev" sizeKey="rightCalcH" min={70} max={600} />

        <Inspector />
      </div>
    </aside>
  );
}
