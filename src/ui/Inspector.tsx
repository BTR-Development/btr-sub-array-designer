import { useEffect, useMemo, useRef } from 'react';
import { pinkBand } from '../core/types';
import { useStore, allSpeakers } from '../state/store';
import { Field, NumField, QualityBadge, Section } from './widgets';
import { holdDraft } from './holdDraft';
import { boxSize } from '../speakers/schema';
import { ResponseChart } from './ResponseChart';
import { computeBandLevel, computePoint } from '../engine/engine';
import type { EngineSource } from '../engine/types';
import { resolveAll, toEngineSources } from '../state/resolve';
import { useT } from '../i18n/useT';
import { QUALITY_KEY } from '../i18n';

const MS = 1000;

/** The keys a range input changes its value with. */
const SLIDER_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
]);

/** Distance equivalent of a delay at the current speed of sound. */
function delayHint(ms: number, c: number) {
  const m = (ms / MS) * c;
  return `${ms.toFixed(2)} ms ≈ ${m.toFixed(2)} m`;
}

export function Inspector() {
  const s = useStore();
  const t = useT();
  const customSpeakers = useStore((st) => st.customSpeakers);
  const inUse = [...new Set(s.sources.map((x) => x.speakerId))].join('|');
  const speakers = useMemo(() => allSpeakers(customSpeakers, inUse.split('|')), [customSpeakers, inUse]);

  const selected = s.sources.filter((x) => s.selectedSourceIds.includes(x.id));
  const point = s.measurementPoints.find((m) => m.id === s.selectedPointId) ?? null;

  if (point) return <PointInspector />;
  if (!selected.length) return <EmptyInspector />;

  const ids = selected.map((x) => x.id);
  const first = selected[0];
  const multi = selected.length > 1;
  const model = s.provider.get(first.speakerId);
  const same = <T,>(get: (x: typeof first) => T): T | null => {
    const v = get(first);
    return selected.every((x) => get(x) === v) ? v : null;
  };

  /**
   * Every numeric readout below is `null` when the selection disagrees, and the
   * field then renders blank rather than 0. A row of zeroes for eight cabinets
   * fanned at different azimuths is not a neutral default, it is a measurement
   * the program never took. Typing writes to all of them, exactly as the speaker
   * picker's "mixed" option does.
   */
  const posX = same((x) => x.position.x);
  const posY = same((x) => x.position.y);
  const posZ = same((x) => x.position.z);
  const azimuth = same((x) => x.rotation.azimuthDeg);
  // Kierunek zaznaczenia do pola azymutu: wspólny azymut, a gdy zaznaczenie
  // ma skrzynie odwrócone (kardioida), wspólny azymut tych NIEodwróconych —
  // wpisanie nowej wartości obraca wtedy całość, odwrócone zostają odwrócone.
  const forwardOnes = selected.filter((x) => !x.invertPolarity);
  const azimuthRef =
    azimuth ??
    (forwardOnes.length && forwardOnes.every((x) => x.rotation.azimuthDeg === forwardOnes[0].rotation.azimuthDeg)
      ? forwardOnes[0].rotation.azimuthDeg
      : null);
  const elevation = same((x) => x.rotation.elevationDeg);
  const roll = same((x) => x.rotation.rollDeg);
  // Obrót pozycji ma sens tylko dla obudów, które stoją w pozycji z innymi.
  const inPosition = selected.some(
    (x) => x.positionKey && s.sources.some((o) => o.id !== x.id && o.positionKey === x.positionKey),
  );
  const positionYaw = same((x) => x.positionYawDeg ?? 0);
  const level = same((x) => x.levelDb);
  const delayMs = same((x) => x.delayS * MS);

  return (
    <div className="inspector">
      <Section title={multi ? t('insp.selectedCount', { count: selected.length }) : first.label}>
        {!multi && (
          <Field label={t('insp.label')}>
            <input
              className="text-input"
              value={first.label}
              onChange={(e) => s.patchSources(ids, { label: e.target.value })}
            />
          </Field>
        )}
        <Field label={t('insp.speaker')}>
          <select
            className="text-input"
            value={same((x) => x.speakerId) ?? ''}
            onChange={(e) => s.patchSources(ids, { speakerId: e.target.value })}
          >
            {same((x) => x.speakerId) === null && <option value="">{t('insp.mixed')}</option>}
            {speakers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.manufacturer} {m.model}
              </option>
            ))}
          </select>
        </Field>
        {model && <SpeakerFacts modelId={model.id} />}
      </Section>

      <Section title={t('insp.position')}>
        <div className="row3">
          <Field label="X">
            <NumField
              value={posX ?? 0}
              mixed={posX === null}
              onChange={(v) => s.patchSources(ids, { position: { x: v } })}
              unit="m"
              step={0.05}
            />
          </Field>
          <Field label="Y">
            <NumField
              value={posY ?? 0}
              mixed={posY === null}
              onChange={(v) => s.patchSources(ids, { position: { y: v } })}
              unit="m"
              step={0.05}
            />
          </Field>
          <Field label="Z">
            <NumField
              value={posZ ?? 0}
              mixed={posZ === null}
              onChange={(v) => s.patchSources(ids, { position: { z: v } })}
              unit="m"
              step={0.05}
            />
          </Field>
        </div>
        {multi && <p className="hint">{t('insp.multiHint')}</p>}
      </Section>

      <Section title={t('insp.rotation')}>
        <div className="row2">
          <Field label={t('insp.azimuth')} hint={t('insp.azimuthHint')}>
            <NumField
              value={azimuthRef ?? 0}
              mixed={azimuthRef === null}
              onChange={(v) =>
                azimuthRef === null
                  ? // różne kierunki (np. wachlarz): jedna wpisana wartość dla
                    // każdej, w miejscu — to jest prostowanie, nie obrót
                    s.patchSources(ids, { rotation: { azimuthDeg: v } })
                  : // wspólny kierunek: obrót całego zaznaczenia jak bryły
                    s.rotateSelected(ids, v - azimuthRef)
              }
              unit="°"
              step={5}
            />
          </Field>
          <Field label={t('insp.elevation')}>
            <NumField
              value={elevation ?? 0}
              mixed={elevation === null}
              onChange={(v) => s.patchSources(ids, { rotation: { elevationDeg: v } })}
              unit="°"
              step={1}
              min={-90}
              max={90}
            />
          </Field>
        </div>
        <div className="row2">
          <Field label={t('insp.roll')} hint={t('insp.rollHint')}>
            <NumField
              value={roll ?? 0}
              mixed={roll === null}
              onChange={(v) => s.patchSources(ids, { rotation: { rollDeg: v } })}
              unit="°"
              step={90}
              min={-180}
              max={180}
            />
          </Field>
        </div>
        {inPosition && (
          <div className="row2">
            <Field label={t('insp.positionYaw')} hint={t('insp.positionYawHint')}>
              <NumField
                value={positionYaw ?? 0}
                mixed={positionYaw === null}
                onChange={(v) => s.rotatePositions(ids, v)}
                unit="°"
                step={5}
                min={-180}
                max={180}
              />
            </Field>
          </div>
        )}
        <div className="btn-row">
          <button onClick={() => bumpAz(ids, -90)}>−90°</button>
          <button onClick={() => bumpAz(ids, -15)}>−15°</button>
          <button onClick={() => bumpAz(ids, 15)}>+15°</button>
          <button onClick={() => bumpAz(ids, 90)}>+90°</button>
          <button onClick={() => bumpAz(ids, 180)}>180°</button>
        </div>
      </Section>

      <Section title={t('insp.gainDelay')}>
        <Field label={t('insp.level')}>
          <NumField
            value={level ?? 0}
            mixed={level === null}
            onChange={(v) => s.patchSources(ids, { levelDb: v })}
            unit="dB"
            step={0.5}
            min={-100}
            max={0}
          />
        </Field>
        {/* Disabled for a mixed selection. A slider has no "mixed" position to
            show, so it sat at 0 dB over a tapered array and the first click
            anywhere on it flattened the taper to whatever the click landed on.
            The field above still sets one level for the whole selection. */}
        <input
          className="slider"
          type="range"
          aria-label={t('insp.level')}
          min={-40}
          max={0}
          step={0.5}
          value={level ?? 0}
          disabled={level === null}
          title={level === null ? t('insp.mixed') : undefined}
          onChange={(e) => s.patchSources(ids, { levelDb: parseFloat(e.target.value) }, false)}
          onPointerDown={() => {
            s.snapshot();
            holdDraft();
          }}
          onKeyDown={(e) => {
            // The arrow keys fire no pointerdown, so keyboard use of this
            // slider wrote with no undo entry at all. Repeats are excluded: a
            // held key is one gesture, and one snapshot per repeat would bury
            // the history under forty near-identical states.
            if (!e.repeat && SLIDER_KEYS.has(e.key)) s.snapshot();
          }}
        />
        <Field label={t('insp.delay')}>
          <NumField
            value={delayMs ?? 0}
            mixed={delayMs === null}
            onChange={(v) => s.patchSources(ids, { delayS: v / MS })}
            unit="ms"
            step={0.1}
          />
        </Field>
        <p className="hint mono">{delayHint(delayMs ?? 0, s.sim.speedOfSound)}</p>
        {(delayMs ?? 0) < 0 && (
          <p className="warn">{t('insp.negativeDelay')}</p>
        )}
        <div className="check-row">
          <label>
            <input
              type="checkbox"
              checked={same((x) => x.invertPolarity) ?? false}
              onChange={(e) => s.patchSources(ids, { invertPolarity: e.target.checked })}
            />
            {t('insp.invertPolarity')}
          </label>
          <label>
            <input
              type="checkbox"
              checked={same((x) => x.mute) ?? false}
              onChange={(e) => s.patchSources(ids, { mute: e.target.checked })}
            />
            {t('insp.mute')}
          </label>
        </div>
      </Section>

      <Section title={t('insp.arrange')}>
        <div className="btn-row">
          <button onClick={() => s.centerSelection('x')} title={t('insp.centreXHint')}>{t('insp.centreX')}</button>
          <button onClick={() => s.centerSelection('y')} title={t('insp.centreYHint')}>{t('insp.centreY')}</button>
          <button onClick={() => s.centerSelection('both')}>{t('insp.centreBoth')}</button>
        </div>
        <div className="btn-row">
          <button onClick={() => s.distributeEvenly(ids, 'x')} disabled={selected.length < 3}>{t('insp.distributeX')}</button>
          <button onClick={() => s.distributeEvenly(ids, 'y')} disabled={selected.length < 3}>{t('insp.distributeY')}</button>
          <button onClick={() => s.reverseOrder(ids)} disabled={multi ? false : true} title={t('insp.reverseHint')}>
            {t('insp.reverseOrder')}
          </button>
        </div>
        <div className="btn-row">
          <button onClick={() => s.mirrorSelection('x', false)}>{t('insp.mirrorX')}</button>
          <button onClick={() => s.mirrorSelection('y', false)}>{t('insp.mirrorY')}</button>
          <button onClick={() => s.mirrorSelection('x', true)} title={t('insp.mirrorCopyHint')}>
            {t('insp.mirrorCopy')}
          </button>
        </div>
        <div className="btn-row">
          <button onClick={() => s.groupSelected()}>{t('insp.group')}</button>
          <button onClick={() => s.duplicateSelected()}>{t('insp.duplicate')}</button>
        </div>
      </Section>
    </div>
  );

  // Zaznaczenie obraca się jak jedna bryła, po okręgu wokół swojego środka
  // (rotateSelection); pojedyncza obudowa — w miejscu, bo jest swoim środkiem.
  function bumpAz(targets: string[], deg: number) {
    useStore.getState().rotateSelected(targets, deg);
  }
}

