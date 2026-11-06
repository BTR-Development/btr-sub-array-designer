import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../state/store';
import { usePrediction } from '../state/usePrediction';
import { TopBar } from './TopBar';
import { CrashRecovery } from './CrashRecovery';
import { LeftColumn } from './LeftColumn';
import { RightColumn } from './RightColumn';
import { PlotToolbar } from './PlotToolbar';
import { StatusBar } from './StatusBar';
import { CanvasStage } from './CanvasStage';
import { Canvas3D } from './Canvas3D';
import { DebugPanel } from './DebugPanel';
import { PolarPlot } from './PolarPlot';
import { SourceGps } from './SourceGps';
import { SpeakerDialog } from './SpeakerDialog';
import { ArrayDialog } from './ArrayDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { DelaySheetDialog } from './DelaySheet';
import { Toast } from './Toast';
import { Tutorial } from './Tutorial';
import { HelpDialog } from './HelpDialog';
import { guardUnsaved, saveProject } from './projectFiles';
import { onOpenRequest } from '../platform/fileHost';
import { BRANDING } from '../branding';
import { modalIsOpen } from './modals';
import { QualityBadge } from './widgets';
import { mapDataGrade } from '../state/dataGrade';
import { QUALITY_KEY } from '../i18n';
import { useT } from '../i18n/useT';
import { Splitter } from './Splitter';
import { useSize } from './useSize';
import { requestFit } from '../render/view';

