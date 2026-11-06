/**
 * Store-facing array/steering operations.
 *
 * All the maths lives in engine/steering.ts; this module only maps it onto the
 * project's Source records. Keeping it separate means the steering physics is
 * testable without any app state.
 */

import type { Source, Vec3 } from '../core/types';
import {
  endFireDelays,
  levelTaper,
  positionsFromSpacing,
  steeringDelays,
  type ArrayAxis,
} from '../engine/steering';

export type SteerMode = 'flat' | 'steer' | 'dispersion' | 'endfire';

export function axisOf(p: Vec3, axis: ArrayAxis): number {
  return axis === 'x' ? p.x : axis === 'y' ? p.y : p.z;
}

export function withAxis(p: Vec3, axis: ArrayAxis, v: number): Vec3 {
  return axis === 'x' ? { ...p, x: v } : axis === 'y' ? { ...p, y: v } : { ...p, z: v };
}

/**
 * Distinct POSITIONS along the array axis, sorted, relative to the block centre.
 *
 * A position is not a cabinet. Once a rig has more than one cabinet per
 * position — four subs on top of each other at each of ten places on the deck —
 * "how many cabinets" and "how many positions" are different numbers, and every
 * question about PITCH is about the second one. Measured across all forty
 * cabinets of a ten-position rig the pitch came out as span/39 instead of
 * span/9 — a quarter of the real spacing, since the span is the same either way
 * — and the pattern-control limit quoted from it was four times too high.
 *
 * The tolerance is a clustering tolerance, not a rounding one: cabinets at one
 * position are meant to be exactly coincident on this axis, and 1 mm is tighter
 * than any spacing anybody tapes out while being loose enough to survive a
 * round trip through a file.
 */
export const POSITION_TOL_M = 1e-3;

export function axisPositions(
  sources: Source[],
  axis: ArrayAxis,
  tolM = POSITION_TOL_M,
): number[] {
  return positionBlocks(sources, axis, tolM).map((b) => b.centre);
}

/**
 * The places the module occupies on its layout axis, as BLOCKS.
 *
 * A place used to be one coordinate: cabinets at one position shared an x and
 * differed only in z, because a position was a stack. Cabinets standing on
 * their end face are not stacked, they stand SIDE BY SIDE touching, so one
 * place is now a run of coordinates one cabinet apart and the reading has to
 * recover it.
 *
 * `tolM` is the distance at which two cabinets still count as the same place.
 * At its default of a millimetre this is the old exact grouping and nothing
 * about an upright rig changes. Given a cabinet's footprint it becomes a
 * clustering distance, and the chain matters: each coordinate is compared with
 * the PREVIOUS one, not with the first of the run, or a row of four would
 * break into two places at the second step.
 *
 * The centre is returned rather than the first coordinate, because that is
 * what a place IS once it has width — spacing measured between first
 * coordinates is right only while every block holds the same number of
 * cabinets, and a rig that fails that is exactly the rig this must not
 * mis-describe.
 */
export interface PositionBlock {
  centre: number;
  from: number;
  to: number;
  count: number;
  /**
   * Indeksy członków tego bloku, gdy blok pochodzi z ZAPISANEJ przynależności
   * (`Source.positionKey`), a nie z klastrowania. Czytelnik, który mapuje
   * obudowę na blok, musi wtedy iść po tych indeksach, nie po współrzędnych:
   * pozycje zsunięte pomyłką w rozstawie zachodzą na siebie i jedna
   * współrzędna pasuje do dwóch bloków naraz.
   */
  members?: number[];
}

/**
 * Bloki z zapisanej przynależności, albo null, gdy choć jedna obudowa klucza
 * nie ma — wtedy czyta się geometrię, jak dotąd. Wszystko albo nic: mieszanie
 * obu odczytów w jednym module grupowałoby połowę rigu inaczej niż drugą.
 */
function storedBlocks(sources: Source[], axis: ArrayAxis): PositionBlock[] | null {
  if (!sources.length) return null;
  const byKey = new Map<string, number[]>();
  for (let i = 0; i < sources.length; i++) {
    const k = sources[i].positionKey;
    if (!k) return null;
    const got = byKey.get(k);
    if (got) got.push(i);
    else byKey.set(k, [i]);
  }
  const rel = relativePositions(sources, axis);
  const out: PositionBlock[] = [...byKey.values()].map((idx) => {
    idx.sort((a, b) => rel[a] - rel[b]);
    const from = rel[idx[0]];
    const to = rel[idx[idx.length - 1]];
    return { centre: (from + to) / 2, from, to, count: idx.length, members: idx };
  });
  out.sort((a, b) => a.centre - b.centre);
  return out;
}

export function positionBlocks(
  sources: Source[],
  axis: ArrayAxis,
  tolM = POSITION_TOL_M,
): PositionBlock[] {
  // Zapisana tożsamość ma pierwszeństwo przed odczytem geometrii. Pozycja
  // utworzona jako 4 × 4 zostaje 4 × 4 także wtedy, gdy pomyłka w rozstawie
  // zsunie pozycje na siebie — klastrowanie scalało wtedy rig w 1 × 16
  // i delay łuku szedł na każdą skrzynię osobno.
  return storedBlocks(sources, axis) ?? clusteredBlocks(sources, axis, tolM);
}

/** Odczyt z samej geometrii: łańcuch współrzędnych, jak dotąd. */
function clusteredBlocks(sources: Source[], axis: ArrayAxis, tolM: number): PositionBlock[] {
  const raw = [...relativePositions(sources, axis)].sort((a, b) => a - b);
  const out: PositionBlock[] = [];
  for (const v of raw) {
    const last = out[out.length - 1];
    if (last && v - last.to <= tolM) {
      last.to = v;
      last.count++;
      last.centre = (last.from + last.to) / 2;
    } else {
      out.push({ centre: v, from: v, to: v, count: 1 });
    }
  }
  return out;
}

/**
 * Indeksy członków bloku. Z zapisanej przynależności, gdy blok ją niesie;
 * inaczej po współrzędnych, jak dotąd.
 */
