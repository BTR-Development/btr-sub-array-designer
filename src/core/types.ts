/**
 * BTR core data model.
 *
 * UNITS — the internal model is SI wherever it is meaningful:
 *   length   : metre  (m)
 *   time     : second (s)          <- delays are stored in SECONDS, UI shows ms
 *   angle    : degree (deg)        <- degrees, because every audio tool uses degrees
 *   frequency: hertz  (Hz)
 *   level    : decibel (dB)
 *
 * COORDINATE SYSTEM (right-handed, Z up)
 *   +X : stage right→left as drawn, "width" axis
 *   +Y : away from the stage, into the audience ("depth" axis)
 *   +Z : up
 *
 * ROTATION
 *   azimuthDeg   : 0 deg  => cabinet front points along +Y.
 *                  +90 deg => front points along +X.
 *                  front = ( sin(az)cos(el), cos(az)cos(el), sin(el) )
 *   elevationDeg : positive tilts the front upwards.
 *   rollDeg      : rotation about the front axis — the axis a cabinet is laid
 *                  on its side about. 90 deg stands a sub on its end face and
 *                  swaps the width and the height it occupies, which the
 *                  seating, the stack pitch, the footprint and the drawing all
 *                  follow through `orientedDimensions`. Exposed in the SUBS
 *                  panel as Orientation and in the Inspector as Roll.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Rotation {
  azimuthDeg: number;
  elevationDeg: number;
  rollDeg: number;
}

/** A single physical loudspeaker placed in the project. */
export interface Source {
  id: string;
  label: string;
  /** id of a SpeakerModel in the speaker library (incl. custom models). */
  speakerId: string;
  position: Vec3;
  rotation: Rotation;
  /** Relative level, 0 dB = nominal. Range enforced by UI: -100 .. 0 */
  levelDb: number;
  /** SECONDS. Negative values are allowed by the model. */
  delayS: number;
  invertPolarity: boolean;
  mute: boolean;
  groupId: string | null;
  /**
   * ZASZYTY delay gradientu kardioidy, w SEKUNDACH — poza kolumną delayów
   * użytkownika.
   *
   * Obudowa odwrócona w pozycji potrzebuje d/c względem swoich partnerek,
   * żeby gradient był gradientem. Trzymany w delayS, ten czas był na łasce
   * wszystkiego, co pisze kolumnę delayów: "Zastosuj delay" nadpisywał ją
   * czystym łukiem (dla rzędu obok siebie bez partnera współrzędnego — bez
   * gradientu), reset ją zerował, ręczna edycja go gubiła. Kardioida gasła
   * bez słowa, a w tabeli wyglądało to "porządnie": delay odwróconej równy
   * delayowi przedniej.
   *
   * Dlatego osobne pole: pisze je WYŁĄCZNIE maszyneria układu (wzór F/B,
   * odwrócenia, migracja przy Zastosuj delay), silnik dolicza je do delayu
   * obudwy, a kolumna Delay w tabeli pozostaje domeną użytkownika. W "Delay
   * całk." ten czas JEST widoczny — to liczba, którą wpisuje się do
   * procesora — tylko edytować go wprost nie można.
   */
  gradientDelayS?: number;
  /**
   * Trwała przynależność do POZYCJI arraya. Obudowy z tym samym kluczem są
   * jednym "master subem": jednym większym urządzeniem akustycznym, które
   * dostaje JEDEN czas opóźnienia względem łuku, liczony dla swojego środka.
   *
   * To jest fakt zapisany, nie pomiar. Pozycje czytane z samej geometrii
   * (klastrowanie po współrzędnych) rozpadały się w rękach: rozstawienie
   * 4 pozycji po 4 obudowy na mniejszej przestrzeni, niż potrzebują, zbliżało
   * je na szerokość obudowy i odczyt scalał rig w "1 pozycję × 16" — a wtedy
   * delay łuku szedł na każdą skrzynię osobno i kardioida wewnątrz pozycji
   * przestawała być kardioidą. Pomyłka w rozstawie ma prawo zsunąć pozycje,
   * nawet jedną w drugą; nie ma prawa zmienić tego, ILE ich jest.
   *
   * Opcjonalny: obudowa postawiona ręcznie nie ma klucza i wtedy odczyt wraca
   * do klastrowania geometrycznego, jak dotąd. Klucz jest nieprzezroczysty
   * i porównywany tylko na równość; pisze go layout.
   */
  positionKey?: string;
  /**
   * Obrót CAŁEJ pozycji w poziomie, stopnie, ta sama konwencja co azymut
   * (0 = +Y, dodatnio zgodnie ze wskazówkami zegara z góry). Wszystkie
   * obudowy jednej pozycji niosą tę samą liczbę.
   *
   * Pozycja obraca się jak jedna wielka obudowa: skrzynie przesuwają się
   * po okręgu wokół środka pozycji i każda dostaje ten sam przyrost
   * azymutu — a nie każda o swój kąt w miejscu, co rozsuwało rząd na boku
   * i wpychało skrzynie jedna w drugą. Zapisany, nie mierzony, bo przebudowa
   * układu (suwak rozstawu) odbudowuje pozycje od zera i musi wiedzieć, jak
   * je z powrotem obrócić.
   */
  positionYawDeg?: number;
}