function SpeakerFacts({ modelId }: { modelId: string }) {
  const provider = useStore((s) => s.provider);
  const t = useT();
  const m = provider.get(modelId);
  if (!m) return null;
  const b = boxSize(m);
  const proxy = m.proxyOfId ? provider.get(m.proxyOfId) : undefined;

  return (
    <div className="facts">
      <div className="facts-row">
        <QualityBadge q={m.dataQuality} />
        <span className="facts-quality">{t(QUALITY_KEY[m.dataQuality])}</span>
      </div>
      <div className="mono facts-dims">
        {b.unknown ? (
          <span className="warn-inline">{t('facts.dimsUnknown')}</span>
        ) : (
          `${(b.widthM * 1000).toFixed(0)} × ${(b.heightM * 1000).toFixed(0)} × ${(b.depthM * 1000).toFixed(0)} mm (W×H×D)`
        )}
      </div>
      <div className="mono facts-dims">
        {m.maxSpl != null ? t('facts.maxSpl', { db: m.maxSpl }) : t('facts.maxSplUnknown')}
        {m.frequencyRange &&
          ` · ${m.frequencyRange.minHz ?? '?'}-${m.frequencyRange.maxHz ?? '?'} Hz`}
      </div>
      {proxy && (
        <div className="proxy-note">
          <strong>{t('proxy.title', { name: `${proxy.manufacturer} ${proxy.model}` })}</strong>
          <div>{t('proxy.approx')}</div>
          {m.proxyNote && <div className="hint">{m.proxyNote}</div>}
        </div>
      )}
      {!proxy && m.dataQuality === 'C' && (
        <div className="hint">{t('proxy.analytical')}</div>
      )}
      {m.source?.dimensions?.url && (
        <a className="src-link" href={m.source.dimensions.url} target="_blank" rel="noreferrer">
          {m.source.dimensions.type === 'manufacturer-datasheet'
            ? t('facts.datasheet')
            : t('facts.productPage')}
          {m.source.dimensions.note ? ` · ${m.source.dimensions.note}` : ''} ↗
        </a>
      )}
    </div>
  );
}