export function App() {
  const s = useStore();
  const t = useT();
  const prediction = usePrediction();
  // customSpeakers: the provider object stays the same when its overlay of
  // custom models is replaced, so it alone would not refresh the grade.
  const dataGrade = useMemo(
    () => mapDataGrade(s.sources, s.groups, s.provider),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.sources, s.groups, s.provider, s.customSpeakers],
  );
  const [dialog, setDialog] = useState<'speaker' | 'array' | 'sheet' | 'help' | null>(null);
  const polarSize = useSize('polarH', 'y');
  const debugSize = useSize('debugH', 'y');
  const gpsSize = useSize('gpsH', 'y');

  // ---- first run ----
  //
  // An EMPTY project, deliberately. The application used to open on a
  // sixteen-cabinet demo, which is a fine way to show somebody the program and
  // the wrong way to start work in it: every session began by deleting a rig
  // nobody asked for, and anything typed before that was spent on somebody
  // else's array. The example rigs now live only in the tests
  // (state/exampleRigs.ts); Presets holds what the user saved.
  //
  // It also made the test suite quietly dishonest — a case that cleared the
  // project before mounting ran against those sixteen cabinets anyway.
  useEffect(() => {
    requestFit();
  }, []);

  // ------------------------------- files ----------------------------------
  // A project double-clicked in Finder or Explorer, or dropped on the window.
  // Both replace the project, so both go through the unsaved-changes question
  // first; the file itself is opened once that is answered.
  useEffect(
    () =>
      onOpenRequest((file) => guardUnsaved({ action: 'openFile', file })),
    [],
  );
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      // Without this the web view navigates to the dropped file and the
      // application is gone from the window.
      e.preventDefault();
      if (modalIsOpen()) return;
      void file.arrayBuffer().then((b) =>
        guardUnsaved({ action: 'openFile', file: { path: null, name: file.name, bytes: new Uint8Array(b) } }),
      );
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  // The window title names the file and says when it has unsaved changes;
  // the desktop shells copy it into their own title bar.
  const title = `${s.dirty ? '• ' : ''}${s.file.name ?? s.project.name} · ${BRANDING.productName}`;
  useEffect(() => {
    document.title = title;
  }, [title]);

  // ------------------------------- keyboard -------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A dialog owns the keyboard while it is open. Every binding below acts on
      // the project BEHIND it and most of them are edits: the arrows walked the
      // selection, Cmd+D duplicated it, Cmd+Z undid something the user could not
      // see, and Backspace raised a delete confirmation stacked on top of the
      // dialog already on screen. None of that is what the keystroke meant.
      if (modalIsOpen()) return;

      // Save and Open work from anywhere, a text field included: Cmd+S typed
      // while a delay is being edited means "save", as in any document program.
      if (e.key === 'F1') {
        e.preventDefault();
        setDialog('help');
        return;
      }

      const fileMod = e.metaKey || e.ctrlKey;
      const fileKey = e.key.toLowerCase();
      if (fileMod && fileKey === 's') {
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur?.(); // commit the field being typed in first
        void saveProject(e.shiftKey);
        return;
      }
      if (fileMod && fileKey === 'o') {
        e.preventDefault();
        guardUnsaved({ action: 'open' });
        return;
      }

      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        return;
      }
      const st = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); st.redo(); return; }
      if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); st.copySelection(); return; }
      if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); st.paste(); return; }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); st.duplicateSelected(); return; }
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); st.selectAll(); return; }
      if (mod && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        if (e.shiftKey && st.selectedGroupId) st.ungroup(st.selectedGroupId);
        else st.groupSelected();
        return;
      }
      if (mod && e.key === 'Enter') { e.preventDefault(); st.recalculate(); return; }

      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); st.deleteSelected(); return; }
      if (e.key === 'Escape') { st.selectSources([]); st.selectPoint(null); st.selectGroup(null); return; }
      if (e.key === 'f' || e.key === 'F') { window.dispatchEvent(new Event('btr:fit')); return; }

      if (e.key === '[' || e.key === ']') {
        const d = (e.key === ']' ? 1 : -1) * (e.shiftKey ? 1 : 5);
        if (!st.selectedSourceIds.length) return;
        e.preventDefault();
        // jak jedna bryła, wokół środka zaznaczenia (rotateSelection)
        st.rotateSelected(st.selectedSourceIds, d);
        return;
      }

      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1],
      };
      const a = arrows[e.key];
      if (a) {
        if (!st.selectedSourceIds.length) return;
        e.preventDefault();
        const step = e.shiftKey ? 0.01 : st.snap || 0.1;
        const [dh, dv] = a;
        const delta = st.sim.plane === 'top'
          ? { x: dh * step, y: dv * step, z: 0 }
          : { x: 0, y: dh * step, z: dv * step };
        st.moveSources(st.selectedSourceIds, delta);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <CrashRecovery />
      <TopBar
        onDelaySheet={() => setDialog('sheet')}
        onHelp={() => setDialog('help')}
        computing={prediction.computing}
      />

      <main className="workspace">
        <LeftColumn onAdd={() => setDialog('speaker')} onCreateArray={() => setDialog('array')} />
        <Splitter axis="x" target="prev" sizeKey="leftW" min={230} max={860} />

        <section className="col center">
          <header className="panel-head">
            <span className="plot-title">
              {s.sim.plane === 'top'
                ? t('plot.headingTop', { offset: s.sim.area.planeOffset })
                : t('plot.headingSide', { offset: s.sim.area.planeOffset })}
            </span>
            <span className="spacer" />
            <span className="plot-freq">
              {/* Say it on the picture itself. A band-averaged map and a
                  single-tone map of the same array look different enough that
                  someone reading a screenshot later has to be able to tell
                  which one they are looking at. Pink noise all the more so. */}
              {s.sim.signal === 'pink' ? (
                <>
                  {t('right.pinkNoise')} {s.sim.pinkLoHz.toFixed(0)}-{s.sim.pinkHiHz.toFixed(0)} Hz
                  {prediction.result ? ` (${prediction.result.bandPoints})` : ''} ·{' '}
                </>
              ) : (
                <>
                  {s.sim.frequencyHz.toFixed(1)} Hz ·{' '}
                  {s.sim.bandOct > 0 && (
                    <>
                      {s.sim.bandOct >= 1 ? t('right.fullOctave') : t('right.thirdOctave')}
                      {prediction.result ? ` (${prediction.result.bandPoints})` : ''} ·{' '}
                    </>
                  )}
                </>
              )}
              {s.sim.dbPerDivision
                ? t('plot.perDivision', { db: s.sim.dbPerDivision })
                : t('plot.continuous')}
            </span>
            {/* What the map stands on, next to what it shows (state/dataGrade.ts). */}
            {dataGrade && (
              <span className="plot-grade" title={t('plot.dataHint')}>
                {t('plot.data')} <QualityBadge q={dataGrade.grade} />{' '}
                {dataGrade.models > 1
                  ? t('plot.dataWeakest', { label: t(QUALITY_KEY[dataGrade.grade]), n: dataGrade.models })
                  : t(QUALITY_KEY[dataGrade.grade])}
              </span>
            )}
          </header>

          <div className="plot">
            {s.view3d ? (
              <Canvas3D result={prediction.result} />
            ) : (
              <CanvasStage result={prediction.result} />
            )}

            {s.renderStale && (
              <div className="stale-banner">
                {t('tb.stale')}
                <button className="primary" onClick={() => s.recalculate()}>{t('right.recalculate')}</button>
              </div>
            )}

            {/* A refused solve owns this space before the "add a subwoofer"
                prompt does. Gating the prompt on the PROJECT fixed an overlay
                painted over a canvas full of cabinets, but it left the other
                reason the canvas can be blank with nothing on it at all: a
                project WITH cabinets and one unusable number showed an empty
                plot, no banner and no status text, and said why only in the
                developer console. */}
            {prediction.refusal ? (
              <div className="canvas-empty">
                <div className="canvas-message">
                <p>{t('plot.refused')}</p>
                <p className="hint">{t('plot.refusedWhy')}</p>
                {/* The engine's own words, untranslated on purpose: they name a
                    field of the project, and the name is what makes it
                    fixable. */}
                <p className="hint mono">{prediction.refusal}</p>
                </div>
              </div>
            ) : (
              s.sources.length === 0 && (
                <div className="canvas-empty">
                  <div className="canvas-message">
                    <p>{t('plot.emptyTitle')}</p>
                    <button className="primary" onClick={() => setDialog('speaker')}>{t('plot.addSub')}</button>
                  </div>
                </div>
              )
            )}
          </div>

          <PlotToolbar />
          {s.showPolar && prediction.solved && (
            <>
              <Splitter axis="y" target="next" sizeKey="polarH" min={150} max={720} />
              <PolarPlot
                sources={prediction.solved.sources}
                speedOfSound={prediction.solved.speedOfSound}
                ground={prediction.solved.ground}
                style={polarSize}
              />
            </>
          )}
          {s.showGps && (
            <>
              <Splitter axis="y" target="next" sizeKey="gpsH" min={110} max={720} />
              <SourceGps style={gpsSize} />
            </>
          )}
          {s.showDebug && (
            <>
              <Splitter axis="y" target="next" sizeKey="debugH" min={90} max={620} />
              <DebugPanel style={debugSize} />
            </>
          )}
        </section>

        <Splitter axis="x" target="next" sizeKey="rightW" min={210} max={680} />
        <RightColumn prediction={prediction} />
      </main>

      <ConfirmDialog />
      <Toast />
      {dialog === 'speaker' && <SpeakerDialog onClose={() => setDialog(null)} />}
      {dialog === 'array' && <ArrayDialog onClose={() => setDialog(null)} />}
      {dialog === 'sheet' && <DelaySheetDialog onClose={() => setDialog(null)} />}
      {dialog === 'help' && <HelpDialog onClose={() => setDialog(null)} />}
      {s.tutorialOpen && <Tutorial />}
      <StatusBar />

    </div>
  );
}