/**
 * A group is a *transform + offset* over its members. It never rewrites the
 * members' own parameters, so ungrouping is lossless.
 */
export interface Group {
  id: string;
  name: string;
  /** Translation applied to every member. */
  offset: Vec3;
  /** Extra yaw applied to every member, about `anchor`, in the XY plane. */
  rotationOffsetDeg: number;
  /** World-space pivot used by rotationOffsetDeg. */
  anchor: Vec3;
  levelOffsetDb: number;
  delayOffsetS: number;
  mute: boolean;
  collapsed?: boolean;
}

export interface MeasurementPoint {
  id: string;
  name: string;
  position: Vec3;
}

export type PredictionPlane = 'top' | 'side';
export type Quality = 'draft' | 'normal' | 'high';
export type GroundModel = 'off' | 'rigid';
export type SplMode = 'relative' | 'absolute';

export interface PredictionArea {
  /**
   * Extents of the prediction rectangle on the drawn plane's own axes, in
   * metres. The names are historical: this pair is the HORIZONTAL axis, which is
   * X for plane='top' and Y for plane='side'.
   */
  xMin: number;
  xMax: number;
  /** Vertical axis of the drawn plane: Y for plane='top', Z for plane='side'. */
  vMin: number;
  vMax: number;
  /** Constant coordinate of the plane: Z for 'top', X for 'side'. */
  planeOffset: number;
}

export interface SimulationSettings {
  frequencyHz: number;
  temperatureC: number;
  /** Derived from temperature, cached here so files are self-describing. */
  speedOfSound: number;
  plane: PredictionPlane;
  area: PredictionArea;
  quality: Quality;
  ground: GroundModel;
  /**
   * Retained so older project files still parse. The app displays relative levels
   * only — there is no absolute-SPL mode and no UI for these.
   */
  splMode: SplMode;
  absoluteRefDb: number;
  /** dB below the peak that the colour ramp spans. Fixed; not user-facing. */
  dynamicRangeDb: number;
  /** 0 = smooth gradient. Kept for file compatibility; the app renders smooth. */
  dbPerDivision: number;
  /**
   * Averaging bandwidth as a fraction of an octave. 0 is a single tone, which
   * is what the app did before and what a null-hunting exercise still wants;
   * 1/3 is what a map meant to represent programme material should show.
   */
  bandOct: number;
  /**
   * Sygnał mapy. 'tone' — dotychczasowe zachowanie: częstotliwość z suwaka,
   * ewentualnie uśredniona w paśmie bandOct wokół niej. 'pink' — szum różowy
   * w paśmie pinkLoHz..pinkHiHz: ciśnienia liczone w punktach rozłożonych
   * równo w LOGARYTMIE częstotliwości i uśrednione MOCOWO. Równe kroki w
   * log f niosą w szumie różowym równą moc (gęstość ∝ 1/f), więc zwykła
   * średnia |p|² po takich punktach JEST ważeniem różowym — bez osobnych wag.
   */
  signal: 'tone' | 'pink';
  /** dolna krawędź pasma szumu różowego, Hz */
  pinkLoHz: number;
  /** górna krawędź pasma szumu różowego, Hz */
  pinkHiHz: number;
}

