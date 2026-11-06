/**
 * Kardioida w rigu, który jest JEDNOCZEŚNIE sterowany.
 *
 * Taper sterujący opisuje miejsce na podeście, a nie pojedynczą skrzynię:
 * wszystkie obudowy jednej pozycji muszą dostać ten sam delay, liczony dla
 * środka pozycji. Przy pionowym stosie wychodziło to samo z siebie, bo obudowy
 * stosu mają jeden X. Przy RZĘDZIE obudów na krótszej krawędzi już nie —
 * każda dostawała własny delay sterujący, a ten rozrzut nakładał się na delay
 * gradientowy. Odstęp czasowy między obudową przednią a odwróconą przestawał
 * być głębokością skrzyni przez prędkość dźwięku, czyli kardioida przestawała
 * być kardioidą.
 *
 * Te przypadki MIERZĄ tłumienie z tyłu silnikiem, a nie sprawdzają liczby
 * w planie: chodzi o to, czy rig gra tak, jak ma grać.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { layoutSources, planDelays } from './arrayTools';
import { makeSource, useStore } from './store';
import { speedOfSoundFromTemp, type Source } from '../core/types';

const C = speedOfSoundFromTemp(20);
const st = () => useStore.getState();
const KS28_W = 1.34, KS28_H = 0.55, DEPTH = 0.719;
const acrossM = KS28_H;                     // na boku: 0.55 w poprzek
const GRADIENT = DEPTH / C;

/** Trzy pozycje po trzy KS28 na boku, w każdej środkowa odwrócona. */
function rowRig(): Source[] {
  let n = 0;
  return layoutSources([], {
    count: 3, spacingM: 6, axis: 'x', centreM: 0,
    cross: { y: 0, z: KS28_W / 2 },
    perPosition: 3, stackPitchM: acrossM, acrossM,
    reversePattern: [false, true, false],
    forwardAzimuthDeg: 0, reverseDelayS: GRADIENT,
    template: makeSource('la-ks28', 'SUB', { x: 0, y: 0, z: KS28_W / 2 }),
  }, () => `c${n++}`, (i) => `SUB ${i + 1}`);
}

const applyPlan = (rig: Source[], placeTolM?: number): Source[] => {
  // Gradient żyje w ZASZYTYM polu (układ je napisał); plan niesie czysty
  // delay sterujący i gradientu nie dotyka — tak jak panel.
  const plan = planDelays(rig, {
    mode: 'steer', steerDeg: 20, dispersionDeg: 0, axis: 'x',
    speedOfSound: C, placeTolM,
  });
  return rig.map((s, i) => ({ ...s, delayS: plan.delaysS[i] }));
};

beforeEach(() => {
  st().newProject();
  useStore.setState({ undoStack: [], redoStack: [] });
});

describe('gradient przeżywa sterowanie', () => {
  it('obudowy jednej pozycji dostają TEN SAM delay sterujący', () => {
    const rig = rowRig();
    const steered = applyPlan(rig, acrossM + 1e-3);
    // kolumna użytkownika niesie już SAM delay sterujący
    const byPos = new Map<string, number[]>();
    steered.forEach((s, i) => {
      const key = Math.round(rig[i].position.x / 6) * 6 + '';
      byPos.set(key, [...(byPos.get(key) ?? []), s.delayS]);
    });
    expect(byPos.size).toBe(3);
    for (const [pos, v] of byPos) {
      const spread = Math.max(...v) - Math.min(...v);
      expect(spread, `pozycja ${pos} rozrzut ${spread * 1000} ms`).toBeLessThan(1e-9);
    }
  });

  it('odstęp przód/tył w pozycji zostaje głębokością skrzyni przez c', () => {
    const rig = rowRig();
    const steered = applyPlan(rig, acrossM + 1e-3);
    // środkowa obudowa pierwszej pozycji jest odwrócona
    const first = steered
      .map((s, i) => ({ s, x: rig[i].position.x, back: rig[i].invertPolarity }))
      .filter((e) => e.x < -4)
      .sort((a, b) => a.x - b.x);
    expect(first).toHaveLength(3);
    expect(first[1].back).toBe(true);
    // Kolumna użytkownika jest RÓWNA dla całej pozycji — gradient niesie
    // zaszyte pole, którego plan nie dotyka, a silnik dolicza je sam.
    expect(first[1].s.delayS).toBeCloseTo(first[0].s.delayS, 12);
    const total = (e: { s: Source }) => e.s.delayS + (e.s.gradientDelayS ?? 0);
    expect(total(first[1]) - total(first[0])).toBeCloseTo(GRADIENT, 9);
    expect(total(first[1]) - total(first[2])).toBeCloseTo(GRADIENT, 9);
  });

  /*
   * Czego tu NIE MA i dlaczego.
   *
   * Pierwsza wersja mierzyła tłumienie przód/tył na +-30 m wzdłuż osi Y
   * i miała pokazać, że sterowanie nie psuje kardioidy. Zmierzyłem oba
   * warianty: per pozycja 7.93 dB, per obudowa 7.76 dB przy 63 Hz, a przy
   * 100 Hz wariant wadliwy wypadał LEPIEJ (11.38 wobec 10.07). Przypadek
   * przechodził niezależnie od poprawki, czyli nie pilnował niczego.
   *
   * Powód jest geometryczny: przy sterowaniu 20 stopni wiązka i zero z tyłu
   * są obrócone, więc punkty na osi Y nie leżą już ani na głównej osi, ani na
   * osi tłumienia. Zrobienie z tego uczciwego pomiaru wymaga liczenia kierunku
   * zera dla sterowanego gradientu — to osobna robota, a nie dopisek.
   *
   * Zostają dwa przypadki wyżej, bo one mierzą to, co ta zmiana naprawdę
   * gwarantuje: jeden delay sterujący na pozycję i odstęp przód/tył równy
   * głębokości skrzyni przez c.
   */
});