export function blockMembers(bl: PositionBlock, rel: number[]): number[] {
  if (bl.members) return bl.members;
  const out: number[] = [];
  for (let i = 0; i < rel.length; i++) {
    if (rel[i] >= bl.from - POSITION_TOL_M && rel[i] <= bl.to + POSITION_TOL_M) out.push(i);
  }
  return out;
}

/**
 * Azymut obudowy BEZ obrotu jej pozycji — kierunek, w którym patrzyłaby,
 * gdyby pozycja nie była obrócona. Wszystko, co pyta „czy ta skrzynia jest
 * odwrócona” albo „jak rozwachlowany jest rig”, pyta o ten kąt: pozycja
 * obrócona o 120° nie jest pozycją odwróconą.
 */
export function baseAzimuth(m: Source): number {
  return m.rotation.azimuthDeg - (m.positionYawDeg ?? 0);
}

/**
 * Klucz kolejności obudów W POZYCJI: rzut na kierunek rzędu po obrocie
 * pozycji (w poprzek dla rzędu na boku), wysokość dla stosu. Obudowa j wzoru
 * jest tą samą obudową w układzie, w odczycie i w zapisie F/B — także
 * w pozycji obróconej o 180°, gdzie zwykła współrzędna osi odwróciłaby
 * kolejność, a z nią to, która skrzynia jest B.
 */
export function rowOrderKey(m: Source, axis: ArrayAxis, sideways: boolean): number {
  if (!sideways) return m.position.z;
  const a = ((m.positionYawDeg ?? 0) * Math.PI) / 180;
  // kierunek rzędu przed obrotem: oś układu; obrót zgodnie ze wskazówkami
  // zegara (konwencja azymutu): (x, y) -> (x cos + y sin, -x sin + y cos)
  const [ux, uy] = axis === 'y' ? [0, 1] : [1, 0];
  const dx = ux * Math.cos(a) + uy * Math.sin(a);
  const dy = -ux * Math.sin(a) + uy * Math.cos(a);
  return m.position.x * dx + m.position.y * dy;
}

/**
 * Wzór F/B jest SYMETRYCZNY względem środka arraya:
 * po lewej F B F F, po prawej F F B F. Wzór jest pisany dla lewej połowy;
 * pozycje na prawo od środka czytają go od końca. Pozycja dokładnie
 * w środku (nieparzysta liczba) gra wzór tak, jak go zapisano. Dotyczy rzędów
 * obudów obok siebie — w stosie kolejność jest dół-góra i lustro nic nie znaczy.
 */
export function mirroredAt(blockCentre: number, sideways: boolean): boolean {
  return sideways && blockCentre > MIRROR_TOL_M;
}
/** centymetr: pozycja środkowa liczona z geometrii nie trafia w zero dokładnie */
const MIRROR_TOL_M = 0.01;

/**
 * Czy pozycje to rzędy obudów OBOK siebie (a nie stosy). Po rozrzucie
 * w planie, nie wzdłuż osi: rząd obrócony o 90° nie ma żadnej długości na
 * osi arraya, a dalej jest rzędem.
 */
function blocksAreSideways(members: Source[], blocks: PositionBlock[], rel: number[]): boolean {
  return blocks.some((bl) => {
    const idx = blockMembers(bl, rel);
    return idx.some((i) =>
      idx.some((k) => Math.hypot(members[i].position.x - members[k].position.x, members[i].position.y - members[k].position.y) > POSITION_TOL_M),
    );
  });
}

/** Środek arraya do lustra wzoru: średnia środków pozycji. */
function patternCentre(blocks: PositionBlock[]): number {
  return blocks.length ? blocks.reduce((t, b) => t + b.centre, 0) / blocks.length : 0;
}

/** Member positions along the array axis, relative to their own centre. */
export function relativePositions(sources: Source[], axis: ArrayAxis): number[] {
  const raw = sources.map((s) => axisOf(s.position, axis));
  if (!raw.length) return [];
  const centre = (Math.min(...raw) + Math.max(...raw)) / 2;
  return raw.map((v) => v - centre);
}

