/**
 * The delay and position sheet: preview, print / PDF, CSV and clipboard.
 *
 * The sheet is drawn ONCE, by `SheetDocument`, and the same component is what
 * the dialog previews and what goes to paper: a second rendering for print
 * would be a second place for the numbers to disagree. For printing it is
 * mounted again, outside the application, in a root that only the print
 * stylesheet shows (index.css, "delay sheet"); the dialog itself never prints.
 *
 * The paper is light whatever the theme, because it is printed, photocopied
 * and read on a stage in daylight.
 */
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../state/store';
import { useT } from '../i18n/useT';
import { Modal, QualityBadge } from './widgets';
import { QUALITY_KEY, type Lang, type MessageKey, type Vars } from '../i18n';
import {
  buildDelaySheet,
  fmt,
  sheetRows,
  toCsv,
  toTsv,
  type DelaySheet,
  sheetColumns,
  type SheetCabinet,
} from '../io/delaySheet';
import { downloadBlob } from '../io/registry';

type T = (key: MessageKey, vars?: Vars) => string;

/** How a position is named on the drawing and in the table: "3", or "2.3" once there are several arrays. */
const positionLabel = (sheet: DelaySheet, arrayIndex: number, n: number) =>
  sheet.arrays.length > 1 ? `${arrayIndex + 1}.${n}` : String(n);

// ── the drawing ────────────────────────────────────────────────────────────

const VIEW_W = 700;
const MAX_H = 340;
const MARGIN = 34;
/** a cabinet with no published footprint is drawn as this square, so it is still a place */
const UNKNOWN_SIZE_M = 0.5;

function SheetLayout({ sheet, t, lang }: { sheet: DelaySheet; t: T; lang: Lang }) {
  const cabs: Array<{ c: SheetCabinet; label: string; key: string }> = [];
  sheet.arrays.forEach((a, ai) =>
    a.positions.forEach((p) =>
      p.cabinets.forEach((c) => cabs.push({ c, label: positionLabel(sheet, ai, p.number), key: `${ai}.${p.number}` })),
    ),
  );
  if (!cabs.length) return null;

  const size = (c: SheetCabinet) => ({ w: c.widthM ?? UNKNOWN_SIZE_M, d: c.depthM ?? UNKNOWN_SIZE_M });
  // corners in the world, so a turned cabinet is inside the frame
  const xs: number[] = [0];
  const ys: number[] = [];
  for (const { c } of cabs) {
    const { w, d } = size(c);
    const a = (c.azimuthDeg * Math.PI) / 180;
    for (const [lx, ly] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]) {
      // local +Y is the front; azimuth turns it clockwise seen from above
      xs.push(c.x + lx * Math.cos(a) + ly * Math.sin(a));
      ys.push(c.y - lx * Math.sin(a) + ly * Math.cos(a));
    }
  }
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1), spanY = Math.max(maxY - minY, 1);
  const k = Math.min((VIEW_W - 2 * MARGIN) / spanX, (MAX_H - 2 * MARGIN) / spanY);
  // room under the rig for the position numbers, then the dimension line
  const h = spanY * k + 2 * MARGIN + 30;
  const ox = (VIEW_W - spanX * k) / 2;
  // screen up is +Y, towards the audience, as on the plan view of the program
  const sx = (x: number) => ox + (x - minX) * k;
  const sy = (y: number) => MARGIN + (maxY - y) * k;

  const centres = new Map<string, { label: string; x: number; y: number; n: number; reach: number }>();
  for (const { c, label, key } of cabs) {
    const e = centres.get(key) ?? { label, x: 0, y: 0, n: 0, reach: 0 };
    e.x += c.x; e.y += c.y; e.n += 1;
    e.reach = Math.max(e.reach, Math.max(size(c).w, size(c).d) / 2);
    centres.set(key, e);
  }
  const centreXs = cabs.map(({ c }) => c.x);
  const rowL = Math.min(...centreXs), rowR = Math.max(...centreXs);
  const dimY = MARGIN + spanY * k + 30;

  return (
    <svg className="sheet-layout" viewBox={`0 0 ${VIEW_W} ${h}`} role="img" aria-label={t('sheet.layout')}>
      <line className="sheet-axis" x1={sx(0)} y1={8} x2={sx(0)} y2={h - 6} />
      <text className="sheet-axis-label" x={sx(0) + 4} y={16}>{t('sheet.stageAxis')}</text>

      {/* in the top-left corner, above the rig: the frame keeps that clear */}
      <g className="sheet-audience">
        <line x1={14} y1={MARGIN + 18} x2={14} y2={8} />
        <path d="M 9 15 L 14 8 L 19 15" />
        <text x={22} y={18}>{t('sheet.audience')}</text>
      </g>

      {cabs.map(({ c }) => {
        const { w, d } = size(c);
        return (
          <g
            key={c.id}
            className={`sheet-cab${c.reversed ? ' reversed' : ''}${c.muted ? ' muted' : ''}`}
            transform={`translate(${sx(c.x)} ${sy(c.y)}) rotate(${c.azimuthDeg})`}
          >
            <rect x={(-w / 2) * k} y={(-d / 2) * k} width={w * k} height={d * k} />
            {/* the front face, heavier, so the drawing says which way each box looks */}
            <line className="sheet-front" x1={(-w / 2) * k} y1={(-d / 2) * k} x2={(w / 2) * k} y2={(-d / 2) * k} />
          </g>
        );
      })}

      {[...centres.values()].map((p) => (
        <text
          key={p.label}
          className="sheet-pos-label"
          x={sx(p.x / p.n)}
          y={sy(p.y / p.n) + p.reach * k + 11}
          textAnchor="middle"
        >
          {p.label}
        </text>
      ))}

      {rowR - rowL > 0.05 && (
        <g className="sheet-dim">
          <line x1={sx(rowL)} y1={dimY} x2={sx(rowR)} y2={dimY} />
          <line x1={sx(rowL)} y1={dimY - 4} x2={sx(rowL)} y2={dimY + 4} />
          <line x1={sx(rowR)} y1={dimY - 4} x2={sx(rowR)} y2={dimY + 4} />
          <text x={(sx(rowL) + sx(rowR)) / 2} y={dimY - 3} textAnchor="middle">
            {fmt(rowR - rowL, 2, lang)} m
          </text>
        </g>
      )}
    </svg>
  );
}

