import { useEffect, useState } from 'react';
import { BRANDING } from '../branding';
import { useStore } from '../state/store';
import {
  deleteUserPreset,
  listUserPresets,
  saveUserPreset,
  type UserPreset,
} from '../state/userPresets';
import { requestFit } from '../render/view';
import { Icon } from './icons';
import { Logo } from './Logo';
import { useT } from '../i18n/useT';
import { NumField } from './widgets';
import { saveMapImage } from './saveMapImage';
import { bindFileUi, guardUnsaved, saveProject } from './projectFiles';
import { fileHost } from '../platform/fileHost';
import { recentFiles, type RecentFile } from '../platform/recentFiles';
import { LANGUAGES, type Lang } from '../i18n';
import type { PredictionPlane } from '../core/types';

/**
 * Application bar: project commands on the left, the view selector in the middle,
 * environment and calculation status on the right. Everything that changes what is
 * *drawn* lives further down, next to the plot.
 */
export function TopBar({
  onDelaySheet,
  onHelp,
  computing,
}: {
  onDelaySheet: () => void;
  onHelp: () => void;
  computing: boolean;
}) {
  const s = useStore();
  const t = useT();
  const [menu, setMenu] = useState<'file' | 'presets' | null>(null);
  // Presety użytkownika czyta się przy otwarciu menu, nie przy montażu:
  // localStorage może zmienić inna karta, a menu i tak otwiera się rzadko.
  const [userPresets, setUserPresets] = useState<UserPreset[]>([]);
  const [presetName, setPresetName] = useState('');
  const openPresets = () => {
    setUserPresets(listUserPresets());
    setMenu(menu === 'presets' ? null : 'presets');
  };
  const savePreset = () => {
    const saved = saveUserPreset(presetName, s.toProject());
    if (saved) {
      setPresetName('');
      setUserPresets(listUserPresets());
    }
  };
  const loadPreset = (p: UserPreset) => {
    // Ta sama droga co otwarcie pliku: preset to projekt, więc wczytuje się
    // jak projekt i dziedziczy każdą przyszłą migrację formatu.
    s.loadDoc(
      {
        project: p.project.project,
        sources: p.project.sources,
        groups: p.project.groups,
        measurementPoints: p.project.measurementPoints,
        customSpeakers: p.project.customSpeakers,
      },
      p.project.simulationSettings,
    );
    setMenu(null);
    requestFit();
  };
  const [error, setError] = useState<string | null>(null);
  // A file can open successfully and still need something said about it.
  const [notice, setNotice] = useState<string | null>(null);

  // The file actions live in projectFiles.ts so the keyboard, the unsaved-
  // changes dialog and the operating system reach the same code; this bar
  // lends them its error and notice strips.
  useEffect(() => {
    bindFileUi({ t, setError, setNotice });
    return () => bindFileUi(null);
  }, [t]);

  const [recent, setRecent] = useState<RecentFile[]>([]);
  const openFileMenu = () => {
    if (menu !== 'file') setRecent(fileHost().canReopen ? recentFiles() : []);
    setMenu(menu === 'file' ? null : 'file');
  };
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

  const planes: Array<{ id: PredictionPlane; label: string; icon: 'topview' | 'sideview' }> = [
    { id: 'top', label: t('tb.topView'), icon: 'topview' },
    { id: 'side', label: t('tb.sideView'), icon: 'sideview' },
  ];

  const stale = s.renderStale;
  const dotClass = stale ? 'stale' : computing ? 'busy' : '';

  return (
    <header className="topbar">
      <div className="topbar-history">
        <button className="icon-only" onClick={() => s.undo()} disabled={!s.undoStack.length} title={t('tb.undo')} aria-label={t('tb.undo')}>
          <Icon name="undo" />
        </button>
        <button className="icon-only" onClick={() => s.redo()} disabled={!s.redoStack.length} title={t('tb.redo')} aria-label={t('tb.redo')}>
          <Icon name="redo" />
        </button>
      </div>
      <button className="home-btn" title={BRANDING.productName} onClick={() => requestFit()}>
        <Icon name="home" />
      </button>
      <div className="brand" title={`${BRANDING.productName} · ${t('app.author', { name: BRANDING.author })}`}>
        <Logo />
      </div>

      <div className="tabs-main">
        <div className="menu-anchor">
          <button className="tab tb-file" onClick={openFileMenu}>
            {t('tb.file')}
          </button>
          {menu === 'file' && (
            <div className="menu" onPointerLeave={() => setMenu(null)}>
              <button onClick={() => { setMenu(null); guardUnsaved({ action: 'new' }); }}>
                {t('tb.newProject')}
              </button>
              <button className="menu-open" title={t('tb.openHint')} onClick={() => { setMenu(null); guardUnsaved({ action: 'open' }); }}>
                {t('tb.open')} <small>{mod}O</small>
              </button>
              {recent.length > 0 && (
                <>
                  <div className="menu-sep">{t('tb.recent')}</div>
                  {recent.map((r) => (
                    <button
                      key={r.path}
                      className="menu-recent"
                      title={r.path}
                      onClick={() => { setMenu(null); guardUnsaved({ action: 'openPath', path: r.path }); }}
                    >
                      {r.name}
                    </button>
                  ))}
                  <div className="menu-sep" />
                </>
              )}
              <button className="menu-save" onClick={() => { setMenu(null); void saveProject(); }}>
                {t('tb.save')} <small>{mod}S</small>
              </button>
              <button className="menu-save-as" onClick={() => { setMenu(null); void saveProject(true); }}>
                {t('tb.saveAsFile')} <small>⇧{mod}S</small>
              </button>
              <div className="menu-sep">{t('tb.handOff')}</div>
              <button
                className="menu-delay-sheet"
                onClick={() => { setMenu(null); onDelaySheet(); }}
                title={t('tb.delaySheetHint')}
              >
                {t('tb.delaySheet')}
              </button>
              <button
                className="menu-map-image"
                onClick={async () => {
                  setMenu(null);
                  setError(null);
                  if (!(await saveMapImage(useStore.getState(), t))) setNotice(t('tb.mapImageNone'));
                }}
                title={t('tb.mapImageHint')}
              >
                {t('tb.mapImage')} <small>.png</small>
              </button>
            </div>
          )}
        </div>

        <div className="menu-anchor">
          <button className="tab" onClick={openPresets}>
            {t('tb.presets')}
          </button>
          {menu === 'presets' && (
            <div className="menu wide" onPointerLeave={() => setMenu(null)}>
              {/* Tylko presety użytkownika. Wbudowanych nie ma: preset jest
                  zapisanym projektem TEGO użytkownika, nie materiałem
                  szkoleniowym. */}
              <div className="preset-save">
                <input
                  className="text-input"
                  value={presetName}
                  placeholder={t('tb.presetNamePh')}
                  onChange={(e) => setPresetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') savePreset();
                  }}
                />
                <button onClick={savePreset} disabled={!presetName.trim()}>
                  {t('tb.presetSave')}
                </button>
              </div>
              {!userPresets.length && <div className="menu-sep">{t('tb.presetsEmpty')}</div>}
              {userPresets.map((p) => (
                <div key={p.id} className="preset-row">
                  <button onClick={() => loadPreset(p)}>
                    <b>{p.name}</b>
                    <small>
                      {p.project.sources.length} · {new Date(p.savedAt).toLocaleDateString()}
                    </small>
                  </button>
                  <button
                    className="preset-del"
                    title={t('tb.presetDelete')}
                    onClick={() => {
                      deleteUserPreset(p.id);
                      setUserPresets(listUserPresets());
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <span className="tab-sep" />

        {planes.map((p) => (
          <button
            key={p.id}
            // The plane is still the plane in the 3D view — it is what the SPL
            // is computed on — so picking one here leaves 3D and shows it.
            className={`tab${!s.view3d && s.sim.plane === p.id ? ' on' : ''}`}
            onClick={() => {
              s.patchSim({ plane: p.id });
              if (s.view3d) s.toggle('view3d');
            }}
            title={p.id === 'top' ? t('tb.topViewHint') : t('tb.sideViewHint')}
          >
            <Icon name={p.icon} /> {p.label}
          </button>
        ))}
        <button
          className={`tab${s.view3d ? ' on' : ''}`}
          onClick={() => {
            // Wejście w 3D stawia płaszczyznę predykcji POZIOMO. 3D
            // dziedziczyło płaszczyznę po ostatnim widoku 2D, więc po
            // sekwencji "z góry -> z boku -> 3D" mapa stała pionowo — a scena
            // 3D jest od oglądania rigu nad podłogą, nie ściany. Pionową mapę
            // w 3D i tak nikt nie wybierał: wybierał ją PRZYPADEK kolejności
            // zakładek. Wyjście w widok z boku dalej ustawia pion, jak dotąd.
            if (!s.view3d && s.sim.plane !== 'top') s.patchSim({ plane: 'top' });
            s.toggle('view3d');
          }}
          title={t('tb.view3dHint')}
        >
          <Icon name="view3d" /> {t('tb.view3d')}
        </button>

        <span className="tab-sep" />

        <button
          className={`tab tab-array${s.showSteering ? ' on' : ''}`}
          onClick={() => s.toggle('showSteering')}
          title={t('tb.arrayHint')}
        >
          {t('tb.array')}
        </button>
        <button
          className={`tab tab-groups${s.showGroups ? ' on' : ''}`}
          onClick={() => s.toggle('showGroups')}
          title={t('tb.groupsHint')}
        >
          {t('tb.groups')}
        </button>
        <button
          className={`tab${s.showPolar ? ' on' : ''}`}
          onClick={() => s.toggle('showPolar')}
          title={t('tb.polarHint')}
        >
          {t('tb.polar')}
        </button>
        <button
          className={`tab${s.showGps ? ' on' : ''}`}
          onClick={() => s.toggle('showGps')}
          title={t('tb.gpsHint')}
        >
          {t('tb.gps')}
        </button>
        <button className="tab tb-help" onClick={onHelp} title={t('tb.helpHint')}>
          {t('tb.help')}
        </button>
      </div>


      <div className="topbar-spacer" />

      <div className="topbar-group">
        <span className="field-label" title={t('tb.temperature')}><Icon name="temperature" /></span>
        {/* Also a NumField rather than its own input, for the reasons in
            widgets.tsx: this one recomputed the whole map on every keystroke
            of a two-digit temperature. */}
        <NumField
          label={t('tb.temperature')}
          value={s.sim.temperatureC}
          onChange={(v) => s.patchSim({ temperatureC: v })}
          min={-40}
          max={60}
          step={1}
          width={54}
        />
        <span className="topbar-readout">°C · c = {s.sim.speedOfSound.toFixed(1)} m/s</span>
      </div>

      <div className="topbar-group">
        <select
          className="text-input tiny lang-select"
          title={t('tb.language')}
          value={s.lang}
          onChange={(e) => s.setLang(e.target.value as Lang)}
        >
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>{l.label}</option>
          ))}
        </select>
      </div>

      <div className="topbar-group">
        <span className="status-pill">
          <span className={`status-dot ${dotClass}`} />
          {stale ? t('tb.stale') : computing ? t('tb.calculating') : t('tb.ready')}
        </span>
      </div>

      <div className="topbar-group">
        {/* Nazwa projektu jest teraz polem, nie napisem: w makiecie ma ramkę
            przy najechaniu i akcent przy wpisywaniu. Bez historii — patrz
            renameProject w store. */}
        <input
          className="project-name"
          value={s.project.name}
          placeholder={t('tb.untitled')}
          title={t('tb.projectName')}
          onChange={(e) => s.renameProject(e.target.value)}
        />
      </div>

      {error && (
        <div className="tb-error" onClick={() => setError(null)} role="alert">
          {error} <Icon name="close" />
        </div>
      )}

      {notice && (
        <div className="tb-notice" onClick={() => setNotice(null)} role="status">
          {notice} <Icon name="close" />
        </div>
      )}
    </header>
  );
}