export interface LayoutOptions {
  count: number;
  spacingM: number;
  axis: ArrayAxis;
  /** coordinate of the array centre on the layout axis */
  centreM: number;
  /**
   * Total fan angle; outermost cabinets get +-splay/2, centre gets 0.
   *
   * Undefined means "leave every cabinet aimed where it is". A layout rebuild
   * moves cabinets; it is not a statement about where they point, and an array
   * that was fanned or tilted by hand is the one case where re-deriving the aim
   * destroys work nothing else in the program can put back. A typed 0 is not
   * the same thing: it means "no fan", and it is written.
   */
  splayDeg?: number;
  /** applied to every cabinet; undefined leaves each one its own tilt */
  elevationDeg?: number;
  /**
   * Coordinates on the axes the array does not run along. The SUBS panel places
   * a line with these ("At x =", "Position z"); anything omitted keeps the
   * template's value.
   */
  cross?: Partial<Record<ArrayAxis, number>>;
  /** the "other" coordinates, taken from the template cabinet */
  template: Source;
  /**
   * Cabinets at EACH position, stacked on the vertical axis because they rest on
   * each other. 1 is a plain line and is the default, so nothing changes for a
   * caller that does not know about this.
   *
   * Ignored when the layout axis is Z: a column already IS the stack, and
   * stacking a stack would put two cabinets in the same place.
   */
  perPosition?: number;
  /**
   * Pitch of that stack. Cabinets on cabinets have no free pitch — it is the
   * cabinet's own height in the orientation it is standing in — so the caller
   * resolves it and this module just uses it. 0 collapses the stack onto one
   * point, which is why the decision layer refuses `perPosition > 1` without a
   * confirmed height rather than guessing one.
   */
  stackPitchM?: number;
  /**
   * Width of one cabinet across the layout axis, when the cabinets at a
   * position stand SIDE BY SIDE instead of on each other. 0 or omitted keeps
   * the old vertical stack.
   *
   * A cabinet on its end face is not stackable in any useful way: four KS28 on
   * end, one on another, is a tower 5.36 m high, which is not what anybody
   * builds. On end they go next to each other, touching on the largest face
   * they have, which is the one that was the top before the roll. So the
   * orientation decides the direction, and the decision layer passes this when
   * it has rolled the cabinets.
   *
   * It is also the distance at which two cabinets still count as ONE position
   * when the rig is read back, which is why the same number does both jobs: a
   * place is a run of cabinets one cabinet apart.
   */
  acrossM?: number;
  /**
   * Which cabinets of each position are turned round to face backwards.
   *
   * Three states, and the difference between the last two is the one that
   * matters. OMITTED means this layout makes no statement about headings or
   * polarity and leaves both exactly as they are — the default, so a caller
   * that knows nothing about reverse stacks cannot disturb one. `'none'` is an
   * instruction: it says no cabinet is reversed, and straightens any that are.
   * Without that distinction, setting the control back to None left boxes
   * pointing upstage, inverted, inside what the panel now called a plain row.
   *
   * `'bottom'` and `'top'` make the layout OWN the heading and the polarity of
   * every cabinet in the position, the way a typed taper owns the level column,
   * because a reverse stack is only a reverse stack if the others are not also
   * reversed.
   */
  reverseAt?: StackReverse;
  /**
   * Które obudowy pozycji są odwrócone, po kolei, od dołu stosu albo od lewej
   * strony rzędu. Długość równa `perPosition`.
   *
   * `reverseAt` umie powiedzieć tylko „tyle sztuk przy tym końcu”, a to nie
   * opisuje wzorów, które się naprawdę buduje: F B F i F F B F są
   * w blokach KS28 i mają odwróconą obudowę w ŚRODKU. Dla
   * takiego rigu edytor zgłaszał „nie umiem tego opisać” i odmawiał
   * przebudowy.
   *
   * Gdy jest podany, rządzi: `reverseAt` i `reverseCount` są wtedy pomijane.
   */
  reversePattern?: boolean[];
  /**
   * How many cabinets of each position are turned round, counted from the end
   * `reverseAt` names. 1 by default.
   *
   * Not a cosmetic generalisation of "one": the count IS the rear rejection.
   * Three forward and one reversed cannot beat 6 dB and measures 2 dB at 40 Hz,
   * while matched groups measure past 30 dB. See `gradientRejectionDb`.
   */
  reverseCount?: number;
  /**
   * The heading the forward cabinets face while a reversal is being written.
   *
   * Required for idempotence, and that is the whole reason it exists. Derived
   * from each cabinet's own azimuth instead, a second Apply layout would add
   * another 180 degrees to the box that was already turned round and hand it
   * back to the front.
   */
  forwardAzimuthDeg?: number;
  /**
   * The gradient's d/c, seconds, written ABSOLUTELY into the hidden
   * `Source.gradientDelayS` of every cabinet the layout owns the heading of:
   * d for a reversed one, nothing for a forward one.
   *
   * It used to be a DELTA on the user delay column, with transition tracking,
   * because a shared column demanded it — and everything else that writes
   * that column (Apply delay, resets, a hand edit) could silently take the
   * gradient away. A dedicated field makes the write idempotent and puts the
   * cardioid out of reach of the delay tools. See Source.gradientDelayS.
   */
  reverseDelayS?: number;
  /** roll written onto every cabinet, degrees about the front axis */
  rollDeg?: number;
}

/** Which cabinet of a stacked position faces backwards, if any. */
export type StackReverse = 'none' | 'bottom' | 'top';

/**
 * Rebuild an array's geometry. Existing members are reused in order so their
 * individual level/delay/polarity survive; extras are dropped and shortfalls
 * are cloned from the template.
 *
 * `count` counts POSITIONS and `perPosition` counts the cabinets at each one, so
 * the result is `count * perPosition` long. The flat order is position-major and
 * bottom-up within a position, which is how a rig is read off a drawing and how
 * the table lists it: 1A 1B 1C 1D, 2A 2B ...
 */
