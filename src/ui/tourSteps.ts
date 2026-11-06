/**
 * The steps of the guided tour. The Help window reads the same text, so the two
 * cannot come to describe the program differently. Control names are filled in
 * from the interface's own strings, so a renamed button renames itself here.
 */
import { BRANDING } from '../branding';
import type { MessageKey, Vars } from '../i18n';

type T = (key: MessageKey, vars?: Vars) => string;

export interface TourStep {
  id: string;
  title: MessageKey;
  body: MessageKey;
  /** what to light: a selector, or nothing for a card in the middle of the window */
  target?: string;
  /** the panels this step needs open */
  panels?: { showSteering: boolean; showGroups: boolean };
  /** this step and the ones after it need cabinets on screen: see Tutorial */
  example?: boolean;
  /** select the example's group, so its controls are in view */
  selectGroup?: boolean;
  /** whether Help lists this step as a topic */
  topic: boolean;
}

export const TOUR_STEPS: TourStep[] = [
  { id: 'welcome', title: 'tour.welcome.title', body: 'tour.welcome.body', topic: false },
  {
    id: 'create',
    title: 'tour.create.title',
    body: 'tour.create.body',
    target: '.subs-new-array',
    panels: { showSteering: true, showGroups: false },
    topic: true,
  },
  {
    id: 'edit',
    title: 'tour.edit.title',
    body: 'tour.edit.body',
    target: '.steer-panel',
    panels: { showSteering: true, showGroups: false },
    example: true,
    topic: true,
  },
  {
    id: 'canvas',
    title: 'tour.canvas.title',
    body: 'tour.canvas.body',
    target: '.plot',
    panels: { showSteering: false, showGroups: false },
    topic: true,
  },
  {
    id: 'groups',
    title: 'tour.groups.title',
    body: 'tour.groups.body',
    target: '.group-panel',
    panels: { showSteering: false, showGroups: true },
    selectGroup: true,
    topic: true,
  },
  {
    id: 'render',
    title: 'tour.render.title',
    body: 'tour.render.body',
    target: '.right-col',
    panels: { showSteering: false, showGroups: false },
    topic: true,
  },
  {
    id: 'output',
    title: 'tour.output.title',
    body: 'tour.output.body',
    target: '.tb-file',
    topic: true,
  },
  { id: 'help', title: 'tour.help.title', body: 'tour.help.body', target: '.tb-help', topic: false },
];

/** The names of the controls the texts refer to. */
function labels(t: T): Vars {
  return {
    product: BRANDING.productName,
    array: t('tb.array'),
    newArray: t('subs.newArray'),
    system: t('subs.system'),
    add: t('src.add'),
    sources: t('src.title'),
    positions: t('subs.positions'),
    perPosition: t('subs.perPosition'),
    spacing: t('subs.spacing'),
    applyLayout: t('subs.applyLayout'),
    pattern: t('subs.reversePattern'),
    dispersion: t('subs.dispersion'),
    more: t('subs.more'),
    group: t('src.group'),
    groups: t('tb.groups'),
    colour: t('right.colour'),
    signal: t('right.signal'),
    calc: t('right.splCalc'),
    auto: t('right.autocalculate'),
    area: t('area.title'),
    file: t('tb.file'),
    sheet: t('tb.delaySheet').replace(/…$/, ''),
    help: t('tb.help'),
  };
}

export const tourTitle = (step: TourStep, t: T) => t(step.title, labels(t));

/** One paragraph per entry. */
export const tourBody = (step: TourStep, t: T) => t(step.body, labels(t)).split('\n');
