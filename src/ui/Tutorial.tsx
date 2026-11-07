/**
 * The guided tour: a dimmed window with one control or panel lit, and a card
 * beside it. Raised by main.tsx on the first run ever and from Help on request.
 *
 * It explains and does not edit: the project comes out of it as it went in. Some
 * steps open a panel so that what they describe is on screen, and the panels go
 * back to how they were when the tour ends. On an empty project, which the first
 * run always is, the panels would have nothing to show, so the tour puts an
 * example array in for its duration and takes it out again, history included.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore, type AppState } from '../state/store';
import { OFFERED_SPEAKER_IDS } from '../speakers/library';
import { markTutorialSeen } from '../state/tutorial';
import { useT } from '../i18n/useT';
import { claimModal, FOCUSABLE } from './modals';
import { ContactLine } from './ContactLine';
import { TOUR_STEPS, tourBody, tourTitle } from './tourSteps';

const CARD_GAP = 14;
const EDGE = 12;
const SPOT_PAD = 4;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Beside the lit element where there is room, inside it when it fills the window, otherwise in the middle. */
function placeCard(target: Box | null, cardW: number, cardH: number): { left: number; top: number } {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const middle = { left: (W - cardW) / 2, top: (H - cardH) / 2 };
  if (!target) return middle;
  const clampX = (x: number) => Math.max(EDGE, Math.min(x, W - cardW - EDGE));
  const clampY = (y: number) => Math.max(EDGE, Math.min(y, H - cardH - EDGE));
  const right = target.left + target.width + CARD_GAP;
  if (right + cardW + EDGE <= W) return { left: right, top: clampY(target.top) };
  const left = target.left - CARD_GAP - cardW;
  if (left >= EDGE) return { left, top: clampY(target.top) };
  const below = target.top + target.height + CARD_GAP;
  if (below + cardH + EDGE <= H) return { left: clampX(target.left), top: below };
  const above = target.top - CARD_GAP - cardH;
  if (above >= EDGE) return { left: clampX(target.left), top: above };
  return { left: clampX(target.left + target.width - cardW - CARD_GAP), top: clampY(target.top + CARD_GAP) };
}

export function Tutorial() {
  const t = useT();
  const showSteering = useStore((s) => s.showSteering);
  const showGroups = useStore((s) => s.showGroups);
  const [index, setIndex] = useState(0);
  const [spot, setSpot] = useState<Box | null>(null);
  const [card, setCard] = useState<{ left: number; top: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  const step = TOUR_STEPS[index];
  const last = index === TOUR_STEPS.length - 1;

  // The panels as the user had them, to put back at the end.
  const panels = useRef({ showSteering, showGroups });

  // The project as it was before the example went in; null when none did.
  const beforeExample = useRef<Pick<
    AppState,
    'sources' | 'groups' | 'undoStack' | 'redoStack' | 'dirty' | 'selectedSourceIds' | 'selectedGroupId'
  > | null>(null);

  const finish = useCallback(() => {
    markTutorialSeen();
    useStore.setState({ ...panels.current, ...beforeExample.current, tutorialOpen: false });
  }, []);

  useEffect(() => claimModal(), []);

  // Open what this step talks about.
  useLayoutEffect(() => {
    const st = useStore.getState();
    if (step.example && !beforeExample.current && !st.sources.length) {
      const { sources, groups, undoStack, redoStack, dirty, selectedSourceIds, selectedGroupId } = st;
      beforeExample.current = { sources, groups, undoStack, redoStack, dirty, selectedSourceIds, selectedGroupId };
      st.createSubArray({ speakerId: OFFERED_SPEAKER_IDS[0], count: 4, spacingM: 2, axis: 'x' });
    }
    if (step.panels) useStore.setState(step.panels);
    if (beforeExample.current) {
      const example = useStore.getState().groups[0];
      useStore.getState().selectGroup(step.selectGroup && example ? example.id : null);
    }
  }, [step]);

  const measure = useCallback(() => {
    const el = step.target ? document.querySelector(step.target) : null;
    const r = el?.getBoundingClientRect();
    const box =
      r && r.width > 0
        ? { left: r.left - SPOT_PAD, top: r.top - SPOT_PAD, width: r.width + 2 * SPOT_PAD, height: r.height + 2 * SPOT_PAD }
        : null;
    setSpot(box);
    const c = cardRef.current?.getBoundingClientRect();
    setCard(placeCard(box, c?.width ?? 380, c?.height ?? 260));
  }, [step]);

  // Once now, and once more when the columns have settled around an opened panel.
  useLayoutEffect(() => {
    measure();
    const again = setTimeout(measure, 60);
    window.addEventListener('resize', measure);
    return () => {
      clearTimeout(again);
      window.removeEventListener('resize', measure);
    };
  }, [measure, showSteering, showGroups]);

  useEffect(() => {
    nextRef.current?.focus();
  }, [index]);

  const go = useCallback(
    (delta: number) => setIndex((i) => Math.max(0, Math.min(TOUR_STEPS.length - 1, i + delta))),
    [],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      finish();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (!last) go(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(-1);
    } else if (e.key === 'Tab') {
      // the focus stays on the card: everything behind it is dimmed on purpose
      const stops = Array.from(cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (!stops.length) return;
      const at = stops.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      stops[(at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
    }
  };

  const title = tourTitle(step, t);
  return (
    <div className="tour" onKeyDown={onKeyDown}>
      {/* Takes the clicks, and carries the dimming when nothing is lit. */}
      <div className={`tour-blocker${spot ? '' : ' dim'}`} />
      {spot && <div className="tour-spot" style={spot} />}
      <div
        ref={cardRef}
        className="tour-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={card ?? { visibility: 'hidden' }}
      >
        <h2>{title}</h2>
        {tourBody(step, t).map((line) => (
          <p key={line}>{line}</p>
        ))}
        {last && <ContactLine />}
        <div className="tour-foot">
          <span className="tour-count">{t('tour.step', { n: index + 1, total: TOUR_STEPS.length })}</span>
          <span className="spacer" />
          {!last && (
            <button className="tour-skip" onClick={finish}>
              {t('tour.skip')}
            </button>
          )}
          {index > 0 && <button onClick={() => go(-1)}>{t('tour.back')}</button>}
          <button ref={nextRef} className="primary tour-next" onClick={last ? finish : () => go(1)}>
            {last ? t('tour.done') : t('tour.next')}
          </button>
        </div>
      </div>
    </div>
  );
}
