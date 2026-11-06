import { useMemo, useState } from 'react';
import { Modal, NumField, Field, QualityBadge } from './widgets';
import { allSpeakers, useStore } from '../state/store';
import { boxSize, centreZFromBottomFace, type SpeakerModel } from '../speakers/schema';
import { buildCustomSpeaker, findProxy, type CustomSpeakerSpec } from '../speakers/proxy';
import { BalloonTab } from './BalloonTab';
import { PROXY_ACOUSTICS_KEY, QUALITY_KEY } from '../i18n';
import { useT } from '../i18n/useT';
import { optionalNumber } from './fieldValue';

export function SpeakerDialog({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const t = useT();
  const [tab, setTab] = useState<'library' | 'custom' | 'balloon'>('library');
  const customSpeakers = useStore((st) => st.customSpeakers);
  const speakers = useMemo(() => allSpeakers(customSpeakers), [customSpeakers]);

  return (
    <Modal title={t('spk.title')} onClose={onClose} wide>
      <div className="tabs">
        <button className={tab === 'library' ? 'on' : ''} onClick={() => setTab('library')}>{t('spk.tabLibrary')}</button>
        <button className={tab === 'custom' ? 'on' : ''} onClick={() => setTab('custom')}>{t('spk.tabCustom')}</button>
        <button
          className={tab === 'balloon' ? 'on' : ''}
          onClick={() => setTab('balloon')}
          title={t('spk.tabImportHint')}
        >
          {t('spk.tabImport')}
        </button>
      </div>
      {tab === 'library' && (
        <LibraryTab speakers={speakers} onPick={(m) => { addAt(m); onClose(); }} />
      )}
      {tab === 'custom' && (
        <CustomTab
          onCreate={(spec) => {
            const model = buildCustomSpeaker(spec, speakers);
            s.addCustomSpeaker(model);
            addAt(model);
            onClose();
          }}
        />
      )}
      {tab === 'balloon' && (
        <BalloonTab
          onCreate={(model) => {
            s.addCustomSpeaker(model);
            addAt(model);
            onClose();
          }}
        />
      )}
    </Modal>
  );

  /**
   * Drop the new cabinet at the centre of the current view.
   *
   * The two planes are not symmetric on purpose. On top view the screen gives X
   * and Y and the height is NOT taken from the section offset: a sub belongs on
   * the ground, not floating at whatever height the map happens to be cut at.
   * On side view the screen gives depth and height directly, so the height is
   * real and only the stage-width coordinate comes from the section.
   *
   * "On the ground" is `height/2`, not 0, because a position is the cabinet's
   * geometric centre — the floor convention on `centreZFromBottomFace`, the same
   * one the vertical stack control uses. At z = 0 the
   * box was drawn half under the deck, which is exactly what an engineer checks
   * in side view straight after placing a sub. A cabinet whose height nobody
   * publishes cannot be seated, and lands at 0 rather than at an invented half.
   */
  function addAt(model: SpeakerModel) {
    const st = useStore.getState();
    const pos =
      st.sim.plane === 'top'
        ? { x: st.view.cx, y: st.view.cy, z: centreZFromBottomFace(model) ?? 0 }
        : { x: st.sim.area.planeOffset, y: st.view.cx, z: st.view.cy };
    st.addSource(model.id, pos);
  }
}

function LibraryTab({ speakers, onPick }: { speakers: SpeakerModel[]; onPick: (m: SpeakerModel) => void }) {
  const t = useT();
  const [q, setQ] = useState('');
  const filtered = speakers.filter((m) =>
    `${m.manufacturer} ${m.model}`.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <div className="lib">
      <input className="text-input" aria-label={t('spk.search')} placeholder={t('spk.search')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <p className="hint">
        {/* The second sentence carries the emphasis as a whole: which word in it
            is the load-bearing one differs by language. */}
        {t('spk.dimsFromVendor')} <b>{t('spk.notVendorData')}</b>
      </p>
      <div className="lib-list">
        {filtered.map((m) => {
          const b = boxSize(m);
          return (
            <button key={m.id} className="lib-row" onClick={() => onPick(m)}>
              <span className="lib-mfg">{m.manufacturer}</span>
              <span className="lib-model">{m.model}</span>
              <span className="lib-dims mono">
                {b.unknown ? t('spk.dimsUnknown') : `${(b.widthM * 1000).toFixed(0)}×${(b.heightM * 1000).toFixed(0)}×${(b.depthM * 1000).toFixed(0)} mm`}
              </span>
              <span className="lib-type">
                {m.type === 'cardioid' ? t('spk.cardioid') : m.type === 'omnidirectional' ? t('spk.omni') : m.type}
              </span>
              <span className="lib-spl mono">{m.maxSpl != null ? `${m.maxSpl} dB` : '-'}</span>
              <QualityBadge q={m.dataQuality} />
            </button>
          );
        })}
        {!filtered.length && <p className="empty-hint small">{t('spk.noMatch', { q })}</p>}
      </div>
      <p className="hint">
        {t('spk.modelCount', { count: speakers.length })} A {t(QUALITY_KEY.A)} · B {t(QUALITY_KEY.B)} · C{' '}
        {t(QUALITY_KEY.C)} · D {t(QUALITY_KEY.D)}
      </p>
    </div>
  );
}

function CustomTab({ onCreate }: { onCreate: (spec: CustomSpeakerSpec) => void }) {
  const t = useT();
  const customSpeakers = useStore((st) => st.customSpeakers);
  const speakers = useMemo(() => allSpeakers(customSpeakers), [customSpeakers]);
  const [spec, setSpec] = useState<CustomSpeakerSpec>({
    name: 'My sub',
    manufacturer: '',
    widthM: 0.6,
    heightM: 0.6,
    depthM: 0.7,
    type: 'omnidirectional',
    maxSpl: null,
    frequencyRange: null,
  });
  const [minHz, setMinHz] = useState<number | ''>('');
  const [maxHz, setMaxHz] = useState<number | ''>('');
  const [maxSpl, setMaxSpl] = useState<number | ''>('');

  const full: CustomSpeakerSpec = {
    ...spec,
    maxSpl: maxSpl === '' ? null : maxSpl,
    frequencyRange:
      minHz === '' && maxHz === '' ? null : { minHz: minHz === '' ? null : minHz, maxHz: maxHz === '' ? null : maxHz },
  };
  const match = findProxy(full, speakers);

  return (
    <div className="custom">
      <div className="row2">
        <Field label={t('spk.name')}>
          <input className="text-input" value={spec.name} onChange={(e) => setSpec({ ...spec, name: e.target.value })} autoFocus />
        </Field>
        <Field label={t('spk.manufacturer')}>
          <input className="text-input" value={spec.manufacturer} onChange={(e) => setSpec({ ...spec, manufacturer: e.target.value })} placeholder={t('spk.optional')} />
        </Field>
      </div>
      <div className="row3">
        <Field label={t('spk.width')}><NumField value={spec.widthM} onChange={(v) => setSpec({ ...spec, widthM: v })} unit="m" step={0.01} min={0.05} /></Field>
        <Field label={t('spk.height')}><NumField value={spec.heightM} onChange={(v) => setSpec({ ...spec, heightM: v })} unit="m" step={0.01} min={0.05} /></Field>
        <Field label={t('spk.depth')}><NumField value={spec.depthM} onChange={(v) => setSpec({ ...spec, depthM: v })} unit="m" step={0.01} min={0.05} /></Field>
      </div>
      <div className="row3">
        <Field label={t('spk.type')}>
          <select className="text-input" value={spec.type} onChange={(e) => setSpec({ ...spec, type: e.target.value as CustomSpeakerSpec['type'] })}>
            <option value="omnidirectional">{t('spk.omni')}</option>
            <option value="cardioid">{t('spk.cardioid')}</option>
          </select>
        </Field>
        <Field label={t('spk.maxSpl')}>
          <input className="text-input" type="number" placeholder={t('spk.optional')} value={maxSpl} onChange={(e) => setMaxSpl(optionalNumber(e.target.value))} />
        </Field>
        <Field label={t('spk.rangeHz')}>
          <span className="range-pair">
            <input className="text-input" type="number" placeholder={t('spk.min')} value={minHz} onChange={(e) => setMinHz(optionalNumber(e.target.value))} />
            <input className="text-input" type="number" placeholder={t('spk.max')} value={maxHz} onChange={(e) => setMaxHz(optionalNumber(e.target.value))} />
          </span>
        </Field>
      </div>

      <div className="proxy-preview">
        {match ? (
          <>
            <strong>
              {t('proxy.title', { name: `${match.model.manufacturer} ${match.model.model}` })}
            </strong>
            <div>{t('proxy.approx')}</div>
            <div className="hint">{match.reason}</div>
          </>
        ) : (
          <strong>{t('proxy.none')}</strong>
        )}
        <p className="hint">{t('proxy.neverInvents')}</p>
        {/* Said in its own paragraph because it is a different claim: the one
            above is the promise, this one is what the promise cost this
            particular cabinet. Without a proxy there is nothing to qualify and
            `proxy.none` above has already said what will be used. */}
        {match && (
          <p className="hint">{t(PROXY_ACOUSTICS_KEY[match.model.predictionData.kind])}</p>
        )}
      </div>

      <div className="btn-row right">
        <button className="primary" onClick={() => onCreate(full)} disabled={!spec.name.trim()}>
          {t('spk.create')}
        </button>
      </div>
    </div>
  );
}
