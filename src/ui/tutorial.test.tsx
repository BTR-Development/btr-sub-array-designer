// @vitest-environment jsdom
/**
 * The guided tour and Help: the tour shows once and leaves the project and the
 * panels as they were, every step lights something that exists, and Help is
 * reachable the way the tour says it is.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { App } from './App';
import { TOUR_STEPS, tourBody, tourTitle } from './tourSteps';
import { useStore } from '../state/store';
import { markTutorialSeen, tutorialSeen } from '../state/tutorial';
import { EN, translate, type MessageKey } from '../i18n';

const st = () => useStore.getState();

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const ctx = new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === 'canvas') return undefined;
        if (key === 'measureText') return () => ({ width: 0 });
        if (key === 'getImageData' || key === 'createImageData') return () => ({ data: new Uint8ClampedArray(4) });
        return () => undefined;
      },
      set: () => true,
    },
  );
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
});

beforeEach(() => {
  localStorage.clear();
  act(() => {
    st().newProject();
    useStore.setState({ tutorialOpen: false, showSteering: false, showGroups: false, lang: 'en', view3d: false });
  });
});
afterEach(cleanup);

const next = () => fireEvent.click(document.querySelector('.tour-next')!);

describe('the first run', () => {
  it('counts as seen only once the tour is finished or skipped', () => {
    expect(tutorialSeen()).toBe(false);
    act(() => st().setTutorialOpen(true));
    render(<App />);
    expect(tutorialSeen()).toBe(false);
    fireEvent.click(screen.getByText('Skip'));
    expect(tutorialSeen()).toBe(true);
    expect(st().tutorialOpen).toBe(false);
    expect(document.querySelector('.tour')).toBeNull();
  });

  it('remembers across runs', () => {
    markTutorialSeen();
    expect(tutorialSeen()).toBe(true);
  });
});

describe('the tour', () => {
  it('finds what every step points at', () => {
    act(() => st().setTutorialOpen(true));
    render(<App />);
    for (const step of TOUR_STEPS) {
      if (step.target) expect(document.querySelector(step.target), step.id).not.toBeNull();
      if (step !== TOUR_STEPS[TOUR_STEPS.length - 1]) next();
    }
  });

  it('walks to the end, gives the contact, and puts the panels and the project back', () => {
    act(() => st().addSource('la-ks28', { x: 0, y: 0, z: 0.3 }));
    const sources = st().sources;
    const history = st().undoStack.length;
    act(() => st().setTutorialOpen(true));
    render(<App />);
    for (let i = 1; i < TOUR_STEPS.length; i++) next();

    const card = document.querySelector('.tour-card') as HTMLElement;
    expect(card.textContent).toContain('F1');
    const mail = within(card).getByRole('link');
    expect(mail.getAttribute('href')).toBe('mailto:karol@btr-poland.com');
    expect(card.textContent).toContain('Karol Bernacki');

    next();
    expect(document.querySelector('.tour')).toBeNull();
    expect(st().showSteering).toBe(false);
    expect(st().showGroups).toBe(false);
    expect(st().sources).toBe(sources);
    expect(st().undoStack.length).toBe(history);
    expect(st().dirty).toBe(true); // from the cabinet above, not from the tour
  });

  it('shows an example on an empty project, and takes it out again with its history', () => {
    act(() => useStore.setState({ undoStack: [], redoStack: [], dirty: false }));
    act(() => st().setTutorialOpen(true));
    render(<App />);
    expect(st().sources).toHaveLength(0);
    next(); // create: the panel is empty, which is what it describes
    expect(st().sources).toHaveLength(0);
    next(); // edit: now there is something to edit
    expect(st().sources.length).toBeGreaterThan(0);
    expect(st().groups.length).toBeGreaterThan(0);
    // the controls the step talks about are on screen
    expect(document.querySelector('.steer-panel')!.textContent).toContain('No. of positions');
    next(); // canvas
    next(); // groups: the example group is selected, so its controls show
    expect(st().selectedGroupId).toBe(st().groups[0].id);
    expect(document.querySelector('.group-panel')!.textContent).toContain('Transform offset');

    fireEvent.click(screen.getByText('Skip'));
    expect(st().sources).toHaveLength(0);
    expect(st().groups).toHaveLength(0);
    expect(st().selectedGroupId).toBeNull();
    expect(st().undoStack).toHaveLength(0);
    expect(st().dirty).toBe(false);
  });

  it('leaves a project with cabinets alone: no example', () => {
    act(() => st().addSource('la-ks28', { x: 0, y: 0, z: 0.3 }));
    const sources = st().sources;
    act(() => st().setTutorialOpen(true));
    render(<App />);
    next();
    next();
    expect(st().sources).toBe(sources);
  });

  it('keeps the shortcuts of the project away while it is up', () => {
    act(() => st().addSource('la-ks28', { x: 0, y: 0, z: 0.3 }));
    act(() => st().setTutorialOpen(true));
    render(<App />);
    fireEvent.keyDown(window, { key: 'Backspace' });
    expect(st().sources).toHaveLength(1);
  });

  it('moves with the keyboard, and Escape leaves it', () => {
    act(() => st().setTutorialOpen(true));
    render(<App />);
    const count = () => document.querySelector('.tour-count')!.textContent;
    expect(count()).toBe(`1 of ${TOUR_STEPS.length}`);
    fireEvent.keyDown(document.querySelector('.tour')!, { key: 'ArrowRight' });
    expect(count()).toBe(`2 of ${TOUR_STEPS.length}`);
    fireEvent.keyDown(document.querySelector('.tour')!, { key: 'ArrowLeft' });
    expect(count()).toBe(`1 of ${TOUR_STEPS.length}`);
    fireEvent.keyDown(document.querySelector('.tour')!, { key: 'Escape' });
    expect(document.querySelector('.tour')).toBeNull();
    expect(tutorialSeen()).toBe(true);
  });

  it.each(['en', 'pl', 'it'] as const)('fills in every name in its %s text', (lang) => {
    const tr = (key: MessageKey, vars?: Parameters<typeof translate>[2]) => translate(lang, key, vars);
    for (const step of TOUR_STEPS) {
      expect(tourTitle(step, tr), step.id).not.toContain('{');
      expect(tourBody(step, tr).join(' '), step.id).not.toContain('{');
    }
  });

  it('has its text in all three languages', () => {
    // a missing translation falls back to the English text
    const keys = Object.keys(EN).filter((k) => /^(tour|help)\./.test(k)) as MessageKey[];
    for (const key of keys.filter((k) => k !== 'tour.step')) {
      expect(translate('pl', key), key).not.toBe(EN[key]);
      expect(translate('it', key), key).not.toBe(EN[key]);
    }
  });
});

describe('Help', () => {
  it('opens with F1 and from the top bar, gives the contact and restarts the tour', () => {
    render(<App />);
    fireEvent.keyDown(window, { key: 'F1' });
    const modal = () => document.querySelector('.modal') as HTMLElement;
    expect(within(modal()).getByRole('link').getAttribute('href')).toBe('mailto:karol@btr-poland.com');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('.modal')).toBeNull();

    fireEvent.click(document.querySelector('.tb-help')!);
    fireEvent.click(document.querySelector('.help-replay')!);
    expect(document.querySelector('.modal')).toBeNull();
    expect(st().tutorialOpen).toBe(true);
    expect(document.querySelector('.tour')).not.toBeNull();
  });
});