export function GroupInspector() {
  const s = useStore();
  const t = useT();
  const g = s.groups.find((x) => x.id === s.selectedGroupId)!;
  const members = s.sources.filter((x) => x.groupId === g.id);

  return (
    <div className="inspector">
      <Section title={t('insp.group')}>
        <Field label={t('insp.name')}>
          <input
            className="text-input"
            value={g.name}
            onChange={(e) => s.patchGroup(g.id, { name: e.target.value })}
          />
        </Field>
        <p className="hint">{t('insp.groupNote', { n: members.length })}</p>
      </Section>

      <Section title={t('insp.transformOffset')}>
        <div className="row3">
          <Field label="ΔX">
            <NumField value={g.offset.x} onChange={(v) => s.patchGroup(g.id, { offset: { ...g.offset, x: v } })} unit="m" step={0.05} />
          </Field>
          <Field label="ΔY">
            <NumField value={g.offset.y} onChange={(v) => s.patchGroup(g.id, { offset: { ...g.offset, y: v } })} unit="m" step={0.05} />
          </Field>
          <Field label="ΔZ">
            <NumField value={g.offset.z} onChange={(v) => s.patchGroup(g.id, { offset: { ...g.offset, z: v } })} unit="m" step={0.05} />
          </Field>
        </div>
        <Field label={t('insp.rotate')} hint={t('insp.rotateHint')}>
          <NumField value={g.rotationOffsetDeg} onChange={(v) => s.patchGroup(g.id, { rotationOffsetDeg: v })} unit="°" step={5} />
        </Field>
      </Section>

      <Section title={t('insp.gainDelayOffset')}>
        <Field label={t('insp.level')}>
          <NumField value={g.levelOffsetDb} onChange={(v) => s.patchGroup(g.id, { levelOffsetDb: v })} unit="dB" step={0.5} min={-100} max={20} />
        </Field>
        <Field label={t('insp.delay')}>
          <NumField value={g.delayOffsetS * MS} onChange={(v) => s.patchGroup(g.id, { delayOffsetS: v / MS })} unit="ms" step={0.1} />
        </Field>
        <p className="hint mono">{delayHint(g.delayOffsetS * MS, s.sim.speedOfSound)}</p>
        <div className="check-row">
          <label>
            <input type="checkbox" checked={g.mute} onChange={(e) => s.patchGroup(g.id, { mute: e.target.checked })} />
            {t('src.muteGroup')}
          </label>
        </div>
      </Section>

      <Section title={t('insp.actions')}>
        <div className="btn-row">
          <button onClick={() => s.duplicateGroup(g.id)}>{t('src.duplicate')}</button>
          <button onClick={() => s.ungroup(g.id)}>{t('insp.ungroup')}</button>
          <button
            className="danger"
            onClick={() => s.deleteGroup(g.id, true)}
          >
            {t('insp.deleteMembers')}
          </button>
        </div>
      </Section>
    </div>
  );
}

