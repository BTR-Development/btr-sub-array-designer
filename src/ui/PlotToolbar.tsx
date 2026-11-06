import { useStore, type SnapValue } from '../state/store';
import { useT } from '../i18n/useT';

const SNAPS: SnapValue[] = [0, 0.05, 0.1, 0.25, 0.5, 1];

/**
 * Controls that act on the plot itself, docked under it the way a viewport
 * toolbar is. Nothing here changes the acoustics — only what is drawn and how
 * the pointer behaves.
 */
export function PlotToolbar() {
  const s = useStore();
  const t = useT();

  return (
    <div className="plot-toolbar">
      <button
        className={s.tool === 'select' ? 'on' : ''}
        onClick={() => s.setTool('select')}
        title={t('plot.selectHint')}
      >
        {t('plot.select')}
      </button>
      <button
        className={s.tool === 'addPoint' ? 'on' : ''}
        onClick={() => s.setTool(s.tool === 'addPoint' ? 'select' : 'addPoint')}
      >
        {t('plot.addPoint')}
      </button>

      <span className="tb-label">{t('plot.snap')}</span>
      <select value={s.snap} onChange={(e) => s.setSnap(parseFloat(e.target.value) as SnapValue)}>
        {SNAPS.map((v) => (
          <option key={v} value={v}>{v === 0 ? t('plot.off') : `${v.toFixed(2)} m`}</option>
        ))}
      </select>

      <span className="spacer" />

      <button className={s.showHeatmap ? 'on' : ''} onClick={() => s.toggle('showHeatmap')}>{t('plot.splMap')}</button>
      <button className={s.showGrid ? 'on' : ''} onClick={() => s.toggle('showGrid')}>{t('plot.grid')}</button>
      <button onClick={() => window.dispatchEvent(new Event('btr:fit'))} title={t('plot.fitHint')}>
        {t('plot.fit')}
      </button>
    </div>
  );
}
