import { useEffect, useMemo, useRef, useState } from 'react';
import { allSpeakers, useStore } from '../state/store';
import { NumField } from './widgets';
import { holdDraft } from './holdDraft';
import { planDelays, type SteerMode } from '../state/arrayTools';
import { acousticOrigin } from '../speakers/schema';
import {
  INITIAL_ARRAY_MODULE,
  aimForPatternLimit,
  arrayModuleReducer,
  derive,
  measure,
  forwardAzimuthOf,
  moduleNameFor,
  orientationOf,
  resolveAxis,
  reverseDelayOffsets,
  shouldRestee,
  type ArrayModuleAction,
  type ArrayModuleState,
} from '../state/arrayModule';
import {
  crossAxes,
  distanceToDelay,
  endFireSpacingFor,
  focusRadiusForDispersion,
  patternControlLimitHz,
  steerDegForDownTilt,
  tiltAngleFromGeometry,
  type ArrayAxis,
  type BlockAnchor,
} from '../engine/steering';
import { SourceTable } from './SourceTable';
import { Icon } from './icons';
import { useT } from '../i18n/useT';
import type { MessageKey } from '../i18n';

const MS = 1000;

const ANCHORS: BlockAnchor[] = ['low', 'centre', 'high'];


/**
 * The two orientations a cabinet is ever actually flown or stacked in.
 *
 * Roll is a free angle in the model and the engine honours any value of it, but
 * nobody rigs a sub at 37 degrees: it is either the way up it was designed or
 * turned onto its end face to narrow the footprint. Offering the two keeps the
 * control honest about what it is for, and the Inspector still takes a number
 * for anyone who wants one.
 */
const ORIENTATIONS = [0, 90] as const;


/**
 * What the two ends of a block are CALLED depends on the axis it runs along.
 * The maths only knows "toward -axis" and "toward +axis"; a person reading the
 * plan sees left and right along X, and upstage and downstage along Y.
 */
function anchorLabel(anchor: BlockAnchor, axis: ArrayAxis): MessageKey {
  if (anchor === 'centre') return 'subs.anchorCentre';
  if (axis === 'y') return anchor === 'low' ? 'subs.anchorBack' : 'subs.anchorFront';
  return anchor === 'low' ? 'subs.anchorLeft' : 'subs.anchorRight';
}

function anchoredPositionKey(anchor: BlockAnchor, axis: ArrayAxis): MessageKey {
  if (anchor === 'centre') return 'subs.centredAt';
  if (axis === 'y') return anchor === 'low' ? 'subs.backEdgeAt' : 'subs.frontEdgeAt';
  return anchor === 'low' ? 'subs.leftEdgeAt' : 'subs.rightEdgeAt';
}

const MODES: SteerMode[] = ['flat', 'steer', 'dispersion', 'endfire'];
const MODE_KEY: Record<SteerMode, MessageKey> = {
  flat: 'mode.flat',
  steer: 'mode.steer',
  dispersion: 'mode.dispersion',
  endfire: 'mode.endfire',
};

/**
 * The SUBS panel: define the module, lay it out, taper the delay.
 *
 * Laid out the way a system engineer reads it: footprint first,
 * then the delay taper, then the cabinet table — but every number shown is
 * derived from engine/steering.ts. Nothing here computes acoustics of its own.
 */