function PointInspector() {
  const s = useStore();
  const t = useT();
  const mp = s.measurementPoints.find((m) => m.id === s.selectedPointId)!;
  const responseRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    responseRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [mp.id]);

  const engineSources = useMemo(
    () => toEngineSources(resolveAll(s.sources, s.groups, s.provider)),
    [s.sources, s.groups, s.provider],
  );
  const res = useMemo(
    () => computePoint(engineSources, mp.position, s.sim.frequencyHz, s.sim.speedOfSound, s.sim.ground),
    [engineSources, mp.position, s.sim.frequencyHz, s.sim.speedOfSound, s.sim.ground],
  );

  return (
    <div className="inspector">
      <Section title={t('insp.measurementPoint')}>
        <Field label={t('insp.name')}>
          <input className="text-input" value={mp.name} onChange={(e) => s.patchMeasurementPoint(mp.id, { name: e.target.value })} />
        </Field>
        <div className="row3">
          <Field label="X">
            <NumField value={mp.position.x} onChange={(v) => s.patchMeasurementPoint(mp.id, { position: { ...mp.position, x: v } })} unit="m" step={0.5} />
          </Field>
          <Field label="Y">
            <NumField value={mp.position.y} onChange={(v) => s.patchMeasurementPoint(mp.id, { position: { ...mp.position, y: v } })} unit="m" step={0.5} />
          </Field>
          <Field label="Z">
            <NumField value={mp.position.z} onChange={(v) => s.patchMeasurementPoint(mp.id, { position: { ...mp.position, z: v } })} unit="m" step={0.1} />
          </Field>
        </div>
        <div className="readout">
          <LevelRows sources={engineSources} at={mp.position} phaseDeg={res.phaseDeg} toneDb={res.splDb} />
          <div><span>{t('insp.sourcesCount')}</span><b>{res.contributions.length}</b></div>
        </div>
        <div className="btn-row">
          <button className="danger" onClick={() => s.deleteMeasurementPoint(mp.id)}>{t('insp.deletePoint')}</button>
        </div>
      </Section>

      {/* Selecting a point is a request to see its response, so the chart is
          brought into view rather than left below the fold of a long column. */}
      <div ref={responseRef}>
        <Section title={t('insp.response')}>
          <ResponseChart position={mp.position} />
        </Section>
      </div>
    </div>
  );
}