// ── the paper ──────────────────────────────────────────────────────────────

function SheetDocument({ sheet, t, lang }: { sheet: DelaySheet; t: T; lang: Lang }) {
  const n = (v: number, d: number, signed = false) => fmt(v, d, lang, signed);
  return (
    <article className="sheet">
      <header className="sheet-head">
        <h1>{sheet.projectName || t('tb.untitled')}</h1>
        <span className="sheet-kind">{t('sheet.title')}</span>
      </header>

      <dl className="sheet-facts">
        <dt>{t('sheet.date')}</dt>
        <dd>{sheet.date}</dd>
        {sheet.author && (
          <>
            <dt>{t('sheet.author')}</dt>
            <dd>{sheet.author}</dd>
          </>
        )}
        <dt>{t('sheet.temperature')}</dt>
        <dd>
          {n(sheet.temperatureC, 1)} °C · c = {n(sheet.speedOfSound, 1)} m/s
        </dd>
        <dt>{t('sheet.cabinets')}</dt>
        <dd>{sheet.cabinetCount}</dd>
        <dt>{t('sheet.models')}</dt>
        <dd>
          {sheet.models.map((m, i) => (
            <span key={m.name} className="sheet-model">
              {i > 0 && ', '}
              {m.name} <QualityBadge q={m.grade} />
            </span>
          ))}
        </dd>
        {sheet.grade && (
          <>
            <dt>{t('sheet.data')}</dt>
            <dd>
              <QualityBadge q={sheet.grade} /> {t(QUALITY_KEY[sheet.grade])}
            </dd>
          </>
        )}
      </dl>

      {sheet.negativeMinMs !== null && (
        <p className="sheet-warn">
          {t('sheet.negative', {
            min: n(sheet.negativeMinMs, 2),
            add: n(Math.ceil(-sheet.negativeMinMs * 100) / 100, 2),
          })}
        </p>
      )}

      {sheet.cabinetCount === 0 ? (
        <p>{t('sheet.empty')}</p>
      ) : (
        <>
          <h2>{t('sheet.layout')}</h2>
          <SheetLayout sheet={sheet} t={t} lang={lang} />

          {sheet.arrays.map((a, ai) => (
            <section key={a.groupId ?? 'loose'} className="sheet-array">
              <h2>
                {sheet.arrays.length > 1 && `${ai + 1}. `}
                {a.name}
                {a.muted && <span className="sheet-muted"> · {t('sheet.arrayMuted')}</span>}
              </h2>
              {(Math.abs(a.delayOffsetMs) > 1e-9 || Math.abs(a.levelOffsetDb) > 1e-9) && (
                <p className="sheet-offset">
                  {t('sheet.arrayOffset', { delay: n(a.delayOffsetMs, 2, true), level: n(a.levelOffsetDb, 1, true) })}
                </p>
              )}
              <table>
                <thead>
                  <tr>
                    <th>{t('sheet.col.position')}</th>
                    <th>{t('sheet.col.cabinet')}</th>
                    <th>{t('sheet.col.model')}</th>
                    <th>{t('sheet.col.fb')}</th>
                    <th className="num">X [m]</th>
                    <th className="num">Y [m]</th>
                    <th className="num">Z [m]</th>
                    <th className="num">{t('sheet.col.azimuth')}</th>
                    <th className="num sheet-delay">{t('sheet.col.delay')}</th>
                    <th>{t('sheet.col.polarity')}</th>
                    <th className="num">{t('sheet.col.level')}</th>
                    <th>{t('sheet.col.mute')}</th>
                  </tr>
                </thead>
                <tbody>
                  {a.positions.map((p) =>
                    p.cabinets.map((c, ci) => (
                      <tr key={c.id} className={`${ci === 0 ? 'pos-first' : ''}${c.muted ? ' muted' : ''}`}>
                        {ci === 0 && (
                          <td className="sheet-pos" rowSpan={p.cabinets.length}>
                            {positionLabel(sheet, ai, p.number)}
                          </td>
                        )}
                        <td>{c.label}</td>
                        <td>{c.model}</td>
                        <td>{c.reversed ? 'B' : 'F'}</td>
                        <td className="num">{n(c.x, 2)}</td>
                        <td className="num">{n(c.y, 2)}</td>
                        <td className="num">{n(c.z, 2)}</td>
                        <td className="num">{n(c.azimuthDeg, 1)}</td>
                        <td className="num sheet-delay">{n(c.delayMs, 2)}</td>
                        <td>{c.inverted ? 'Ø' : ''}</td>
                        <td className="num">{n(c.levelDb, 1)}</td>
                        <td>{c.muted ? t('sheet.yes') : ''}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </section>
          ))}
        </>
      )}

      <p className="sheet-conv">{t('sheet.conventions')}</p>

      {sheet.notes.trim() && (
        <section className="sheet-notes">
          <h2>{t('sheet.notes')}</h2>
          <p>{sheet.notes}</p>
        </section>
      )}
    </article>
  );
}

// ── hand-off ───────────────────────────────────────────────────────────────

/**
 * The system print dialog, which is also the PDF route on every platform.
 * WKWebView ignores `window.print()`, so the macOS app takes the request over
 * a message handler and runs its own print operation (desktop/BTRApp.swift);
 * the browser and the Windows app print the page themselves.
 */
function printSheet() {
  type Bridge = { postMessage(v: unknown): void };
  const bridge = (window as unknown as { webkit?: { messageHandlers?: { btrPrint?: Bridge } } }).webkit
    ?.messageHandlers?.btrPrint;
  if (bridge) bridge.postMessage('sheet');
  else window.print();
}

/** The async clipboard is not available in every shell; the old path still is. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

export function DelaySheetDialog({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const t = useT();
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');

  const sheet = useMemo(
    () =>
      buildDelaySheet(
        { project: s.project, sources: s.sources, groups: s.groups, sim: s.sim, provider: s.provider },
        t('sheet.ungrouped'),
      ),
    // the provider's overlay follows customSpeakers; t follows the language
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.project, s.sources, s.groups, s.sim, s.provider, s.customSpeakers, s.lang],
  );
  const rows = () => sheetRows(sheet, sheetColumns(t), s.lang);
  const safe = (s.project.name || 'project').replace(/[^\w\-. ]+/g, '_');

  return (
    <Modal title={t('sheet.title')} onClose={onClose} wide>
      <div className="sheet-dialog">
        <div className="sheet-tools">
          <button className="primary sheet-print" onClick={printSheet} title={t('sheet.printHint')}>
            {t('sheet.print')}
          </button>
          <button
            className="sheet-csv"
            onClick={() => downloadBlob(new Blob([toCsv(rows(), s.lang)], { type: 'text/csv' }), `${safe}-delays.csv`)}
          >
            {t('sheet.csv')}
          </button>
          <button
            className="sheet-copy"
            onClick={async () => setCopyState((await copyText(toTsv(rows()))) ? 'ok' : 'fail')}
          >
            {t('sheet.copy')}
          </button>
          {copyState !== 'idle' && (
            <span className={copyState === 'ok' ? 'hint' : 'error-text'} role="status">
              {t(copyState === 'ok' ? 'sheet.copied' : 'sheet.copyFailed')}
            </span>
          )}
          <span className="spacer" />
          <label className="sheet-author">
            {t('sheet.author')}
            <input
              value={s.project.author ?? ''}
              onChange={(e) => s.patchProjectMeta({ author: e.target.value })}
            />
          </label>
        </div>
        <label className="sheet-notes-field">
          {t('sheet.notes')}
          <textarea
            rows={2}
            value={s.project.notes ?? ''}
            placeholder={t('sheet.notesPh')}
            onChange={(e) => s.patchProjectMeta({ notes: e.target.value })}
          />
        </label>
        <div className="sheet-preview">
          <SheetDocument sheet={sheet} t={t} lang={s.lang} />
        </div>
      </div>
      {createPortal(
        <div className="print-sheet-root" aria-hidden="true">
          <SheetDocument sheet={sheet} t={t} lang={s.lang} />
        </div>,
        document.body,
      )}
    </Modal>
  );
}