export function layoutSources(
  members: Source[],
  opts: LayoutOptions,
  makeId: () => string,
  makeLabel: (index: number) => string,
): Source[] {
  const n = Math.max(1, Math.round(opts.count));
  // A column is already a stack of cabinets on cabinets; stacking it again
  // would put two boxes at the same height. See `perPosition`.
  const per = opts.axis === 'z' ? 1 : Math.max(1, Math.round(opts.perPosition ?? 1));
  const positions = positionsFromSpacing(n, opts.spacingM);
  const maxAbs = Math.max(...positions.map(Math.abs), 1e-9);
  // Bottom-up offsets about the stack's own centre. The CENTRE is what arrives
  // here: converting the deck height or the rigging height into it is the
  // decision layer's job and goes through the same `stackCentreFromRef` a
  // vertical column uses, so the two cannot drift.
  const within = positionsFromSpacing(per, opts.stackPitchM ?? 0);
  // Reversing every cabinet of a position is not a gradient, it is the rig
  // turned round, so at least one has to stay facing the audience.
  const nRev =
    opts.reverseAt === undefined || opts.reverseAt === 'none'
      ? 0
      : Math.min(per - 1, Math.max(1, Math.round(opts.reverseCount ?? 1)));
  // Jawny wzór ma pierwszeństwo nad „tyle sztuk przy końcu”, ale tylko wtedy,
  // gdy opisuje tę pozycję: tablica innej długości niż liczba obudów opisuje
  // inny rig i przebudowa według niej odwróciłaby nie te skrzynie.
  const pattern =
    opts.reversePattern && opts.reversePattern.length === per ? opts.reversePattern : null;
  // Odwrócenie KAŻDEJ obudowy pozycji to nie gradient, tylko rig obrócony
  // tyłem — przynajmniej jedna musi patrzeć na widownię. Ta sama zasada co dla
  // `reverseCount` niżej.
  const safePattern = pattern && pattern.some((v) => !v) ? pattern : null;
  // An omitted reverseAt says nothing; a reverseAt of 'none' says "none", which
  // is a statement and has to be written. See the field's own documentation.
  const ownsHeading = opts.reverseAt !== undefined || safePattern !== null;
  const isReversed = (j: number) =>
    safePattern
      ? safePattern[j]
      : opts.reverseAt === 'bottom'
        ? j < nRev
        : opts.reverseAt === 'top'
          ? j >= per - nRev
          : false;
  // Members are matched to places GEOMETRICALLY: grouped by where they stand on
  // the layout axis and ordered bottom-up inside that. A flat running index
  // sent member k to position floor(k/per), so deepening a stack reshuffled the
  // rig — cabinets kept their label, level and delay and swapped physical place,
  // and two interleaved modules ended up spliced through each other. It also
  // disagreed with every other part of this feature, which reads positions off
  // the geometry, so the cabinet the layout reversed was not always the one the
  // editor had designated.
  const relAxis = relativePositions(members, opts.axis);
  // One place is a run of cabinets a cabinet apart when they stand side by
  // side, and a single coordinate when they stand on each other.
  const across = opts.acrossM && opts.acrossM > 0 ? opts.acrossM : 0;
  const placeTol = across > 0 ? across + POSITION_TOL_M : POSITION_TOL_M;
  // Zapisane klucze rządzą dopasowaniem obudowa->miejsce tylko wtedy, gdy
  // STRUKTURA się zgadza: tyle zapisanych pozycji, ile miejsc buduje układ.
  // To jest ścieżka ratunkowa — suwak wraca z nachodzących pozycji i każda
  // obudowa zostaje w swojej, z własnym poziomem, delayem i polaryzacją.
  // Przy ZMIANIE struktury (inna liczba pozycji) dopasowanie wraca do
  // geometrii, jak dotąd: zmniejszenie "wszystkich źródeł" z dwóch arrayów
  // ma obciąć ogon, a bloki z kluczy dwóch przeplatających się w przestrzeni
  // arrayów obcinałyby na zmianę z jednego i z drugiego.
  const stored = positionBlocks(members, opts.axis, placeTol);
  const blocks =
    stored.length && stored[0].members !== undefined && stored.length !== n
      ? clusteredBlocks(members, opts.axis, placeTol)
      : stored;
  const byPlace = blocks.map((bl) =>
    blockMembers(bl, relAxis)
      // Ordered along the direction the position is built in, so cabinet j of
      // a place is the same cabinet before and after an Apply layout. Sorting
      // a side-by-side row by height left every cabinet at depth 0 and the
      // order fell to whatever the array happened to hold, which is how a
      // reversal lands on a different box each time it is written.
      .slice()
      .sort((a, b) => rowOrderKey(members[a], opts.axis, across > 0) - rowOrderKey(members[b], opts.axis, across > 0)),
  );
  const indexAt = (i: number, j: number): number | undefined => byPlace[i]?.[j];
  // Obrót pozycji jedzie z obudowami, które na niej stały — przebudowa
  // stawia pozycję od zera i obraca ją z powrotem o ten sam kąt.
  const yawAt = (i: number): number => {
    const k = byPlace[i]?.find((m) => members[m].positionYawDeg !== undefined);
    return k === undefined ? 0 : members[k].positionYawDeg ?? 0;
  };
  // Każda przebudowa pisze pozycjom świeże klucze. Prefiks z własnego id,
  // żeby dwa moduły w jednym projekcie nie dzieliły kluczy — widok "wszystkie
  // źródła" czyta je razem i wspólny klucz skleiłby pozycje dwóch arrayów.
  const runKey = makeId();

  const out: Source[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < per; j++) {
      const flat = i * per + j;
      const from = indexAt(i, j);
      const existing = from === undefined ? undefined : members[from];
      const base: Source = existing
        ? { ...existing, position: { ...existing.position }, rotation: { ...existing.rotation } }
        : {
            ...opts.template,
            id: makeId(),
            label: makeLabel(flat),
            position: { ...opts.template.position },
            rotation: { ...opts.template.rotation },
          };

      // Przynależność do pozycji jest pisana ZAWSZE, także obudowie
      // przenoszonej z poprzedniego układu: stary klucz opisywał stary rig.
      base.positionKey = `${runKey}.${i}`;

      base.position = withAxis(
        { ...opts.template.position, ...base.position },
        opts.axis,
        opts.centreM + positions[i],
      );
      // keep the non-layout coordinates aligned with the template, then let an
      // explicit cross-axis placement win over it
      if (opts.axis !== 'x') base.position.x = opts.template.position.x;
      if (opts.axis !== 'y') base.position.y = opts.template.position.y;
      if (opts.axis !== 'z') base.position.z = opts.template.position.z;
      for (const a of ['x', 'y', 'z'] as ArrayAxis[]) {
        const v = opts.cross?.[a];
        if (a !== opts.axis && v !== undefined) base.position[a] = v;
      }
      // and then along the position: up the stack for an upright cabinet, or
      // across for one standing on its end face. Applied last so it is measured
      // from whatever the cross-axis placement settled on, not from the
      // template.
      const pivot = { x: base.position.x, y: base.position.y };
      if (per > 1) {
        if (across > 0) base.position[opts.axis] += within[j];
        else base.position.z += within[j];
      }

      // `!== undefined` and not a truthiness test: a typed 0 is an instruction to
      // unfan the block or to level it off, which is not the same answer as "the
      // caller said nothing about the aim".
      const fanned =
        opts.splayDeg !== undefined ? (opts.splayDeg / 2) * (positions[i] / maxAbs) : null;
      // While a reversal is being written the forward heading has to come from
      // the MODULE, not from the cabinet: see `forwardAzimuthDeg`.
      const forward = ownsHeading
        ? fanned ?? opts.forwardAzimuthDeg ?? opts.template.rotation.azimuthDeg
        : fanned ?? baseAzimuth(base);
      const reversed = isReversed(mirroredAt(positions[i], across > 0) ? per - 1 - j : j);

      // Pozycja obraca się jak jedna obudowa: po okręgu wokół swojego środka,
      // a każda skrzynia dostaje ten sam przyrost azymutu.
      const yaw = yawAt(i);
      if (yaw) {
        const a = (yaw * Math.PI) / 180;
        const dx = base.position.x - pivot.x, dy = base.position.y - pivot.y;
        base.position.x = pivot.x + dx * Math.cos(a) + dy * Math.sin(a);
        base.position.y = pivot.y - dx * Math.sin(a) + dy * Math.cos(a);
      }
      base.positionYawDeg = yaw || undefined;
      base.rotation = {
        ...base.rotation,
        azimuthDeg: (reversed ? forward + 180 : forward) + yaw,
        elevationDeg: opts.elevationDeg ?? base.rotation.elevationDeg,
        rollDeg: opts.rollDeg ?? base.rotation.rollDeg,
      };
      if (ownsHeading) {
        // The forward boxes are set NOT inverted on purpose. A reverse stack in
        // which everything is inverted is not a reverse stack, it is the same
        // rig with its polarity flipped, and the rear null does not appear.
        base.invertPolarity = reversed;
        // Gradient idzie do ZASZYTEGO pola, absolutnie i idempotentnie —
        // nie do kolumny delayów użytkownika. Dawna delta na delayS istniała
        // tylko dlatego, że pisała do wspólnej kolumny i musiała śledzić
        // przejścia; osobne pole czyni z tego zwykłe przypisanie. Patrz
        // Source.gradientDelayS.
        const d = opts.reverseDelayS;
        base.gradientDelayS = reversed && d !== undefined && d > 0 ? d : undefined;
      }
      out.push(base);
    }
  }
  return out;
}