/**
 * Level and phase rows, in whatever quantity the MAP is currently drawn in.
 *
 * With averaging on, the number beside the picture has to be the same thing as
 * the picture, otherwise the cursor reads one level and the cell under it shows
 * another. Phase is blanked rather than carried over from the centre tone: a
 * power average has no phase, and printing the centre frequency's angle next to
 * a band level would invite someone to time-align on a number that does not
 * describe what they are looking at.
 */
function LevelRows({
  sources,
  at,
  phaseDeg,
  toneDb,
}: {
  sources: EngineSource[];
  at: { x: number; y: number; z: number };
  phaseDeg: number;
  toneDb: number;
}) {
  const s = useStore();
  const t = useT();
  // Szum różowy czyta się w punkcie tym samym pasmem co na mapie — patrz
  // pinkBand: inaczej odczyt punktowy mówiłby o innym sygnale niż obraz.
  const pink = s.sim.signal === 'pink' ? pinkBand(s.sim) : null;
  const bandOct = pink ? pink.bandOct : s.sim.bandOct;
  const centreHz = pink ? pink.centreHz : s.sim.frequencyHz;

  const band = useMemo(
    () =>
      bandOct > 0
        ? computeBandLevel(sources, at, centreHz, bandOct, s.sim.speedOfSound, s.sim.ground)
        : null,
    [sources, at, bandOct, centreHz, s.sim.speedOfSound, s.sim.ground],
  );

  const bandName = pink
    ? `${t('right.pinkNoise')} ${s.sim.pinkLoHz.toFixed(0)}-${s.sim.pinkHiHz.toFixed(0)} Hz`
    : bandOct >= 1
      ? t('right.fullOctave')
      : t('right.thirdOctave');

  return (
    <>
      <div>
        <span>
          {band
            ? t('insp.splBandAt', { band: bandName, hz: centreHz.toFixed(1) })
            : t('insp.splAt', { hz: centreHz.toFixed(1) })}
        </span>
        {/* dBFS, nie dB SPL: poziom na wewnętrznej skali programu (0 dBFS =
            umowna pełna skala silnika), bez kalibracji bezwzględnej. Goły
            "dB" wyglądał jak zmierzone dB SPL. */}
        <b>{(band ? band.splDb : toneDb).toFixed(1)} dBFS</b>
      </div>
      <div>
        <span>{t('insp.phase')}</span>
        {band ? (
          <b title={t('insp.phaseUndefined')} style={{ opacity: 0.5 }}>
            -
          </b>
        ) : (
          <b>{phaseDeg.toFixed(1)}°</b>
        )}
      </div>
    </>
  );
}

