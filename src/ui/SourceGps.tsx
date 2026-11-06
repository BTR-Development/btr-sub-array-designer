import { useState } from 'react';
import { useStore } from '../state/store';
import { Icon } from './icons';
import { useT } from '../i18n/useT';

const MS = 1000;

/**
 * Source GPS — where every cabinet in the project actually is.
 *
 * The SUBS table shows one module at a time, which is the right scope for
 * steering it but the wrong one for checking a rig: this lists the whole
 * project, grouped, so positions and polarity can be read and fixed in one
 * place. It edits the same records the SUBS table does.
 */
export function SourceGps({ style }: { style?: React.CSSProperties }) {
  const s = useStore();
  const t = useT();
  const [filter, setFilter] = useState('');

  const groupName = (id?: string | null) => (id ? (s.groups.find((g) => g.id === id)?.name ?? '-') : '-');
  const rows = s.sources.filter(
    (x) =>
      !filter ||
      `${x.label} ${s.provider.get(x.speakerId)?.model ?? ''} ${groupName(x.groupId)}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
  );

  const num = (name: string, value: number, onChange: (v: number) => void, step: number, digits = 2) => (
    <input
      type="number"
      aria-label={name}
      step={step}
      value={Number(value.toFixed(digits))}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (isFinite(v)) onChange(v);
      }}
    />
  );

  const inverted = s.sources.filter((x) => x.invertPolarity).length;

  return (
    <section className="panel gps-panel" style={style}>
      <header className="panel-head">
        {t('gps.title')}
        <span className="steer-module">
          {t('gps.count', { count: s.sources.length })}
          {inverted > 0 && ` · ${t('gps.inverted', { count: inverted })}`}
        </span>
        <span className="spacer" />
        <input
          className="text-input filter tiny-filter"
          aria-label={t('src.filter')}
          placeholder={t('src.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          className="panel-head-btn"
          title={t('gps.invertSelectedHint')}
          disabled={!s.selectedSourceIds.length}
          onClick={() => {
            const anyNormal = s.sources.some(
              (x) => s.selectedSourceIds.includes(x.id) && !x.invertPolarity,
            );
            s.patchSources(s.selectedSourceIds, { invertPolarity: anyNormal });
          }}
        >
          {t('gps.invertSelected')}
        </button>
        <button className="panel-head-btn" aria-label={t('ui.close')} onClick={() => s.toggle('showGps')}><Icon name="close" /></button>
      </header>

      <div className="stable-wrap">
        <table className="stable mono">
          <thead>
            <tr>
              <th className="left">{t('tbl.label')}</th>
              <th className="left">{t('tbl.speaker')}</th>
              <th className="left">{t('tbl.groupCol')}</th>
              <th>X (m)</th>
              <th>Y (m)</th>
              <th>Z (m)</th>
              <th>{t('tbl.horiz')}</th>
              <th>{t('tbl.vert')}</th>
              <th>{t('tbl.level')}</th>
              <th>{t('tbl.delay')}</th>
              <th title={t('tbl.polarity')}>Ø</th>
              <th title={t('src.mute')}>M</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const sel = s.selectedSourceIds.includes(m.id);
              return (
                <tr
                  key={m.id}
                  className={`${sel ? 'sel' : ''} ${m.mute ? 'muted' : ''}`}
                  onClick={(e) => {
                    const tag = (e.target as HTMLElement).tagName;
                    if (tag !== 'INPUT' && tag !== 'BUTTON') {
                      s.selectSourceAt(m.id, rows.map((r) => r.id), {
                        toggle: e.metaKey || e.ctrlKey,
                        range: e.shiftKey,
                      });
                    }
                  }}
                >
                  <td className="left">{m.label}</td>
                  <td className="left name">{s.provider.get(m.speakerId)?.model ?? '-'}</td>
                  <td className="left name">{groupName(m.groupId)}</td>
                  <td>{num(`${m.label} ${'X (m)'}`, m.position.x, (v) => s.patchSources([m.id], { position: { x: v } }), 0.1)}</td>
                  <td>{num(`${m.label} ${'Y (m)'}`, m.position.y, (v) => s.patchSources([m.id], { position: { y: v } }), 0.1)}</td>
                  <td>{num(`${m.label} ${'Z (m)'}`, m.position.z, (v) => s.patchSources([m.id], { position: { z: v } }), 0.1)}</td>
                  <td>{num(`${m.label} ${t('tbl.horiz')}`, m.rotation.azimuthDeg, (v) => s.patchSources([m.id], { rotation: { azimuthDeg: v } }), 5, 1)}</td>
                  <td>{num(`${m.label} ${t('tbl.vert')}`, m.rotation.elevationDeg, (v) => s.patchSources([m.id], { rotation: { elevationDeg: v } }), 1, 1)}</td>
                  <td>{num(`${m.label} ${t('tbl.level')}`, m.levelDb, (v) => s.patchSources([m.id], { levelDb: v }), 0.5, 1)}</td>
                  <td>{num(`${m.label} ${t('tbl.delay')}`, m.delayS * MS, (v) => s.patchSources([m.id], { delayS: v / MS }), 0.1, 2)}</td>
                  <td>
                    <button
                      className={`pol-btn${m.invertPolarity ? ' on' : ''}`}
                      title={m.invertPolarity ? t('tbl.polarityOn') : t('tbl.polarityOff')}
                      onClick={() => s.patchSources([m.id], { invertPolarity: !m.invertPolarity })}
                    >
                      Ø
                    </button>
                  </td>
                  <td>
                    <button
                      className={`mute-btn${m.mute ? ' on' : ''}`}
                      title={t('src.mute')}
                      onClick={() => s.patchSources([m.id], { mute: !m.mute })}
                    >
                      M
                    </button>
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td className="left" colSpan={12}>
                  <span className="empty-hint small">
                    {s.sources.length ? t('gps.noMatch') : t('gps.noSources')}
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