export interface DelayOptions {
  mode: SteerMode;
  steerDeg: number;
  dispersionDeg: number;
  axis: ArrayAxis;
  speedOfSound: number;
  /** optional symmetric level taper, dB at the outermost cabinet */
  edgeTaperDb?: number;
  /**
   * Per-member delay ADDED to the steering delay, seconds.
   *
   * This is how a reverse-stack survives being steered. The gradient delay on a
   * turned-round cabinet is not part of the aim, it is part of the cabinet's
   * configuration: steering the rig has to add to it, and the plan is the only
   * place a per-cabinet delay can come from, because applying a plan overwrites
   * the whole delay column. Left out, every Apply delay would flatten the rear
   * null the layout had just built.
   */
  extraDelaysS?: number[];
  /**
   * Odległość, przy której dwie obudowy liczą się jako JEDNA POZYCJA.
   *
   * Taper sterujący opisuje miejsce na podeście, nie pojedynczą skrzynię:
   * wszystkie obudowy jednej pozycji mają dostać ten sam delay, liczony dla
   * ŚRODKA pozycji. Przy pionowym stosie wychodziło to samo z siebie, bo
   * obudowy stosu mają jeden X. Przy rzędzie już nie — osiemnaście obudów na
   * boku rozciąga się na 9.9 m, każda dostawała inny delay sterujący, i ten
   * rozrzut nakładał się na delay gradientowy. Kardioida przestawała być
   * kardioidą, bo odstęp czasowy między obudową przednią a odwróconą nie był
   * już głębokością skrzyni przez prędkość dźwięku.
   *
   * Domyślny milimetr to zachowanie dotychczasowe: każda osobna współrzędna
   * jest własną pozycją, więc stos i end-fire liczą się dokładnie jak dotąd.
   */
  placeTolM?: number;
}

export interface DelayPlan {
  delaysS: number[];
  levelsDb: number[] | null;
  /** largest delay produced, seconds — what the UI shows as the spread */
  maxDelayS: number;
}

/**
 * Compute the delay (and optional level) taper for a set of members.
 *
 * End-fire uses the members' own depth ordering; the other modes use their
 * position along the layout axis.
 */
export function planDelays(members: Source[], opts: DelayOptions): DelayPlan {
  const rel = relativePositions(members, opts.axis);
  if (!rel.length) return { delaysS: [], levelsDb: null, maxDelayS: 0 };
  // Każda obudowa bierze współrzędną ŚRODKA swojej pozycji, nie własną.
  // Przez przynależność, nie przez współrzędne: pozycje zsunięte pomyłką
  // w rozstawie zachodzą na siebie i jedna współrzędna leży w dwóch blokach.
  const blocks = positionBlocks(members, opts.axis, opts.placeTolM ?? POSITION_TOL_M);
  const positions = rel.slice();
  for (const b of blocks) {
    for (const i of blockMembers(b, rel)) positions[i] = b.centre;
  }

  let delaysS: number[];
  switch (opts.mode) {
    case 'flat':
      delaysS = positions.map(() => 0);
      break;
    case 'endfire':
      delaysS = endFireDelays(positions, opts.speedOfSound);
      break;
    case 'steer':
      delaysS = steeringDelays({
        positions,
        steerDeg: opts.steerDeg,
        speedOfSound: opts.speedOfSound,
      });
      break;
    case 'dispersion':
      delaysS = steeringDelays({
        positions,
        steerDeg: opts.steerDeg,
        dispersionDeg: opts.dispersionDeg,
        speedOfSound: opts.speedOfSound,
      });
      break;
  }

  // A taper of 0 dB is a taper: it is how the operator takes one OFF, so it has
  // to produce a plan of zeros that overwrites the trimmed levels. Testing the
  // number for truthiness instead left every trimmed cabinet trimmed forever,
  // with the control back at 0 and nothing to show what was still applied.
  // `undefined` is the only silence, and it leaves the level column alone.
  const levelsDb =
    opts.edgeTaperDb !== undefined && opts.mode !== 'endfire'
      ? levelTaper(positions, opts.edgeTaperDb)
      : null;

  // Added, not substituted: see `extraDelaysS`. The spread the panel reports is
  // the spread of what will actually be written, offsets included.
  const extra = opts.extraDelaysS;
  if (extra) delaysS = delaysS.map((v, i) => v + (extra[i] ?? 0));

  return { delaysS, levelsDb, maxDelayS: Math.max(...delaysS) };
}

/**
 * The drift a column is allowed when nobody has published a cabinet size.
 *
 * 5 cm sits in a wide gap: an imported or hand-nudged column drifts by
 * centimetres, while the narrowest rig anyone builds puts two cabinets side by
 * side, and the smallest sub in the library is 0.4 m across. Only reached when
 * the caller has no cabinet size to offer; with one, the cabinet decides.
 */
const COLUMN_DRIFT_M = 0.05;

