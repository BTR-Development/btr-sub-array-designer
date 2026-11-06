import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { NumField } from './widgets';
import { GroupInspector } from './Inspector';
import { SteeringPanel } from './SteeringPanel';
import { Splitter } from './Splitter';
import { useSize } from './useSize';
import { useT } from '../i18n/useT';
import { Icon } from './icons';
import { planeAxes } from '../render/view';

/** Enter or Space on a focused row does what a click on it does. */
function onActivate(run: (e: React.KeyboardEvent) => void) {
  return (e: React.KeyboardEvent) => {
    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      run(e);
    }
  };
}

/**
 * Project side of the workspace: the source tree, the array module editor and the
 * prediction area. Each block is its own collapsible panel with its own scroll
 * region, so a long source list never pushes the module controls off screen.
 */
export function LeftColumn({
  onAdd,
  onCreateArray,
}: {
  onAdd: () => void;
  onCreateArray: () => void;
}) {
  const s = useStore();
  const t = useT();
  const [filter, setFilter] = useState('');
  const [openSources, setOpenSources] = useState(true);
  const [openArea, setOpenArea] = useState(false);
  const colSize = useSize('leftW', 'x');
  const sourcesSize = useSize('sourcesH', 'y');
  const areaSize = useSize('areaH', 'y');

  // Opening the array view hands the column to it; closing it gives the tree
  // back. Only the transition is acted on, so re-opening the tree by hand while
  // the array view is up sticks.
  const wasSteering = useRef(s.showSteering);
  useEffect(() => {
    if (s.showSteering !== wasSteering.current) {
      wasSteering.current = s.showSteering;
      setOpenSources(!s.showSteering);
    }
  }, [s.showSteering]);

  // Picking a group is asking to edit it, and its controls live in the Groups
  // panel, so the panel comes up with it. Only the transition is acted on, so the
  // panel can be closed again with the group still selected.
  const selectedGroup = s.selectedGroupId;
  const toggle = s.toggle;
  const wasGroup = useRef(selectedGroup);
  useEffect(() => {
    if (selectedGroup !== wasGroup.current) {
      wasGroup.current = selectedGroup;
      if (selectedGroup && !useStore.getState().showGroups) toggle('showGroups');
    }
  }, [selectedGroup, toggle]);

  const ungrouped = s.sources.filter((x) => !x.groupId);
  const match = (label: string) => !filter || label.toLowerCase().includes(filter.toLowerCase());

  /**
   * The order rows appear in, which is what a shift-range has to follow — not the
   * order they happen to sit in the project array.
   *
   * A collapsed module is already left out, and a row the filter is hiding has
   * to be left out for the same reason: it is not on screen, so it is not
   * between the two rows the operator shift-clicked. Built without the filter,
   * the range ran over the whole tree and selected cabinets the user could not
   * see, and the next level or delete landed on them.
   */
  const visibleOrder = [
    ...s.groups.flatMap((g) =>
      g.collapsed
        ? []
        : s.sources.filter((x) => x.groupId === g.id && match(x.label)).map((x) => x.id),
    ),
    ...ungrouped.filter((x) => match(x.label)).map((x) => x.id),
  ];

  return (
    <aside className="col left-col" style={colSize}>
      {s.showGroups && (
        <>
          <GroupPanel />
          <Splitter axis="y" target="prev" sizeKey="groupsH" min={70} max={900} />
        </>
      )}

      {/* ───────────────────────────────────────────────────── sources ── */}
      <section
        className={`panel${openSources ? ' grow sized' : ''}`}
        style={openSources ? sourcesSize : undefined}
      >
        <header className="panel-head">
          <button className="twisty" aria-label={t('src.title')} aria-expanded={openSources} onClick={() => setOpenSources((v) => !v)}>
            <Icon name="chevron" className={openSources ? '' : 'twisty-closed'} />
          </button>
          {t('src.title')}
          <span className="spacer" />
          <button className="panel-head-btn src-add" onClick={onAdd}>{t('src.add')}</button>
          <button
            className="panel-head-btn"
            onClick={onCreateArray}
            disabled={s.selectedSourceIds.length !== 1}
            title={t('src.arrayHint')}
          >
            {t('src.arrayDots')}
          </button>
        </header>

        {openSources && (
          <>
            <div className="panel-actions">
              <button onClick={() => s.groupSelected()} disabled={!s.selectedSourceIds.length}>{t('src.group')}</button>
              <button onClick={() => s.duplicateSelected()} disabled={!s.selectedSourceIds.length}>{t('src.duplicate')}</button>
              <button
                className="danger"
                onClick={() => s.deleteSelected()}
                disabled={!s.selectedSourceIds.length && !s.selectedPointId}
              >
                {t('src.delete')}
              </button>
            </div>

            <div className="col-scroll">
              {s.sources.length > 8 && (
                <div className="tree-filter">
                  <input
                    className="text-input filter"
                    placeholder={t('src.filter')}
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </div>
              )}

              <div className="tree">
                {s.groups.map((g) => {
                  const members = s.sources.filter((x) => x.groupId === g.id);
                  return (
                    <div key={g.id}>
                      <div
                        className={`tree-row group${s.selectedGroupId === g.id ? ' sel' : ''}`}
                        onClick={() => s.selectGroup(g.id)}
                        tabIndex={0}
                        role="button"
                        aria-pressed={s.selectedGroupId === g.id}
                        onKeyDown={onActivate(() => s.selectGroup(g.id))}
                      >
                        <button
                          className="twisty"
                          aria-label={g.name}
                          aria-expanded={!g.collapsed}
                          onClick={(e) => {
                            e.stopPropagation();
                            s.patchGroup(g.id, { collapsed: !g.collapsed }, false);
                          }}
                        >
                          <Icon name="chevron" className={g.collapsed ? 'twisty-closed' : ''} />
                        </button>
                        <span className="tree-name">{g.name}</span>
                        <span className="tree-meta mono">
                          {g.levelOffsetDb !== 0 && `${g.levelOffsetDb > 0 ? '+' : ''}${g.levelOffsetDb} dB `}
                          {g.delayOffsetS !== 0 && `${(g.delayOffsetS * 1000).toFixed(1)} ms`}
                        </span>
                        <button
                          className={`mute-btn${g.mute ? ' on' : ''}`}
                          title={t('src.muteGroup')}
                          onClick={(e) => {
                            e.stopPropagation();
                            s.patchGroup(g.id, { mute: !g.mute });
                          }}
                        >
                          M
                        </button>
                      </div>
                      {!g.collapsed &&
                        members
                          .filter((m) => match(m.label))
                          .map((src) => <SourceRow key={src.id} id={src.id} order={visibleOrder} indent />)}
                    </div>
                  );
                })}

                {ungrouped
                  .filter((m) => match(m.label))
                  .map((src) => <SourceRow key={src.id} id={src.id} order={visibleOrder} />)}

                {!s.sources.length && (
                  <p className="empty-hint small">{t('src.empty')}</p>
                )}

                {s.measurementPoints.length > 0 && (
                  <>
                    <div className="menu-sep tree-points-head">{t('src.measurementPoints')}</div>
                    {s.measurementPoints.map((mp) => (
                      <div
                        key={mp.id}
                        className={`tree-row point${s.selectedPointId === mp.id ? ' sel' : ''}`}
                        onClick={() => s.selectPoint(mp.id)}
                        tabIndex={0}
                        role="button"
                        aria-pressed={s.selectedPointId === mp.id}
                        onKeyDown={onActivate(() => s.selectPoint(mp.id))}
                      >
                        <span className="dot" />
                        <span className="tree-name">{mp.name}</span>
                        {/* The pair follows the DRAWN plane, so the numbers in
                            the list are the ones the dot sits at on the canvas.
                            Fixed X/Y read as a contradiction in side view: the
                            row said 0.0, 28.0 for a dot plainly at 28 across
                            and 1.6 up. Full coordinates are in the tooltip. */}
                        <span
                          className="tree-meta mono"
                          title={`X ${mp.position.x.toFixed(2)} · Y ${mp.position.y.toFixed(2)} · Z ${mp.position.z.toFixed(2)} m`}
                        >
                          {planeAxes(s.sim.plane, mp.position)
                            .map((n) => n.toFixed(1))
                            .join(', ')}
                        </span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </section>

      {/* ──────────────────────────────────────────── array module editor ── */}
      {s.showSteering && openSources && (
        <Splitter axis="y" target="prev" sizeKey="sourcesH" min={70} max={900} />
      )}
      {s.showSteering && <SteeringPanel />}

      {/* ─────────────────────────────────────────────── prediction area ── */}
      {openArea && <Splitter axis="y" target="next" sizeKey="areaH" min={60} max={700} />}
      <section className={`panel${openArea ? ' sized' : ''}`} style={openArea ? areaSize : undefined}>
        <header className="panel-head">
          <button className="twisty" aria-label={t('area.title')} aria-expanded={openArea} onClick={() => setOpenArea((v) => !v)}>
            <Icon name="chevron" className={openArea ? '' : 'twisty-closed'} />
          </button>
          {t('area.title')}
          <span className="spacer" />
          <button
            className="panel-head-btn"
            title={t('area.toViewHint')}
            onClick={() => window.dispatchEvent(new Event('btr:areaToView'))}
          >
            {t('area.toView')}
          </button>
        </header>
        {openArea && <AreaBody />}
      </section>
    </aside>
  );
}

/** Every group in the project, and the controls of the one that is selected. */
function GroupPanel() {
  const s = useStore();
  const t = useT();
  const size = useSize('groupsH', 'y');
  const selected = s.groups.some((g) => g.id === s.selectedGroupId);

  return (
    <section className="panel grow sized group-panel" style={size}>
      <header className="panel-head">
        {t('groups.title')}
        <span className="spacer" />
        <button className="twisty" aria-label={t('ui.close')} onClick={() => s.toggle('showGroups')}>
          <Icon name="close" />
        </button>
      </header>
      <div className="col-scroll">
        <div className="tree">
          {s.groups.map((g) => (
            <div
              key={g.id}
              className={`tree-row group${s.selectedGroupId === g.id ? ' sel' : ''}`}
              onClick={() => s.selectGroup(g.id)}
              tabIndex={0}
              role="button"
              aria-pressed={s.selectedGroupId === g.id}
              onKeyDown={onActivate(() => s.selectGroup(g.id))}
            >
              <span className="tree-name">{g.name}</span>
              <span className="tree-meta mono">
                {t('groups.members', { n: s.sources.filter((x) => x.groupId === g.id).length })}
              </span>
              <button
                className={`mute-btn${g.mute ? ' on' : ''}`}
                title={t('src.muteGroup')}
                onClick={(e) => {
                  e.stopPropagation();
                  s.patchGroup(g.id, { mute: !g.mute });
                }}
              >
                M
              </button>
            </div>
          ))}
        </div>
        {selected ? (
          <GroupInspector />
        ) : (
          <p className="empty-hint small">{t(s.groups.length ? 'groups.pick' : 'groups.empty')}</p>
        )}
      </div>
    </section>
  );
}

function AreaBody() {
  const s = useStore();
  const t = useT();
  const a = s.sim.area;
  // The area box is expressed on the plane's own axes: X/Y on top, Y/Z on side.
  const hLabel = s.sim.plane === 'top' ? 'X' : 'Y';
  const vLabel = s.sim.plane === 'top' ? 'Y' : 'Z';

  return (
    <div className="panel-body">
      <div className="row2">
        <label className="field">
          <span className="field-label">{t('area.min', { axis: hLabel })}</span>
          <NumField value={a.xMin} onChange={(v) => s.patchSim({ area: { ...a, xMin: v } })} unit="m" step={1} />
        </label>
        <label className="field">
          <span className="field-label">{t('area.max', { axis: hLabel })}</span>
          <NumField value={a.xMax} onChange={(v) => s.patchSim({ area: { ...a, xMax: v } })} unit="m" step={1} />
        </label>
        <label className="field">
          <span className="field-label">{t('area.min', { axis: vLabel })}</span>
          <NumField value={a.vMin} onChange={(v) => s.patchSim({ area: { ...a, vMin: v } })} unit="m" step={1} />
        </label>
        <label className="field">
          <span className="field-label">{t('area.max', { axis: vLabel })}</span>
          <NumField value={a.vMax} onChange={(v) => s.patchSim({ area: { ...a, vMax: v } })} unit="m" step={1} />
        </label>
      </div>
      <div className="frow">
        <label>{t('area.planeAt', { axis: s.sim.plane === 'top' ? 'Z' : 'X' })}</label>
        <div className="frow-controls">
          <NumField
            value={a.planeOffset}
            onChange={(v) => s.patchSim({ area: { ...a, planeOffset: v } })}
            unit="m"
            step={0.5}
          />
        </div>
      </div>
      <p className="hint">{t('area.hint')}</p>
    </div>
  );
}

function SourceRow({ id, order, indent }: { id: string; order: string[]; indent?: boolean }) {
  const s = useStore();
  const t = useT();
  const src = s.sources.find((x) => x.id === id)!;
  const model = s.provider.get(src.speakerId);
  const sel = s.selectedSourceIds.includes(id);

  return (
    <div
      className={`tree-row${sel ? ' sel' : ''}${indent ? ' indent' : ''}${src.mute ? ' muted' : ''}`}
      onClick={(e) =>
        s.selectSourceAt(id, order, { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey })
      }
      tabIndex={0}
      role="button"
      aria-pressed={sel}
      onKeyDown={onActivate((e) => s.selectSourceAt(id, order, { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey }))}
    >
      <span className="tree-name">{src.label}</span>
      <span className="tree-meta mono">{model ? model.model : '-'}</span>
      {src.invertPolarity && <span className="pol" title={t('src.polarityInverted')}>Ø</span>}
      <button
        className={`mute-btn${src.mute ? ' on' : ''}`}
        title={t('src.mute')}
        onClick={(e) => {
          e.stopPropagation();
          s.patchSources([id], { mute: !src.mute });
        }}
      >
        M
      </button>
    </div>
  );
}