function EmptyInspector() {
  const s = useStore();
  const t = useT();
  const cursor = s.cursorPoint;
  const engineSources = useMemo(
    () => toEngineSources(resolveAll(s.sources, s.groups, s.provider)),
    [s.sources, s.groups, s.provider],
  );
  const res = useMemo(
    () => (cursor ? computePoint(engineSources, cursor, s.sim.frequencyHz, s.sim.speedOfSound, s.sim.ground) : null),
    [engineSources, cursor, s.sim.frequencyHz, s.sim.speedOfSound, s.sim.ground],
  );

  const nearest = cursor && s.sources.length
    ? Math.min(
        ...s.sources.map((x) =>
          Math.hypot(x.position.x - cursor.x, x.position.y - cursor.y, x.position.z - cursor.z),
        ),
      )
    : null;

  return (
    <div className="inspector">
      {cursor && res ? (
        <Section title={t('insp.cursor')}>
          <div className="readout">
            <div><span>X</span><b>{cursor.x.toFixed(2)} m</b></div>
            <div><span>Y</span><b>{cursor.y.toFixed(2)} m</b></div>
            <div><span>Z</span><b>{cursor.z.toFixed(2)} m</b></div>
            {nearest != null && <div><span>{t('insp.nearestSource')}</span><b>{nearest.toFixed(2)} m</b></div>}
            <LevelRows sources={engineSources} at={cursor} phaseDeg={res.phaseDeg} toneDb={res.splDb} />
          </div>
          <div className="btn-row">
            <button onClick={() => s.addMeasurementPoint(cursor)}>{t('insp.savePoint')}</button>
          </div>
          <Section title={t('insp.responseShort')}>
            <ResponseChart position={cursor} />
          </Section>
        </Section>
      ) : (
        <div className="empty-hint">
          <p>{t('insp.nothing')}</p>
          <ul>
            <li>{t('insp.hint1')}</li>
            <li>{t('insp.hint2')}</li>
            <li>{t('insp.hint3')}</li>
            <li>{t('insp.hint4')}</li>
            <li>{t('insp.hint5')}</li>
          </ul>
        </div>
      )}
    </div>
  );
}