/**
 * The axis a module is actually laid out along. Lets the Steering panel
 * describe an existing array without the user having to tell it whether the
 * line is horizontal or a flown column.
 *
 * `cabinetSpanM` is the cabinet's own horizontal size, and it is what makes
 * this answerable rather than a guess. A column is cabinets at ONE PLACE on the
 * deck; a grid is several places with stacks on them. "One place" is a cabinet
 * footprint, so the test is whether the whole rig fits inside one — which two
 * positions never do, however tall their stacks, and which a column with a
 * couple of centimetres of drift always does.
 *
 * Two heuristics were tried before this and both reopened the same blocker.
 * Largest-extent-wins read three positions of four touching KS21 (1.53 m
 * across, 1.71 m up) as a column. A fraction of the height read TWO positions
 * of four on-end KS21 as one, because the spread is then exactly one cabinet
 * width and the threshold scales with the stack. Either way the editor reported
 * a handful of cabinets instead of all of them and the next Apply layout
 * deleted the difference, silently.
 */
export function detectAxis(sources: Source[], cabinetSpanM = 0): ArrayAxis {
  if (sources.length < 2) return 'x';
  const extent = (axis: ArrayAxis) => {
    const v = sources.map((s) => axisOf(s.position, axis));
    return Math.max(...v) - Math.min(...v);
  };
  const ex = extent('x');
  const ey = extent('y');
  const ez = extent('z');
  const horizontal: ArrayAxis = ex >= ey ? 'x' : 'y';
  const spread = Math.max(ex, ey);
  const onePlace = Math.max(cabinetSpanM, COLUMN_DRIFT_M);
  if (ez > 1e-6 && spread < onePlace) return 'z';
  if (spread > 1e-6) return horizontal;
  return 'x';
}

/**
 * Spacing implied by the members' current geometry, measured between POSITIONS.
 *
 * See `axisPositions`: across a stacked rig the per-cabinet reading is wrong by
 * the stack depth, and it is the number the pattern-control limit is quoted
 * from.
 */
export function currentSpacing(members: Source[], axis: ArrayAxis, placeTolM = POSITION_TOL_M): number {
  const p = axisPositions(members, axis, placeTolM);
  if (p.length < 2) return 0;
  return (p[p.length - 1] - p[0]) / (p.length - 1);
}

/** How many places on the deck the module occupies, however deep each one is. */
export function countPositions(members: Source[], axis: ArrayAxis, placeTolM = POSITION_TOL_M): number {
  return Math.max(members.length ? 1 : 0, axisPositions(members, axis, placeTolM).length);
}

/**
 * Cabinets per position, when the rig divides evenly into its positions.
 *
 * Null when it does not — a rig with three cabinets at one position and two at
 * the next has no single answer, and reporting the average would let an Apply
 * layout rebuild it into something nobody has.
 */
export function cabinetsPerPosition(
  members: Source[],
  axis: ArrayAxis,
  placeTolM = POSITION_TOL_M,
): number | null {
  const blocks = positionBlocks(members, axis, placeTolM);
  if (!blocks.length) return null;
  // Uniformity, not divisibility. Six cabinets over three positions divides
  // cleanly as two each and also as 3 + 2 + 1, and the second rig has no
  // cabinets-per-position at all — reporting two for it let an Apply layout
  // rebuild something nobody had.
  let n = -1;
  for (const b of blocks) {
    if (n === -1) n = b.count;
    else if (n !== b.count) return null;
  }
  return n > 0 ? n : null;
}

/**
 * Pitch measured over every CABINET rather than over positions.
 *
 * The fallback for a rig the editor cannot describe by positions: there the
 * count is the cabinet count, and a position pitch next to a cabinet count is
 * two different rigs multiplied together — it printed a 2.76 m row as 6.76 m
 * wide and an untouched Apply layout would have spread it to match.
 */
export function spacingOverCabinets(members: Source[], axis: ArrayAxis): number {
  const p = [...relativePositions(members, axis)].sort((a, b) => a - b);
  if (p.length < 2) return 0;
  return (p[p.length - 1] - p[0]) / (p.length - 1);
}

/**
 * The heading the module as a whole faces: the most common azimuth among its
 * cabinets, to the nearest degree.
 *
 * "Most common" rather than the mean, because a reverse-stack rig deliberately
 * contains cabinets 180 degrees from the rest and a mean would sit between the
 * two, pointing the whole rig at nothing. A tie goes to the heading of the
 * first cabinet, which is the one the operator laid out first.
 */