export function SteeringPanel() {
  const s = useStore();
  const t = useT();
  const inUse = [...new Set(s.sources.map((x) => x.speakerId))].join('|');
  const speakers = useMemo(() => allSpeakers(s.customSpeakers, inUse.split('|')), [s.customSpeakers, inUse]);

  // ---- what is the module? -------------------------------------------------
  // A module is a GROUP, or the whole project when no group is picked. It is
  // deliberately not "whatever is selected": the table lists the module, and if
  // selecting a row redefined the module the table would collapse under the
  // click — which also made shift-ranges inside it impossible.
  const group = s.groups.find((g) => g.id === s.selectedGroupId) ?? null;
  const members = group ? s.sources.filter((x) => x.groupId === group.id) : s.sources;
  const ids = members.map((m) => m.id);
  const moduleKey = group?.id ?? '*';

  // Everything about what an edit MEANS lives in state/arrayModule.ts, so the
  // portal build can drive the same behaviour from a different set of widgets.
  // This component decides how the controls look and nothing else.
  const [m, setM] = useState<ArrayModuleState>(INITIAL_ARRAY_MODULE);
  const [more, setMore] = useState(false);

  const axis = resolveAxis(m, members);
  const [axisB, axisC] = crossAxes(axis);

  // "Equally spaced along" is the OUTER footprint — outer face of one end cabinet
  // to outer face of the other — because that is what gets taped out on the deck.
  //
  // The height is what turns a line along Z into a vertical STACK: cabinets rest
  // on each other, so the pitch stops being a choice and the column is placed by
  // a face instead. Both stay null when the model does not confirm them, and the
  // editor degrades rather than guessing a box size.
  //
  // The dimensions handed over are the PUBLISHED ones, upright. Rolling them
  // here was a real defect: two orientations are in play — the one the cabinets
  // are standing in, which every reference face must be read against, and the
  // one this layout is about to write — and a single pre-rolled pair collapsed
  // them. Pressing "On end" then reported the deck height of a rig standing ON
  // the deck as -0.19 m, and one Apply layout made that true. `derive` rolls
  // them itself, twice, and keeps the two apart.
  // TWO models, kept apart for the same reason the two orientations are: the
  // cabinet the rig is MADE of decides where its faces are, and the one picked
  // in the System dropdown decides what the layout will write. Collapsed into
  // one, merely choosing a different box in the dropdown re-read the deck
  // height of a rig standing on the deck as -0.38 m.
  const held = s.provider.get(members[0]?.speakerId || '');
  const model = s.provider.get(m.speakerId || members[0]?.speakerId || '');
  // Turning the box over only tells you anything when both sides are published:
  // at 90 degrees the new width IS the old height. One of the two missing makes
  // the turned box unknown, and this project does not fill that in.
  const canRoll = !!model && model.dimensions.widthM != null && model.dimensions.heightM != null;

  // The separation of the gradient a reverse stack builds: the distance between
  // a forward cabinet's radiating point and a turned-round one's. Taken from
  // `acousticOrigin` rather than from the depth, so a model that declares its
  // own origin is believed — the two agree at the default, where the origin is
  // the front baffle at depth/2 and the separation is the whole depth.
  //
  // Projected by the tilt, because both cabinets tilt TOGETHER: the two origins
  // sit at +-(d/2) along a shared front vector, so their separation is
  // d·cos(elevation) and purely horizontal — the vertical components cancel.
  // Written as the full d, a stack tilted 20 degrees lost 9 dB of rear
  // rejection and one tilted 30 degrees lost 13.
  const tilt = (members[0]?.rotation.elevationDeg ?? 0) * (Math.PI / 180);
  const gradientSpanM = model ? 2 * Math.abs(acousticOrigin(model).y) * Math.cos(tilt) : 0;

  const liveGeom = measure(members, axis, {
    publishedWidthM: held?.dimensions.widthM ?? 0,
    publishedHeightM: held?.dimensions.heightM ?? 0,
    plannedWidthM: model?.dimensions.widthM ?? 0,
    plannedHeightM: model?.dimensions.heightM ?? 0,
    gradientSpanM,
    isCardioid: model?.type === 'cardioid',
    isOmni: !model || model.predictionData.kind === 'omni',
  });
  const view = derive(m, liveGeom);
  const dispatch = (a: ArrayModuleAction) => setM((prev) => arrayModuleReducer(prev, a, liveGeom));

  // A different module is a different array: drop pending edits and disarm.
  useEffect(() => {
    setM((prev) => arrayModuleReducer(prev, { type: 'moduleChanged' }, liveGeom));
    // liveGeom belongs to the module being left; the action ignores it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleKey]);

  const c = s.sim.speedOfSound;
  const aim = aimForPatternLimit(m);
  const limitHz = patternControlLimitHz(view.spacing, c, aim.steerDeg, aim.dispersionDeg);
  const focusR =
    m.mode === 'dispersion'
      ? focusRadiusForDispersion(view.plannedSpan, m.dispersionDeg)
      : Infinity;

  // The gradient delay a turned-round cabinet needs, per member. Pisany do
  // ZASZYTEGO pola obok planu, nie do kolumny delayów: plan niesie czysty łuk,
  // silnik dolicza gradient sam, i żadne narzędzie delayów nie umie go już
  // spłaszczyć. Patrz Source.gradientDelayS.
  const gradientDelayS = gradientSpanM > 0 ? distanceToDelay(gradientSpanM, c) : 0;
  // The heading the rig faces is a FACT taken from the end that is not
  // designated, not a majority vote: a vote has no answer for a half-reversed
  // stack and the wrong answer for a more-than-half one.
  const forwardDeg = forwardAzimuthOf(members);
  const gradientDelaysS = useMemo(
    () => reverseDelayOffsets(members, gradientDelayS, forwardDeg),
    [members, gradientDelayS, forwardDeg],
  );

  const plan = useMemo(
    () =>
      planDelays(members, {
        mode: m.mode,
        steerDeg: m.steerDeg,
        dispersionDeg: m.dispersionDeg,
        axis,
        speedOfSound: c,
        // Null means nobody has touched the taper control, and the plan then
        // carries no level column at all. Handing 0 through instead made every
        // apply flatten hand-set cabinet levels, because levelTaper(0) is a
        // valid taper: it is the one that takes a taper OFF.
        edgeTaperDb: m.taperDb ?? undefined,
        // Pozycja, nie obudowa: wszystkie obudowy jednej pozycji dostają delay
        // liczony dla jej środka. Przy stosie wychodzi to samo co dotąd (jeden
        // X), przy rzędzie dopiero to sprawia, że gradient zostaje gradientem.
        placeTolM: view.acrossM > 0 ? view.acrossM + 1e-3 : undefined,
      }),
    [members, m.mode, m.steerDeg, m.dispersionDeg, axis, c, m.taperDb, view.acrossM],
  );

  // A deliberate apply owns the module: it gathers the cabinets into a group
  // named after the transform, and it takes an undo entry of its own.
  const applyDelay = () =>
    s.applyDelayPlan(ids, plan, { groupAs: moduleNameFor(m), gradientDelaysS });

  // Live steering writes the same plan and NOTHING ELSE. It does not group:
  // creating a group re-points the editor at the new module, which drops layout
  // edits that were typed and not applied yet, so a slider the user read as a
  // preview quietly discarded their work. And it opens one undo entry per drag
  // rather than one per settling point of it.
  const applyLive = () => {
    s.applyDelayPlan(ids, plan, { history: !m.liveWrote, gradientDelaysS });
    dispatch({ type: 'liveApplied' });
  };

  // Whether live steering has anything to write is a rule, not a rendering
  // concern, so it lives in the module beside the rest of them. Without the
  // comparison it makes, applying a plan would produce a new plan and the live
  // mode would re-apply its own result forever.
  const restee = shouldRestee(m, members, plan);

  const applyRef = useRef(applyLive);
  applyRef.current = applyLive;
  useEffect(() => {
    if (!restee) return;
    const timer = setTimeout(() => applyRef.current(), 180);
    return () => clearTimeout(timer);
  }, [restee]);

  const applyLayout = (over?: { spacingM?: number; history?: boolean }) => {
    s.applyArrayLayout(ids, {
      history: over?.history,
      count: view.count,
      spacingM: over?.spacingM ?? view.spacing,
      axis,
      centreM: view.centre,
      // The Z cross-axis carries the stack's CENTRE, converted from the deck or
      // rigging height the field shows. On the other axes the field IS the
      // coordinate, and with one cabinet per position the conversion is the
      // identity, so nothing moves for a plain line.
      cross: { [axisB]: view.posB, [axisC]: axisC === 'z' ? view.stackCentreZ : view.posC },
      // Only an aim that was actually typed is written. Passing the READING back
      // in re-fans a hand-aimed block and levels off individually tilted
      // cabinets, which is a layout tool overwriting somebody's aiming.
      splayDeg: view.splayTyped ?? undefined,
      elevationDeg: view.elevationTyped ?? undefined,
      speakerId: m.speakerId || undefined,
      perPosition: view.perPosition,
      stackPitchM: view.stackPitchM,
      // 0 unless the cabinets stand on their end face, where a position is a
      // row rather than a stack. See LayoutOptions.acrossM.
      acrossM: view.acrossM,
      // Only what was actually ASKED for. A reading must never become an
      // instruction: passing the measured reversal back in made every Apply
      // layout rewrite the heading and polarity of a rig nobody had touched,
      // and its default of 'none' straightened hand-built cardioids.
      // Tylko to, o co ktoś NAPRAWDĘ poprosił. Odczyt nie może stać się
      // poleceniem: podanie zmierzonego wzoru z powrotem sprawiłoby, że każde
      // „Zastosuj rozstaw” przepisuje heading i polaryzację rigu, którego nikt
      // nie tknął.
      reversePattern: view.reversePatternTyped ?? undefined,
      reverseCount: view.reverseCount,
      reverseDelayS: gradientDelayS,
      // The heading the reversal is measured against has to come from the
      // module, not from each cabinet, or a second press would turn the already
      // reversed box back to the front. See LayoutOptions.forwardAzimuthDeg.
      forwardAzimuthDeg: forwardDeg,
      rollDeg: view.rollTyped ?? undefined,
    });
    dispatch({ type: 'layoutApplied' });
  };

  // Wzór F/B działa NATYCHMIAST na obudowy — przyciski i rig nie mogą się
  // rozjechać. Pisane są tylko kierunek, polaryzacja i zaszyty gradient;
  // pozycji ani wysokości zmiana wzoru nie rusza (writeReversalPattern).
  // Ścieżka odroczona (podgląd do "Zastosuj rozstaw") zostaje wyłącznie wtedy,
  // gdy wzór opisuje rig, którego jeszcze nie ma: oczekuje zmiana liczby
  // obudów na pozycję albo orientacji, albo rig jest nieopisywalny.
  const patternIsLive =
    view.reversePatternTyped == null &&
    view.rollTyped == null &&
    view.perPosition === liveGeom.perPosition &&
    liveGeom.positionsUniform &&
    liveGeom.reversalDescribable;
  const togglePattern = (i: number) => {
    if (!patternIsLive) {
      dispatch({ type: 'toggleReverseIndex', index: i });
      return;
    }
    const next = view.reversePattern.map((v, k) => (k === i ? !v : v));
    if (next.every(Boolean)) return; // przycisk i tak jest zablokowany
    s.setReversalPattern(ids, next, {
      axis,
      placeTolM: liveGeom.positionAcross ? liveGeom.stackPitchM + 1e-3 : 1e-3,
      forwardAzimuthDeg: forwardDeg,
      reverseDelayS: gradientDelayS,
    });
  };

  // Suwak rozstawu: pierwszy ruch gestu bierze wpis undo, kolejne nie.
  const sliding = useRef(false);
  const slideSpacing = (v: number) => {
    applyLayout({ spacingM: v, history: !sliding.current });
    sliding.current = true;
  };
  const endSlide = () => {
    sliding.current = false;
  };

  // "Stacked" here means more than one cabinet AT A POSITION, which is a
  // different thing from `view.vertical` (a column laid out along Z). It is what
  // turns the Z field into a face and puts the mount and the reversal on offer.
  const stacked = view.perPosition > 1;
  // Rząd jest wysoki na JEDNĄ obudowę, choćby stało ich osiemnaście. Mnożenie
  // przez liczbę obudów opisywało rząd jako wieżę 9.9 m i tak właśnie wyglądał
  // odczyt „−4.28 m do 5.62 m” pod rigiem, który stoi na podeście.
  const stackSpanM =
    view.acrossM > 0 ? view.cabinetHeightM : view.perPosition * view.stackPitchM;

  const relDelayMs = (group?.delayOffsetS ?? 0) * MS;
  const setRelDelay = (ms: number) => {
    const gid = group?.id ?? s.ensureGroup(ids, 'SUB ARRAY');
    if (gid) s.patchGroup(gid, { delayOffsetS: ms / MS });
  };

  const setBeamWidth = (v: number) => dispatch({ type: 'setBeamWidth', deg: v });

  return (
    <section className="panel steer-panel grow">
      <header className="panel-head">
        {t('subs.title')}
        <select
          className="module-select"
          value={group?.id ?? ''}
          onChange={(e) => s.selectGroup(e.target.value || null)}
          title={t('subs.moduleHint')}
        >
          <option value="">{t('subs.allSources', { count: s.sources.length })}</option>
          {s.groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} ({s.sources.filter((x) => x.groupId === g.id).length})
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button
          className="panel-head-btn subs-new-array"
          title={t('subs.newArrayHint')}
          onClick={() =>
            s.createSubArray({
              speakerId: m.speakerId || members[0]?.speakerId || speakers[0]?.id || '',
              // "another one like this" is the predictable default; with nothing
              // on the canvas yet, a plain 4-wide line to start from.
              count: members.length || 4,
              spacingM: view.spacing || 1.5,
              axis,
            })
          }
        >
          {t('subs.newArray')}
        </button>
        <button className="panel-head-btn" aria-label={t('ui.close')} onClick={() => s.toggle('showSteering')}>
          <Icon name="close" />
        </button>
      </header>

      {!ids.length ? (
        <p className="empty-hint small">{t('subs.empty')}</p>
      ) : (
        <div className="steer-scroll">
          <div className="steer-grid">
            <section>
              {/* Kolejność wierszy: najpierw CZYM jest moduł, potem JAK stoi obudowa,
                  potem GDZIE stoi rig i jak jest rozstawiony, na końcu delay.
                  Wyrównanie etykiet bierze się z jednego toru w index.css,
                  nie z tego, jak wiersze są tu pogrupowane — dlatego wiersze
                  zostają osobnymi elementami i widać przy nich warunki. */}

              {/* ── czym jest moduł ──────────────────────────────────────── */}
              <div className="steer-row">
                <label title={t('subs.system')}>{t('subs.system')}</label>
                {/* Lista bierze linię od kolumny 2: „L-Acoustics KS28” nie
                    mieści się w połowie linii przy żadnej szerokości panelu
                    z drabinki, a producent i model są tym, po czym się
                    obudowę poznaje. */}
                <select
                  className="text-input wide"
                  value={m.speakerId || members[0]?.speakerId || ''}
                  onChange={(e) => dispatch({ type: 'setSpeaker', id: e.target.value })}
                >
                  {speakers.map((sp) => (
                    <option key={sp.id} value={sp.id}>
                      {sp.manufacturer} {sp.model}
                    </option>
                  ))}
                </select>
              </div>

              {/* Dwie liczby, które mówią, z czego moduł jest zbudowany.
                  W oryginale druga z nich jest kolumną „No.” w tabeli
                  pozycji; tu jest jedną liczbą na cały moduł. */}
              <div className="steer-row">
                <label title={t('subs.positions')}>{t('subs.positions')}</label>
                {/* Złożona komórka: licznik i przełącznik żywego sterowania
                    dzielą jedno pole siatki.
                    Dokładnie JEDEN input w komórce — testy sięgają po pole
                    jako pierwszy input w rodzeństwie etykiety. */}
                <span className="steer-cell">
                  <NumField
                    label={t('subs.positions')}
                    value={view.count}
                    onChange={(v) => dispatch({ type: 'setCount', count: v })}
                    step={1}
                    min={1}
                    max={128}
                  />
                  <button
                    className={`live-btn${m.live ? ' on' : ''}`}
                    onClick={() => dispatch({ type: 'toggleLive' })}
                    title={m.live ? t('subs.liveOn') : t('subs.liveOff')}
                  >
                    Live
                  </button>
                </span>
                {view.canStack && (
                  <>
                    <label title={t('subs.perPositionHint')}>{t('subs.perPosition')}</label>
                    <NumField
                      label={t('subs.perPosition')}
                      value={view.perPosition}
                      onChange={(v) => dispatch({ type: 'setPerPosition', count: v })}
                      step={1}
                      min={1}
                      max={16}
                    />
                  </>
                )}
              </div>

              {/* ── jak stoi obudowa ─────────────────────────────────────── */}
              {canRoll && (
                <div className="steer-row">
                  <label title={t('subs.orientationHint')}>{t('subs.orientation')}</label>
                  <div className="seg small wide">
                    {ORIENTATIONS.map((deg) => (
                      <button
                        key={deg}
                        className={orientationOf(view.roll) === deg ? 'on' : ''}
                        onClick={() => dispatch({ type: 'setGeom', field: 'roll', value: deg })}
                      >
                        {t(deg === 0 ? 'subs.orientUpright' : 'subs.orientOnEnd')}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Jeden montaż, nie dwa. Dotąd ten przełącznik był renderowany
                  w dwóch miejscach — raz przy orientacji dla stosu poziomego,
                  raz w gałęzi kolumny pionowej — więc zmiana osi przenosiła go
                  o kilka wierszy. Gałęzie wykluczają się (oś Z nie pozwala na
                  więcej niż jedną obudowę na pozycję), więc jedno miejsce jest
                  zawsze poprawne. */}
              {(stacked || view.vertical) && (
                <div className="steer-row">
                  <label title={t('subs.mounting')}>{t('subs.mounting')}</label>
                  <div className="seg small wide">
                    {(['stacked', 'flying'] as const).map((k) => (
                      <button
                        key={k}
                        className={view.mount === k ? 'on' : ''}
                        onClick={() => dispatch({ type: 'setMount', mount: k })}
                      >
                        {t(k === 'flying' ? 'subs.mountFlying' : 'subs.mountStacked')}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Która DOKŁADNIE obudowa jest odwrócona. Opisuje stos, a nie
                  pozycję. Bloki KS28 zawierają F B F
                  i F F B F, czyli odwróconą obudowę w ŚRODKU. */}
              {view.canReverse && view.perPosition > 1 && (
                <div className="steer-row">
                  <label title={t('subs.reversePatternHint')}>{t('subs.reversePattern')}</label>
                  <div className="rev-pattern wide">
                    {view.reversePattern.map((back, i) => {
                      // Ostatnie F w pozycji jest zablokowane JAWNIE: same B to
                      // nie kardioida, tylko cały rig obrócony tyłem. Dotąd
                      // klik w nie po prostu nic nie robił.
                      const lastFront =
                        !back && view.reversePattern.filter((v) => !v).length === 1;
                      return (
                        <button
                          key={i}
                          className={back ? 'on' : ''}
                          disabled={lastFront}
                          title={
                            lastFront
                              ? t('subs.revLastFront')
                              : t(back ? 'subs.revBack' : 'subs.revFront', { n: i + 1 })
                          }
                          onClick={() => togglePattern(i)}
                        >
                          {t(back ? 'subs.revB' : 'subs.revF')}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="steer-gap" />

              {/* ── gdzie stoi rig ───────────────────────────────────────── */}
              <div className="steer-row">
                <label
                  title={
                    stacked
                      ? t(view.mount === 'flying' ? 'subs.stackRigHint' : 'subs.stackDeckHint')
                      : t('subs.position', { axis: axisC.toUpperCase() })
                  }
                >
                  {stacked
                    ? t(view.mount === 'flying' ? 'subs.stackRigZ' : 'subs.stackDeckZ')
                    : t('subs.position', { axis: axisC.toUpperCase() })}
                </label>
                <NumField
                  label={stacked
                      ? t(view.mount === 'flying' ? 'subs.stackRigZ' : 'subs.stackDeckZ')
                      : t('subs.position', { axis: axisC.toUpperCase() })}
                  value={view.posC}
                  onChange={(v) => dispatch({ type: 'setGeom', field: 'posC', value: v })}
                  unit="m"
                  step={0.5}
                />
                <label title={t('subs.verticalAiming')}>{t('subs.verticalAiming')}</label>
                <NumField
                  label={t('subs.verticalAiming')}
                  value={view.elevation}
                  onChange={(v) => dispatch({ type: 'setGeom', field: 'elevation', value: v })}
                  unit="°"
                  step={1}
                  min={-90}
                  max={90}
                />
              </div>

              {/* Poziomo ten sam blok jest WYBOREM, nie faktem: suby wsuwa się
                  do siebie albo rozkłada, zależnie od podestu. */}
              {view.canTouch && !view.vertical && (
                <div className="steer-row">
                  <label title={t('subs.blockLayout')}>{t('subs.blockLayout')}</label>
                  <div className="seg small wide">
                    {(['overall', 'touching'] as const).map((k) => (
                      <button
                        key={k}
                        className={(k === 'touching') === view.touching ? 'on' : ''}
                        title={t(
                          k === 'touching' ? 'subs.layoutTouchingHint' : 'subs.layoutSpacedHint',
                        )}
                        onClick={() => dispatch({ type: 'setSpanMode', mode: k })}
                      >
                        {t(k === 'touching' ? 'subs.layoutTouching' : 'subs.layoutSpaced')}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Pierwszy slot się wymienia, ale nigdy nie znika: kolumna
                  pionowa nie ma czego rozstawiać — stoi obudowa na obudowie —
                  więc w to samo miejsce wchodzi wysokość, na której się ją
                  stawia albo wiesza. To INNA współrzędna niż „Pozycja Z” wyżej:
                  tamto jest położeniem na osi poprzecznej, to jest ścianą, od
                  której liczy się kolumnę. */}
              <div className="steer-row">
                {view.vertical ? (
                  <>
                    <label
                      title={t(
                        view.mount === 'flying' ? 'subs.stackRigHint' : 'subs.stackDeckHint',
                      )}
                    >
                      {t(view.mount === 'flying' ? 'subs.stackRigZ' : 'subs.stackDeckZ')}
                    </label>
                    <NumField
                      label={t(view.mount === 'flying' ? 'subs.stackRigZ' : 'subs.stackDeckZ')}
                      value={view.refZ}
                      onChange={(v) => dispatch({ type: 'setRefZ', metres: v })}
                      unit="m"
                      step={0.1}
                    />
                  </>
                ) : (
                  <>
                    <label title={t('subs.spacedAlongHint')}>{t('subs.spacedAlong')}</label>
                    <NumField
                      label={t('subs.spacedAlong')}
                      value={view.overall}
                      onChange={(v) => dispatch({ type: 'setOverall', metres: v })}
                      unit="m"
                      step={0.5}
                      disabled={!view.canDeriveSpacing}
                    />
                  </>
                )}
                <label title={t('subs.at', { axis: axisB.toUpperCase() })}>
                  {t('subs.at', { axis: axisB.toUpperCase() })}
                </label>
                <NumField
                  label={t('subs.at', { axis: axisB.toUpperCase() })}
                  value={view.posB}
                  onChange={(v) => dispatch({ type: 'setGeom', field: 'posB', value: v })}
                  unit="m"
                  step={0.5}
                />
              </div>

              <div className="steer-row">
                <label
                  title={
                    view.vertical
                      ? t('subs.stackPitch')
                      : view.touching
                        ? t('subs.layoutTouchingHint')
                        : t('subs.spacing')
                  }
                >
                  {t('subs.spacing')}
                </label>
                <NumField
                  label={t('subs.spacing')}
                  value={view.spacing}
                  onChange={(v) => dispatch({ type: 'setSpacing', metres: v })}
                  unit="m"
                  step={0.05}
                  disabled={view.touching}
                />
                {/* Ta etykieta przycina się we wszystkich trzech językach.
                    Dlatego `title`: przycięcie ma
                    być do odczytania, a nie do zgadnięcia. */}
                <label title={t('subs.patternLimitHint')}>{t('subs.patternLimit')}</label>
                <span className="readout-box mono">
                  {limitHz == null ? '--' : `${limitHz.toFixed(0)} Hz`}
                </span>
              </div>

              {/* Rozstaw NA ŻYWO: suwak pisze geometrię przy każdym ruchu,
                  bez czekania na „Zastosuj rozstaw”. Jeden gest to jeden wpis
                  undo — flaga trzyma się od pierwszego ruchu do puszczenia —
                  bo cofnięcie przeciągnięcia ma wracać tam, skąd się ruszyło,
                  a nie piksel po pikselu. Zakres 0.5–10 m obudowa od obudowy. */}
              {!view.vertical && (
                <div className="steer-row">
                  <input
                    className="slider wide"
                    type="range"
                    min={0.5}
                    max={10}
                    step={0.05}
                    value={Math.min(10, Math.max(0.5, view.spacing))}
                    aria-label={t('subs.spacing')}
                    title={t('subs.spacing')}
                    disabled={view.touching || !view.canRebuild}
                    onChange={(e) => slideSpacing(parseFloat(e.target.value))}
                    onPointerDown={holdDraft}
                    onPointerUp={endSlide}
                    onKeyUp={endSlide}
                    onBlur={endSlide}
                  />
                </div>
              )}

              {/* Przycisk nie dzieli komórki z odczytem. Zmierzone: odczyt 64 px + „Zastosuj rozstaw” 110 px
                  to 178 px, a tor kontrolki ma 102 px przy domyślnych 438 px
                  panelu — i nie da się tego naprawić zwężeniem etykiet, bo
                  dwie komórki po 178 px nie zmieszczą się w linii przy
                  żadnej etykiecie szerszej od 15 px. Przy prawej krawędzi linii,
                  pod swoimi liczbami, da się go przeczytać w całości. */}
              <div className="steer-strip act">
                <span className="spacer" />
                <button
                  className="primary"
                  onClick={() => applyLayout()}
                  disabled={!view.canRebuild}
                  title={view.canRebuild ? undefined : t('subs.cannotRebuild')}
                >
                  {t('subs.applyLayout')}
                </button>
              </div>

              {/* ── co z tego wychodzi ───────────────────────────────────────
                  Pięć osobnych wierszy odczytów to pięć linii, z których na
                  raz mówi zwykle jedna albo dwie. Jeden zawijany pasek mówi
                  tyle samo w dwóch. Ostrzeżenia idą pierwsze i trzymają swój
                  kolor: rig, którego nie da się przebudować, nie może czytać
                  się jak przypis do wymiarów. */}
              <div className="steer-notes mono">
                {!view.canRebuild && <span className="warn">{t('subs.cannotRebuild')}</span>}
                {/* Pomyłka w rozstawie ma prawo zsunąć pozycje — scalić ich
                    nie wolno, więc zamiast scalenia jest to ostrzeżenie. */}
                {view.count > 1 && view.posW > 0 && view.spacing < view.posW - 1e-3 && (
                  <span className="warn">
                    {t('subs.posOverlap', {
                      spacing: view.spacing.toFixed(2),
                      width: view.posW.toFixed(2),
                    })}
                  </span>
                )}
                {stacked && !view.canReverse && view.reverseAt === 'none' && (
                  <span className="warn">{t('subs.reverseNoDepth')}</span>
                )}
                {/* Obracanie kierunkowej obudowy we własnym rigu walczy z
                    charakterystyką, z którą przyszła, a sufit niżej opisuje
                    dwie grupy dookólne — więc tam nic nie mówi. */}
                {view.reversingACardioid && (
                  <span className="warn">{t('subs.reverseCardioid')}</span>
                )}
                {/* Jedyna liczba, która nie pozwala wysłać stosu 3 + 1 jako
                    kardioidy. To SUFIT ustawiony przez liczności; rig tylko
                    się do niego zbliża, i to od dołu. */}
                {view.reverseAt !== 'none' && view.rejectionCeilingDb !== undefined && (
                  <span>
                    {view.rejectionCeilingDb === null
                      ? t('subs.gradientMatched', {
                          forward: view.forwardCount,
                          reversed: view.reverseCount,
                        })
                      : t('subs.gradientCeiling', {
                          forward: view.forwardCount,
                          reversed: view.reverseCount,
                          db: view.rejectionCeilingDb.toFixed(1),
                        })}
                  </span>
                )}
                <span>
                  {view.vertical
                    ? t('subs.stackReadout', {
                        count: view.count,
                        pitch: view.spacing.toFixed(3),
                        height: (view.stackTopM - view.stackBottomM).toFixed(2),
                        bottom: view.stackBottomM.toFixed(2),
                        top: view.stackTopM.toFixed(2),
                      })
                    : axis === 'z'
                      ? t('subs.stackNoHeight')
                      : view.cabinetWidthM > 0
                        ? stacked
                          ? t('subs.gridReadout', {
                              positions: view.count,
                              per: view.perPosition,
                              cabinets: view.cabinets,
                              overall: view.overall.toFixed(2),
                              bottom: (view.stackCentreZ - stackSpanM / 2).toFixed(2),
                              top: (view.stackCentreZ + stackSpanM / 2).toFixed(2),
                            })
                          : t('subs.footprint', {
                              overall: view.overall.toFixed(2),
                              cabinet: view.cabinetWidthM.toFixed(2),
                              gap: (view.spacing - view.cabinetWidthM).toFixed(2),
                            })
                        : t('subs.footprintUnknown')}
                </span>
              </div>

              <div className="steer-gap" />

              {/* ── delay ────────────────────────────────────────────────── */}
              <div className="steer-row">
                <label title={t('subs.relDelay')}>{t('subs.relDelay')}</label>
                <span className="steer-cell">
                  <NumField label={t('subs.relDelay')} value={relDelayMs} onChange={setRelDelay} unit="ms" step={0.1} />
                  <span className="nudge">
                    <button onClick={() => setRelDelay(relDelayMs - 0.1)}>−</button>
                    <button onClick={() => setRelDelay(relDelayMs + 0.1)}>+</button>
                  </span>
                </span>
                <label title={t('subs.dispersionHint')}>{t('subs.dispersion')}</label>
                <NumField
                  label={t('subs.dispersion')}
                  value={m.dispersionDeg}
                  onChange={setBeamWidth}
                  unit="°"
                  step={5}
                  min={0}
                  max={180}
                />
              </div>

              <div className="steer-row">
                <input
                  className="slider span-a"
                  type="range"
                  min={0}
                  max={180}
                  step={1}
                  aria-label={t('subs.dispersion')}
                  value={m.dispersionDeg}
                  onChange={(e) => setBeamWidth(parseFloat(e.target.value))}
                  onPointerDown={holdDraft}
                />
                <span className="steer-readout span-b mono">
                  {m.mode === 'dispersion'
                    ? isFinite(focusR)
                      ? t('subs.focusBehind', { r: focusR.toFixed(2) })
                      : t('subs.focusInfinite')
                    : t(MODE_KEY[m.mode])}
                  {' · '}
                  {t('subs.taper', { ms: (plan.maxDelayS * MS).toFixed(2) })}
                </span>
              </div>

              <div className="steer-strip act">
                <span className="spacer" />
                <button
                  className="primary"
                  onClick={() => {
                    // An explicit apply is also a statement that live steering
                    // may take over from here.
                    dispatch({ type: 'armed' });
                    applyDelay();
                  }}
                >
                  {t('subs.applyDelay')}
                </button>
              </div>

              {/* Pasek, nie para etykieta/kontrolka: tu nie ma czego wyrównywać,
                  a „Reset poziomów + delayów” ma 159 px i w torze 1fr zawsze by
                  się przycinał. Etykieta i tak stoi w tej samej kolumnie co
                  wyżej, bo bierze ten sam token. */}
              <div className="steer-strip">
                <label>{t('subs.cabinetSetup')}</label>
                <button
                  onClick={() =>
                    // Gradient zostaje: ten reset zdejmuje taper i poziomy,
                    // nie rozbiera kardioidy. Patrz resetModule.
                    s.resetModule(ids, false, {
                      reverseDelayS: gradientDelayS,
                      forwardAzimuthDeg: forwardDeg,
                    })
                  }
                >
                  {t('subs.resetLevelDelay')}
                </button>
                <button
                  onClick={() => {
                    s.resetModule(ids, true);
                    // "Wszystkiego" obejmuje też wspólny offset modułu —
                    // inaczej po pełnym resecie rig dalej niósł Delay (wzgl.),
                    // którego żadne pole już nie tłumaczyło.
                    if (group) s.patchGroup(group.id, { delayOffsetS: 0 }, false);
                  }}
                >
                  {t('subs.resetAll')}
                </button>
                <span className="spacer" />
                <button className={more ? 'on' : ''} onClick={() => setMore((v) => !v)}>
                  <Icon name="chevron" className={more ? '' : 'twisty-closed'} /> {t('subs.more')}
                </button>
              </div>
            </section>

            {more && (
              <section>
                <h4>{t('subs.more')}</h4>
                <div className="steer-row">
                  <label title={t('subs.mode')}>{t('subs.mode')}</label>
                  <select
                    className="text-input"
                    value={m.mode}
                    onChange={(e) => dispatch({ type: 'setMode', mode: e.target.value as SteerMode })}
                  >
                    {MODES.map((k) => (
                      <option key={k} value={k}>
                        {t(MODE_KEY[k])}
                      </option>
                    ))}
                  </select>
                  <label title={t('subs.layoutAxis')}>{t('subs.layoutAxis')}</label>
                  <div className="seg small">
                    {(['x', 'y', 'z'] as const).map((a) => (
                      <button key={a} className={axis === a ? 'on' : ''} onClick={() => dispatch({ type: 'setAxis', axis: a })}>
                        {a.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>

                {(m.mode === 'steer' || m.mode === 'dispersion') && (
                  <div className="steer-row">
                    <label title={t('subs.aimOffAxis')}>{t('subs.aimOffAxis')}</label>
                    <NumField
                      label={t('subs.aimOffAxis')}
                      value={m.steerDeg}
                      onChange={(v) => dispatch({ type: 'setSteer', deg: v })}
                      unit="°"
                      step={5}
                      min={-90}
                      max={90}
                    />
                    <input
                      className="slider"
                      type="range"
                      min={-90}
                      max={90}
                      step={1}
                      aria-label={t('subs.aimOffAxis')}
                      value={m.steerDeg}
                      onChange={(e) => dispatch({ type: 'setSteer', deg: parseFloat(e.target.value) })}
                      onPointerDown={holdDraft}
                    />
                  </div>
                )}

                {view.canAnchor && (
                  <div className="steer-row">
                    <label title={t('subs.anchorHint')}>{t('subs.anchor')}</label>
                    {/* Trzy nazwy końców, nie dwie — w parze obok drugiego pola
                        zostaje z nich „L… Śr… Pr…”, czyli nic. */}
                    <div className="seg small wide">
                      {ANCHORS.map((k) => (
                        <button
                          key={k}
                          className={view.anchor === k ? 'on' : ''}
                          title={t('subs.anchorHint')}
                          onClick={() => dispatch({ type: 'setAnchor', anchor: k })}
                        >
                          {t(anchorLabel(k, axis))}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="steer-row">
                  <label title={t('subs.splay')}>{t('subs.splay')}</label>
                  <NumField
                    label={t('subs.splay')}
                    value={view.splay}
                    onChange={(v) => dispatch({ type: 'setGeom', field: 'splay', value: v })}
                    unit="°"
                    step={5}
                    min={-180}
                    max={180}
                  />
                  <label
                    title={
                      view.vertical
                        ? t(view.mount === 'flying' ? 'subs.stackRigHint' : 'subs.stackDeckHint')
                        : t('subs.anchorHint')
                    }
                  >
                    {t(anchoredPositionKey(view.anchor, axis), { axis: axis.toUpperCase() })}
                  </label>
                  <NumField
                    label={t(anchoredPositionKey(view.anchor, axis), { axis: axis.toUpperCase() })}
                    value={view.vertical ? view.centre : view.refA}
                    onChange={(v) => dispatch({ type: 'setRefA', metres: v })}
                    unit="m"
                    step={0.5}
                    // A stack is placed by a face, so its centre is a consequence.
                    // Two live controls for one number would fight each other.
                    disabled={view.vertical}
                  />
                </div>

                {/* The tool is the column's height turned into an angle, so an
                    unconfirmed cabinet height means there is no tool to offer —
                    the same answer the stack controls give one row above, where
                    the readout is already saying the height is unknown. It used
                    to substitute 0.6 m and aim a rig off a box nobody measured.

                    `steerDegForDownTilt` is the seam: the tool speaks in
                    down-tilt, the steering field in "toward +axis", and along Z
                    that is up. */}
                {(m.mode === 'steer' || m.mode === 'dispersion') &&
                  axis === 'z' &&
                  view.cabinetHeightM > 0 && (
                    <TiltFromGeometry
                      members={view.count}
                      cabinetHeightM={view.cabinetHeightM}
                      onTilt={(deg) => dispatch({ type: 'setSteer', deg: steerDegForDownTilt(deg) })}
                    />
                  )}

                {m.mode === 'endfire' && (
                  <div className="steer-row">
                    <span className="steer-readout mono">
                      {t('subs.endfireHint', {
                        m: endFireSpacingFor(s.sim.frequencyHz, c).toFixed(2),
                        hz: s.sim.frequencyHz.toFixed(0),
                      })}
                    </span>
                    <button
                      onClick={() =>
                        dispatch({
                          type: 'setSpacing',
                          metres: endFireSpacingFor(s.sim.frequencyHz, c),
                        })
                      }
                    >
                      {t('subs.useIt')}
                    </button>
                  </div>
                )}

                {m.mode !== 'endfire' && (
                  <div className="steer-row">
                    <label title={t('subs.edgeTaperHint')}>{t('subs.edgeTaper')}</label>
                    <NumField
                      label={t('subs.edgeTaper')}
                      value={m.taperDb ?? 0}
                      onChange={(v) => dispatch({ type: 'setTaper', db: v })}
                      unit="dB"
                      step={1}
                      min={-24}
                      max={0}
                    />
                    <span className="steer-readout">{t('subs.edgeTaperHint')}</span>
                  </div>
                )}
              </section>
            )}
          </div>

          <SourceTable ids={ids} group={group} />
        </div>
      )}
    </section>
  );
}

/**
 * Down-tilt for a flown column, worked out from the rig geometry instead of
 * guessed: aim the array's acoustic centre at the far listener.
 */
function TiltFromGeometry({
  members,
  cabinetHeightM,
  onTilt,
}: {
  members: number;
  cabinetHeightM: number;
  onTilt: (deg: number) => void;
}) {
  const t = useT();
  const [topM, setTopM] = useState(9);
  const [distanceM, setDistanceM] = useState(30);
  const [targetM, setTargetM] = useState(1.6);

  const tilt = tiltAngleFromGeometry({
    arrayTopM: topM,
    cabinetHeightM,
    count: members,
    distanceM,
    targetHeightM: targetM,
  });

  return (
    <div className="steer-sub">
      <div className="steer-row">
        <label title={t('subs.arrayTop')}>{t('subs.arrayTop')}</label>
        <NumField label={t('subs.arrayTop')} value={topM} onChange={setTopM} unit="m" step={0.5} />
        <label title={t('subs.distance')}>{t('subs.distance')}</label>
        <NumField label={t('subs.distance')} value={distanceM} onChange={setDistanceM} unit="m" step={1} />
        <label title={t('subs.targetHeight')}>{t('subs.targetHeight')}</label>
        <NumField label={t('subs.targetHeight')} value={targetM} onChange={setTargetM} unit="m" step={0.1} />
      </div>
      <div className="steer-row">
        <span className="steer-readout mono">
          {t('subs.tiltReadout', {
            centre: (topM - (cabinetHeightM * members) / 2).toFixed(2),
            tilt: tilt.toFixed(2),
          })}
        </span>
        <button onClick={() => onTilt(tilt)}>{t('subs.useAsAim')}</button>
      </div>
    </div>
  );
}