/**
 * Szum różowy wyrażony w języku silnika: środek geometryczny i szerokość
 * pasma w oktawach. Jedno miejsce, bo mapa, odczyt punktowy w Inspektorze
 * i nagłówek wykresu muszą mówić o tym samym paśmie.
 */
export function pinkBand(sim: Pick<SimulationSettings, 'pinkLoHz' | 'pinkHiHz'>): {
  centreHz: number;
  bandOct: number;
} {
  const lo = Math.max(1, Math.min(sim.pinkLoHz, sim.pinkHiHz));
  const hi = Math.max(lo * 1.0001, Math.max(sim.pinkLoHz, sim.pinkHiHz));
  return { centreHz: Math.sqrt(lo * hi), bandOct: Math.log2(hi / lo) };
}

export interface ProjectMeta {
  name: string;
  author?: string;
  notes?: string;
  createdAt?: string;
  modifiedAt?: string;
}

export interface BTRProject {
  format: string;
  version: number;
  project: ProjectMeta;
  sources: Source[];
  groups: Group[];
  measurementPoints: MeasurementPoint[];
  simulationSettings: SimulationSettings;
  /** Custom (user-defined) speaker models travel with the project. */
  customSpeakers: import('../speakers/schema').SpeakerModel[];
}

/**
 * 200 x 200 m, in the old 50 x 50 proportions: centred
 * across, 10 % behind the stage and 90 % in front of it. The grid keeps its
 * cell BUDGET (gridSize), so a bigger area costs no time — the cells grow
 * instead, about 0.8 m at Normal.
 */
export const DEFAULT_AREA: PredictionArea = {
  xMin: -100,
  xMax: 100,
  vMin: -20,
  vMax: 180,
  planeOffset: 0,
};

export function speedOfSoundFromTemp(tempC: number): number {
  // c = 331.3 * sqrt(1 + T/273.15) for dry air — the form the quantity actually
  // takes, since c goes as the square root of absolute temperature. The linear
  // 331.3 + 0.606*T that stood here is its tangent at 0 C, so it reads high
  // everywhere else: 0.21 m/s at 20 C and 0.81 m/s at 40 C. The exact form also
  // lands on the textbook 343.2 m/s at 20 C, where the tangent gave 343.42.
  //
  // Neither figure moves a sub array on its own - 0.2 m/s is 0.06 % of a delay,
  // 1.2 us on a 2 ms gradient - but the exact expression costs the same and
  // stops the error growing at the top of the range the temperature control
  // offers.
  return 331.3 * Math.sqrt(1 + tempC / 273.15);
}

export function defaultSimulationSettings(): SimulationSettings {
  return {
    frequencyHz: 63,
    temperatureC: 20,
    speedOfSound: speedOfSoundFromTemp(20),
    plane: 'top',
    area: { ...DEFAULT_AREA },
    quality: 'normal',
    ground: 'off',
    splMode: 'relative',
    absoluteRefDb: 140,
    dynamicRangeDb: 18,
    dbPerDivision: 0,
    bandOct: 0,
    signal: 'tone',
    // klasyczne pasmo subbasowe; krawędzie są do edycji przy wybranym szumie
    pinkLoHz: 25,
    pinkHiHz: 100,
  };
}

export const QUALITY_TARGET_CELLS: Record<Quality, number> = {
  draft: 14_000,
  normal: 60_000,
  high: 260_000,
};