export function dominantAzimuth(members: Source[]): number {
  if (!members.length) return 0;
  const tally = new Map<number, number>();
  for (const m of members) {
    const key = Math.round(baseAzimuth(m));
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  let best = Math.round(baseAzimuth(members[0]));
  let bestN = tally.get(best) ?? 0;
  for (const [deg, n] of tally) {
    // A tie is the case that matters, and it is not rare: ten positions of two
    // cabinets with the bottom one reversed is exactly half and half. Broken by
    // the first cabinet it would have handed the rig's heading to whichever end
    // of the stack happened to be built first, and an Apply layout would then
    // turn the whole rig round — and back again on the next press. Broken
    // toward the heading nearer 0 it is the half facing the audience, which is
    // what this program's azimuth 0 means. A 50/50 rig aimed UPSTAGE reads the
    // other way round; aim it with the module yaw rather than by turning every
    // cabinet, and nothing is ambiguous.
    if (n > bestN || (n === bestN && angleBetween(deg, 0) < angleBetween(best, 0))) {
      best = deg;
      bestN = n;
    }
  }
  return best;
}

/**
 * Which cabinets are turned round relative to the module they belong to.
 *
 * Measured off the canvas rather than stored, like `currentSplay` and
 * `detectAxis` beside it: a reverse-stack is a cabinet whose heading is more
 * than a quarter turn from where the rig faces. A fan cannot reach that — a
 * 180 degree splay would put its end cabinets at +-90, which is the boundary,
 * and no sub array is fanned that wide — so the test separates "aimed outward"
 * from "turned around" without needing a flag in the file.
 */
export function reversedFlags(members: Source[], forwardAzimuthDeg?: number): boolean[] {
  const base = forwardAzimuthDeg ?? forwardHeadingOf(members);
  return members.map((m) => angleBetween(baseAzimuth(m), base) > 90);
}

/**
 * Which way a rig FACES, read off the rig and nothing else.
 *
 * A majority vote cannot answer this and two attempts proved it: a stack that
 * is half reversed is a tie, and one that is more than half reversed votes
 * ITSELF backwards — a 3-reversed-out-of-4 rig reported its single forward
 * cabinet as the turned one, and one Apply delay fired the array at the
 * audience while the panel printed 6 dB of rear rejection. Taking the answer
 * from the editor's own pending setting was worse: switching the control from
 * Bottom to Top read the heading off the cabinets that were still turned round
 * and handed the whole rig a half turn.
 *
 * Polarity settles it. A reverse stack is built by turning a box round AND
 * inverting it, so the cabinets that are NOT inverted are the ones facing the
 * way the rig faces, whatever the ratio and whichever end they sit at. It is a
 * property of the cabinets on the canvas, so it cannot disagree with them, and
 * a rig with no inversion anywhere falls back to the vote, which for that rig
 * is not ambiguous.
 */
export function forwardHeadingOf(members: Source[]): number {
  const upright = members.filter((m) => !m.invertPolarity);
  return dominantAzimuth(upright.length ? upright : members);
}

/**
 * The reverse stack a rig ALREADY has: which end is turned round and how many.
 *
 * The editor had no measurement of this at all, and that was the hole under
 * half of the reversal defects. A control that is only ever an instruction
 * describes a rig it has never looked at: the default 'none' read as "nobody
 * is reversed" over a hand-built cardioid and one Apply layout straightened
 * it, and the heading it wrote came from whichever end the control happened to
 * name rather than from the cabinets.
 *
 * `at` is 'none' when nothing is turned round AND when the turned cabinets do
 * not all sit at one end of their positions, because that rig is not a reverse
 * stack this editor can describe; `describable` tells the two cases apart so a
 * layout can refuse to rewrite the second rather than flatten it.
 */
export function measureReversal(
  members: Source[],
  axis: ArrayAxis,
  placeTolM = POSITION_TOL_M,
): { at: StackReverse; count: number; describable: boolean; pattern: boolean[] | null } {
  const none = { at: 'none' as StackReverse, count: 0, describable: true, pattern: null };
  if (!members.length) return none;
  const rev = reversedFlags(members);
  if (!rev.some(Boolean)) return none;

  const rel = relativePositions(members, axis);
  let bottom = 0;
  let top = 0;
  let n = -1;
  let shape: boolean[] | null = null;
  // Grouped into BLOCKS, like every other reading. Left on the exact grouping
  // this saw a row of cabinets standing on their end face as one position per
  // cabinet, and a position holding a single cabinet can express no reversal
  // pattern at all - so it reported "no cardioid this editor can describe" and
  // Apply layout went grey on a rig the program had just built itself.
  const blocks = positionBlocks(members, axis, placeTolM);
  const sideways = blocksAreSideways(members, blocks, rel);
  const mid = patternCentre(blocks);
  // Wzór pisze się dla lewej połowy, a prawa jest jego lustrem (mirroredAt).
  // Rig zbudowany jeszcze bez lustra — ten sam wzór na każdej pozycji — też
  // jest opisywalny; następne Zastosuj ustawi go już symetrycznie.
  const read = (mirror: boolean) => blocks.map((bl) => {
    const idx = blockMembers(bl, rel)
      // Along the direction the position is built in: across for a row, up for
      // a stack. Ordering a row by height put every cabinet at the same z and
      // left the order to chance, so "bottom" and "top" named whichever box the
      // array happened to hold first.
      .slice()
      .sort((a, b) => rowOrderKey(members[a], axis, sideways) - rowOrderKey(members[b], axis, sideways));
    const flags = idx.map((i) => rev[i]);
    return mirror && mirroredAt(bl.centre - mid, sideways) ? flags.reverse() : flags;
  });
  const same = (fs: boolean[][]) =>
    fs.every((f) => f.length === fs[0].length && f.every((v, i) => v === fs[0][i]));
  const mirrored = read(true);
  const readings = same(mirrored) ? mirrored : read(false);
  for (const flags of readings) {
    // Każda pozycja musi mieć TEN SAM wzór. Inaczej nie ma jednego opisu
    // całego modułu, a przebudowa z opisu, którego nie ma, przestawiłaby
    // połowę rigu.
    if (shape === null) shape = flags;
    else if (shape.length !== flags.length || shape.some((v, i) => v !== flags[i])) {
      return { at: 'none', count: 0, describable: false, pattern: null };
    }
    const k = flags.filter(Boolean).length;
    // Pozycja bez odwróconej albo z samymi odwróconymi nie jest gradientem.
    if (k === 0 || k === flags.length) return { at: 'none', count: 0, describable: false, pattern: null };
    if (n === -1) n = k;
    else if (n !== k) return { at: 'none', count: 0, describable: false, pattern: null };
    if (flags.slice(0, k).every(Boolean)) bottom++;
    if (flags.slice(flags.length - k).every(Boolean)) top++;
  }
  const positions = blocks.length;
  // Wzór jest ten sam na każdej pozycji, więc rig DA SIĘ opisać — niezależnie
  // od tego, czy odwrócone obudowy stoją przy końcu. „Dolna” i „Górna”
  // zostają nazwami dla dwóch najczęstszych kształtów; reszta, w tym
  // odwrócona obudowa w środku, jest opisana samym wzorem.
  if (bottom === positions) return { at: 'bottom', count: n, describable: true, pattern: shape };
  if (top === positions) return { at: 'top', count: n, describable: true, pattern: shape };
  return { at: 'none', count: n, describable: true, pattern: shape };
}

/**
 * The fan the members are actually aimed at, in degrees, signed.
 *
 * `layoutSources` builds a splay by putting the two end cabinets at +-splay/2,
 * so the inverse is the azimuth at the +axis end minus the azimuth at the -axis
 * end. It is a measurement of the ends rather than a fit: an array fanned by
 * hand in the table still reports the angle between its outermost two cabinets,
 * which is what the field is quoting. 0 for a single cabinet, and for any block
 * whose ends point the same way.
 */
export function currentSplay(members: Source[], axis: ArrayAxis): number {
  if (members.length < 2) return 0;
  let low = members[0];
  let high = members[0];
  for (const m of members) {
    if (axisOf(m.position, axis) < axisOf(low.position, axis)) low = m;
    if (axisOf(m.position, axis) > axisOf(high.position, axis)) high = m;
  }
  return baseAzimuth(high) - baseAzimuth(low);
}

/** Centre coordinate of the members on the layout axis. */
export function currentCentre(members: Source[], axis: ArrayAxis): number {
  const raw = members.map((s) => axisOf(s.position, axis));
  if (!raw.length) return 0;
  return (Math.min(...raw) + Math.max(...raw)) / 2;
}

/** Unsigned angle between two headings, degrees, folded into 0..180. */
export function angleBetween(aDeg: number, bDeg: number): number {
  const d = ((((aDeg - bDeg) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/**
 * Obraca POZYCJE wskazanych obudów do kąta `yawDeg` (bezwzględnie), każdą jak
 * jedną wielką obudowę: skrzynie jadą po okręgu wokół środka pozycji, każda
 * dostaje ten sam przyrost azymutu, a pozycja zapamiętuje kąt w
 * `positionYawDeg`, żeby przebudowa układu umiała go odtworzyć.
 *
 * Pozycja = wspólny `positionKey`; obudowa bez klucza jest pozycją sama
 * dla siebie (obraca się w miejscu). Zwraca CAŁĄ listę z podmienionymi
 * członkami.
 */
export function rotatePositions(sources: Source[], ids: string[], yawDeg: number): Source[] {
  const keyOf = (s: Source) => s.positionKey ?? `solo:${s.id}`;
  const chosen = new Set(ids);
  const keys = new Set(sources.filter((s) => chosen.has(s.id)).map(keyOf));
  const byKey = new Map<string, Source[]>();
  for (const s of sources) {
    const k = keyOf(s);
    if (!keys.has(k)) continue;
    const got = byKey.get(k);
    if (got) got.push(s);
    else byKey.set(k, [s]);
  }
  const next = new Map<string, Source>();
  for (const members of byKey.values()) {
    const cx = members.reduce((t, m) => t + m.position.x, 0) / members.length;
    const cy = members.reduce((t, m) => t + m.position.y, 0) / members.length;
    const d = yawDeg - (members[0].positionYawDeg ?? 0);
    const a = (d * Math.PI) / 180;
    for (const m of members) {
      const dx = m.position.x - cx, dy = m.position.y - cy;
      next.set(m.id, {
        ...m,
        position: { ...m.position, x: cx + dx * Math.cos(a) + dy * Math.sin(a), y: cy - dx * Math.sin(a) + dy * Math.cos(a) },
        rotation: { ...m.rotation, azimuthDeg: m.rotation.azimuthDeg + d },
        positionYawDeg: yawDeg || undefined,
      });
    }
  }
  return sources.map((s) => next.get(s.id) ?? s);
}

/**
 * Wzór F/B zapisany NATYCHMIAST — bez przebudowy układu.
 *
 * Kliknięcie w rząd „Wzór” zmieniało dotąd tylko podgląd; obudowy szły za nim
 * dopiero po „Zastosuj rozstaw”, a do tego czasu przyciski mówiły jedno, a rig
 * drugie. Ta funkcja dotyka WYŁĄCZNIE trzech faktów każdej obudowy: kierunku,
 * polaryzacji i zaszytego gradientu. Pozycji, wysokości ani rozstawu nie
 * rusza nigdy — zmiana wzoru nie ma prawa niczego przesunąć.
 *
 * Kierunek odwracany jest względem WŁASNEGO przodu obudowy (jej azymut, albo
 * azymut − 180 dla obudowy już odwróconej), więc ręcznie rozwachlowany rig
 * zachowuje swój wachlarz. Pozycja, której liczność nie zgadza się z długością
 * wzoru, zostaje nietknięta; wzór złożony z samych B jest odrzucany w całości,
 * bo to nie gradient, tylko cały rig obrócony tyłem.
 */
export function writeReversalPattern(
  members: Source[],
  pattern: boolean[],
  opts: {
    axis: ArrayAxis;
    placeTolM: number;
    forwardAzimuthDeg: number;
    reverseDelayS: number;
  },
): Source[] {
  const out = members.map((m) => ({ ...m, rotation: { ...m.rotation } }));
  if (!pattern.length || pattern.every(Boolean)) return out;
  const rel = relativePositions(members, opts.axis);
  const blocks = positionBlocks(members, opts.axis, opts.placeTolM);
  const sideways = blocksAreSideways(members, blocks, rel);
  const mid = patternCentre(blocks);
  const was = reversedFlags(members, opts.forwardAzimuthDeg);
  const fold = (deg: number) => {
    const d = ((deg % 360) + 360) % 360;
    return d > 180 ? d - 360 : d;
  };
  for (const bl of blocks) {
    // Ta sama kolejność co w odczycie (measureReversal) i w układzie
    // (layoutSources): w poprzek dla rzędu, w górę dla stosu — obudowa j wzoru
    // jest tą samą obudową we wszystkich trzech miejscach.
    const idx = blockMembers(bl, rel)
      .slice()
      .sort((a, b) => rowOrderKey(members[a], opts.axis, sideways) - rowOrderKey(members[b], opts.axis, sideways));
    if (idx.length !== pattern.length) continue;
    const mirror = mirroredAt(bl.centre - mid, sideways);
    idx.forEach((k, j) => {
      const want = pattern[mirror ? pattern.length - 1 - j : j];
      const c = out[k];
      const ownForward = fold(was[k] ? c.rotation.azimuthDeg - 180 : c.rotation.azimuthDeg);
      c.rotation.azimuthDeg = want ? ownForward + 180 : ownForward;
      c.invertPolarity = want;
      c.gradientDelayS = want && opts.reverseDelayS > 0 ? opts.reverseDelayS : undefined;
    });
  }
  return out;
}
