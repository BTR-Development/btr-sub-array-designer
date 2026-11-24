/**
 * Neutral model -> Soundvision `<physical_configuration>` plaintext XML.
 *
 * STRATEGY: template surgery, not serialisation from scratch.
 *
 * A Soundvision cluster carries roughly 2 KB of DSP defaults per enclosure (IIR
 * bands, FIR slots, contour and air filters) plus document-level machinery
 * (source_linkage, amplification, autofilter_results, version). None of that is
 * derivable from a source list, and inventing it risks a file the importer rejects.
 * So we start from a real decrypted export and regenerate only what scales with the
 * project — the group's clusters and the amplification blocks. Everything we do not
 * understand is preserved byte for byte.
 */

import type { VendorSource } from '../internalModel';
import { svPlacement, toSoundvisionGeometry } from '../internalModel';

export interface SvCluster {
  uid: string;
  name: string;
  model: string;
  preset: string;
  boxCount: number;
  /** XML numbers, already in Soundvision's file frame — see toSoundvisionGeometry */
  position: [number, number, number];
  /** XML orientation[1], i.e. the NEGATED BTR azimuth */
  azimuth: number;
  delayMs: number;
  gainDb: number;
  polarity: 1 | -1;
  /**
   * Klaster POZYCJI — kilka obudów w jednym klastrze, tak jak Soundvision
   * modeluje stos subów. Brak = dotychczasowy klaster jednej obudowy z szablonu.
   */
  stack?: SvStack;
}

/** Jedna obudowa w klastrze pozycji. */
export interface SvEnclosure {
  /** `horizontal` | `horizontal_cardioid` | `stacked` | `stacked_cardioid` */
  configuration: string;
  preset: string;
  delayMs: number;
  gainDb: number;
  inverted: boolean;
}

export interface SvStack {
  /** `horizontal_stacked` (rząd obok siebie) | `vertical_stacked` (stos) */
  configuration: string;
  deploymentOrientation: 0 | 1;
  enclosures: SvEnclosure[];
  /**
   * Wzmacniacz: 'cardioid' = jeden zestaw kanałów z presetem kardioidalnym
   * i wszystkimi obudowami jako sloty (KS28_60_C); 'per-box' = osobny zestaw
   * kanałów na obudowę z presetem obudowy, jak w szablonie.
   */
  amp: { kind: 'cardioid'; preset: string; slotOrder: number[] } | { kind: 'per-box' };
}

/**
 * Presety kardioidalne Soundvision, ZWERYFIKOWANE na pliku wzorcowym
 * (2026-10-22, "untitled corrected perfect result"): rząd KS28 na boku,
 * F F B F — obudowy przednie `horizontal` + KS28_60_C_F, odwrócona
 * `horizontal_cardioid` + KS28_60_C_R, wzmacniacz KS28_60_C. Gradient
 * kardioidy (d/c i odwrócenie fazy) realizuje PRESET: każda obudowa ma delay
 * 0 i polaryzację 0. Dla innych modeli niczego tu nie ma — nazw presetów się
 * nie zgaduje — i ich odwrócone obudowy idą dotychczasową drogą (klaster na
 * obudowę, kierunek + faza + gradient wprost).
 */
export const SV_CARDIOID_PRESETS: Record<string, { amp: string; front: string; rear: string }> = {
  KS28: { amp: 'KS28_60_C', front: 'KS28_60_C_F', rear: 'KS28_60_C_R' },
};

export interface SvDocument {
  groupName: string;
  clusters: SvCluster[];
}

/**
 * Deterministic RFC-4122-shaped uid. Deterministic rather than random so the same
 * project always yields the same file — which is what makes the output testable.
 * Soundvision only needs these unique and internally consistent.
 */
export function uidFor(seed: string): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const hex: string[] = [];
  let x = h >>> 0;
  for (let i = 0; i < 32; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    hex.push((x & 0xf).toString(16));
  }
  const g = hex.join('');
  const variant = ((parseInt(g[16], 16) & 0x3) | 0x8).toString(16);
  return `${g.slice(0, 8)}-${g.slice(8, 12)}-4${g.slice(13, 16)}-${variant}${g.slice(17, 20)}-${g.slice(20, 32)}`;
}

/** Soundvision-style float: mantissa + 'e' + sign + at least two exponent digits. */
function fmt(value: number, precision: number): string {
  return Number(value)
    .toExponential(precision)
    .replace(/e([+-])(\d)$/, 'e$10$2');
}
const fmt9 = (v: number) => fmt(v, 9); // positions and orientations
const fmt17 = (v: number) => fmt(v, 17); // delay and gain

/** XML text escaping for the few strings we inject. */
function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/**
 * Build the cluster list from neutral sources: one POSITION = one cluster (see
 * positionCluster); a cabinet that is no position of several = one single-box
 * cluster, as before.
 */
export function buildSvDocument(
  sources: VendorSource[],
  groupName: string,
  device: (s: VendorSource) => { model: string; preset: string },
  extraDelayMs = 0,
): SvDocument {
  /*
   * THE REVERSED CABINET GOES OUT FIRST
   *
   * Cluster order is channel order on the other side, and the rule for
   * these cardioid blocks is that the sub playing backwards is always on
   * channel 1 — it is the one box in a block that is patched and processed
   * differently, so it is the one that must be in a known place when somebody
   * is standing in front of an amplifier rack.
   *
   * Polarity is the marker rather than the heading, for the same reason the
   * array editor uses it: a reverse stack inverts the box it turns round, and
   * polarity cannot disagree with the cabinet the way a vote on headings can.
   * A project with no inverted cabinet keeps its original order exactly.
   */
  /*
   * POZYCJA TO KLASTER
   *
   * Obudowy jednej pozycji BTR (wspólny positionKey) wychodzą jako JEDEN
   * klaster z kilkoma obudowami — tak Soundvision modeluje stos subów, i tak
   * zbudowana jest pozycja w pliku wzorcowym. Klaster na obudowę dawał
   * w Soundvision 24 osobne skrzynie zamiast 6 urządzeń, a odwróconą obudowę
   * jako osobny klaster obrócony o 180° z ręcznym d/c i fazą, zamiast
   * obudowy `horizontal_cardioid` z presetem, który robi gradient sam.
   *
   * Obudowa bez pozycji (bez klucza albo sama w pozycji) idzie jak dotąd —
   * stąd wszystkie dotychczasowe eksporty i testy są bez zmian.
   */
  const order: string[] = [];
  const byPos = new Map<string, VendorSource[]>();
  for (const s of sources) {
    const k = s.positionKey ?? `solo|${s.id}`;
    const got = byPos.get(k);
    if (got) got.push(s);
    else {
      byPos.set(k, [s]);
      order.push(k);
    }
  }

  const solos: VendorSource[] = [];
  const stacks: Array<{ at: number; cluster: SvCluster }> = [];
  let stackNo = 0;
  order.forEach((k, at) => {
    const members = byPos.get(k)!;
    const built = members.length > 1 ? positionCluster(members, groupName, device, extraDelayMs, ++stackNo) : null;
    if (built) stacks.push({ at, cluster: built });
    else solos.push(...members);
  });

  const single = (s: VendorSource, i: number): SvCluster => {
    const geo = toSoundvisionGeometry(s);
    const d = device(s);
    return {
      uid: uidFor(`${groupName}:${s.id}:${i}`),
      name: s.name || `${d.model} ${i + 1}`,
      model: d.model,
      preset: d.preset,
      boxCount: 1,
      position: geo.position,
      azimuth: geo.orientation[1],
      // Soundvision has no group delay, so the module's common offset is baked in.
      delayMs: Math.round((s.delay_ms + extraDelayMs) * 10) / 10,
      gainDb: s.gain_db,
      polarity: s.polarity,
    };
  };
  // Pojedyncze obudowy: odwrócone pierwsze, jak dotąd (patrz wyżej).
  const ordered = [
    ...solos.filter((s) => s.polarity === -1),
    ...solos.filter((s) => s.polarity !== -1),
  ];
  const clusters = [...ordered.map(single), ...stacks.map((x) => x.cluster)];
  return { groupName, clusters };
}

/** stopnie złożone do 0..180, jak w panelu */
function orientationOf(rollDeg: number): number {
  return ((Math.round(rollDeg) % 180) + 180) % 180;
}

/**
 * Klaster jednej pozycji, albo null, gdy pozycji nie da się uczciwie zapisać
 * jako jednego klastra Soundvision — wtedy jej obudowy idą pojedynczo.
 *
 *   - rząd na boku (roll 90): `horizontal_stacked` ("Rows"), deployment 1
 *     ("Vertical"), obudowy `horizontal` / `horizontal_cardioid`;
 *   - stos (roll 0): `vertical_stacked` ("Columns"), deployment 0, obudowy
 *     `stacked` / `stacked_cardioid` — token i connection_sets ze stosu, który
 *     Soundvision zapisał sam (probe6, 24.10.2026).
 *
 * Odwrócona obudowa dostaje presety kardioidalne tylko dla modeli
 * z SV_CARDIOID_PRESETS. Null dla: mieszanych modeli; mieszanych orientacji;
 * odwróconej obudowy modelu bez zweryfikowanych presetów.
 */
function positionCluster(
  members: VendorSource[],
  groupName: string,
  device: (s: VendorSource) => { model: string; preset: string },
  extraDelayMs: number,
  n: number,
): SvCluster | null {
  const d = device(members[0]);
  if (members.some((m) => device(m).model !== d.model)) return null;
  const ori = members.map((m) => orientationOf(m.roll_deg));
  if (ori.some((o) => o !== ori[0])) return null;
  const row = ori[0] === 90;
  const anyReversed = members.some((m) => m.reversed);
  const card = SV_CARDIOID_PRESETS[d.model];
  if (anyReversed && !card) return null;

  // Przód pozycji: kierunek obudów nieodwróconych.
  const fwd = (members.find((m) => !m.reversed) ?? members[0]).yaw_deg;
  const a = (fwd * Math.PI) / 180;
  // Kolejność obudów w klastrze, ZMIERZONA w Soundvision: w rzędzie #1 to
  // obudowa na końcu +X przy azymucie 0 — prawa ręka kogoś, kto stoi za
  // obudowami twarzą do widowni, (cos a, −sin a) — i numeracja idzie ku −X;
  // w stosie #1 jest na dole.
  const across = (m: VendorSource) => m.x_m * Math.cos(a) - m.y_m * Math.sin(a);
  const sorted = [...members].sort((p, q) => (row ? across(q) - across(p) : p.z_m - q.z_m));

  // Punkt odniesienia klastra: środek PRZEDNIEJ ściany pozycji na jej dole —
  // środek rzędu (stosu) w planie, przesunięty o pół głębokości do przodu.
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const cx = row ? (first.x_m + last.x_m) / 2 : sorted.reduce((t, m) => t + m.x_m, 0) / sorted.length;
  const cy = row ? (first.y_m + last.y_m) / 2 : sorted.reduce((t, m) => t + m.y_m, 0) / sorted.length;
  const bottom = Math.min(...sorted.map((m) => (m.heightM == null ? m.z_m : m.z_m - m.heightM / 2)));
  const depth = sorted.find((m) => m.depthM != null)?.depthM ?? 0;
  const at = svPlacement(cx + (depth / 2) * Math.sin(a), cy + (depth / 2) * Math.cos(a), bottom, fwd);

  const cardioid = anyReversed && !!card;
  // Delay projektowy obudowy. Na ścieżce kardioidalnej BEZ zaszytego gradientu:
  // preset _C_R robi go sam, dostałby go drugi raz.
  const design = (m: VendorSource) =>
    m.delay_ms + extraDelayMs - (cardioid && m.reversed ? m.gradient_ms ?? 0 : 0);
  const delays = sorted.map(design);
  const common = Math.min(...delays);
  const gains = sorted.map((m) => m.gain_db);
  const sameGain = gains.every((g) => Math.abs(g - gains[0]) < 1e-9);

  const enclosures: SvEnclosure[] = sorted.map((m, i) => ({
    configuration: (row ? 'horizontal' : 'stacked') + (cardioid && m.reversed ? '_cardioid' : ''),
    preset: cardioid ? (m.reversed ? card!.rear : card!.front) : d.preset,
    delayMs: Math.round((delays[i] - common) * 10) / 10,
    gainDb: sameGain ? 0 : m.gain_db,
    // Na ścieżce kardioidalnej fazę odwróconej robi preset; polaryzację
    // zapisuje się tylko obudowie przedniej, którą ktoś odwrócił ręcznie.
    inverted: cardioid && m.reversed ? false : m.polarity === -1,
  }));

  // Sloty wzmacniacza: odwrócone pierwsze (reguła: sub grający
  // do tyłu zawsze na kanale 1), dalej obudowy w dół od pierwszej odwróconej,
  // potem w górę — kolejność ze wzorca (tam [2, 1, 0, 3]; we wzorcu
  // obraz był lustrzany, więc dziś ta sama pozycja to F B F F -> [1, 0, 2, 3]).
  // Kolejność slotów nie zmienia predykcji; jest dla człowieka przy racku.
  const rev = enclosures.map((_, i) => i).filter((i) => sorted[i].reversed);
  const firstRev = rev.length ? rev[0] : 0;
  const below = enclosures.map((_, i) => i).filter((i) => !sorted[i].reversed && i < firstRev).reverse();
  const above = enclosures.map((_, i) => i).filter((i) => !sorted[i].reversed && i > firstRev);
  const slotOrder = [...rev, ...below, ...above];

  return {
    uid: uidFor(`${groupName}:pos:${members.map((m) => m.id).join(',')}`),
    name: `${d.model} ${n}`,
    model: d.model,
    preset: cardioid ? card!.amp : d.preset,
    boxCount: sorted.length,
    position: at.position,
    azimuth: at.orientation[1],
    delayMs: Math.round(common * 10) / 10,
    gainDb: sameGain ? gains[0] : 0,
    polarity: 1,
    stack: {
      configuration: row ? 'horizontal_stacked' : 'vertical_stacked',
      deploymentOrientation: row ? 1 : 0,
      enclosures,
      // Rząd i stos tak samo: jeden zestaw kanałów KS28_60_C. Sprawdzone
      // w Soundvision 25.10 — stos bez `<unit>` wczytuje się bez wzmacniacza,
      // a z pustym `<units></units>` plik jest odrzucany ("Failed to parse").
      amp: cardioid ? { kind: 'cardioid', preset: card!.amp, slotOrder } : { kind: 'per-box' },
    },
  };
}

/** The span of `<cluster>` elements that are the group's direct children. */
function groupChildrenSpan(tpl: string) {
  const marker = '<ip>1</ip><children>';
  const start = tpl.indexOf(marker);
  if (start < 0) throw new Error('Soundvision template: group children marker not found.');
  const open = start + marker.length;
  const close = tpl.indexOf('</children><acoustics>', open);
  if (close < 0) throw new Error('Soundvision template: group children close not found.');
  return { open, close };
}

function buildClusterXml(baseCluster: string, enclosureTpl: string, c: SvCluster): string {
  let x = baseCluster;
  x = x.replace(/^(<cluster><uid>)[0-9a-f-]+(<\/uid>)/, `$1${c.uid}$2`);
  x = x.replace(/(<name>)[^<]*(<\/name>)/, `$1${esc(c.name)}$2`);
  x = x.replace(/(<position>)[^<]*(<\/position>)/, `$1${c.position.map(fmt9).join(' ')}$2`);
  x = x.replace(
    /(<orientation>)[^<]*(<\/orientation>)/,
    `$1${[fmt9(0), fmt9(c.azimuth), fmt9(0)].join(' ')}$2`,
  );

  if (c.stack) {
    // Klaster pozycji: każda obudowa ze swoją konfiguracją, presetem
    // i akustyką (delay/gain/faza względem klastra).
    const st = c.stack;
    const encs = st.enclosures
      .map((e) => {
        let enc = enclosureTpl;
        enc = enc.replace(/(<preset>)[^<]*(<\/preset>)/g, `$1${esc(e.preset)}$2`);
        enc = enc.replace(/(<model>)[^<]*(<\/model>)/g, `$1${esc(c.model)}$2`);
        enc = enc.replace(/(<configuration>)[^<]*(<\/configuration>)/, `$1${esc(e.configuration)}$2`);
        enc = enc.replace(
          /(<acoustics><delay>)[^<]*(<\/delay><gain>)[^<]*(<\/gain><inverted>)[01](<\/inverted><filters>)/,
          `$1${fmt17(e.delayMs)}$2${fmt17(e.gainDb)}$3${e.inverted ? 1 : 0}$4`,
        );
        return enc;
      })
      .join('');
    x = x.replace(/<elements>[\s\S]*<\/elements>/, `<elements>${encs}</elements>`);
    x = x.replace(
      /(<configuration>)[^<]*(<\/configuration><deployment_orientation>)[01](<\/deployment_orientation>)/,
      `$1${esc(st.configuration)}$2${st.deploymentOrientation}$3`,
    );
    // n wpisów, jak u Soundvision: pierwszy pusty, dalej w rzędzie para
    // sąsiadów ("horizontal/horizontal_cardioid"), a w stosie konfiguracja
    // samej obudowy ("stacked", "stacked_cardioid") — oba zapisane przez
    // Soundvision.
    const cfg = st.enclosures.map((e) => e.configuration);
    const cs = cfg
      .map((v, i) =>
        i === 0
          ? '<connection_set></connection_set>'
          : `<connection_set>${st.configuration === 'horizontal_stacked' ? `${esc(cfg[i - 1])}/${esc(v)}` : esc(v)}</connection_set>`,
      )
      .join('');
    x = x.replace(/<connection_sets>[\s\S]*?<\/connection_sets>/, `<connection_sets>${cs}</connection_sets>`);
    const ia = cfg.map((_, i) => (i === 0 ? '<angle></angle>' : `<angle>${fmt9(0)}</angle>`)).join('');
    x = x.replace(/<inter_angles>[\s\S]*?<\/inter_angles>/, `<inter_angles>${ia}</inter_angles>`);
  } else {
    let enc = enclosureTpl;
    enc = enc.replace(/(<preset>)[^<]*(<\/preset>)/g, `$1${esc(c.preset)}$2`);
    enc = enc.replace(/(<model>)[^<]*(<\/model>)/g, `$1${esc(c.model)}$2`);
    x = x.replace(/<elements>[\s\S]*<\/elements>/, `<elements>${enc.repeat(c.boxCount)}</elements>`);

    const cs = [
      '<connection_set></connection_set>',
      ...Array(Math.max(0, c.boxCount - 1)).fill('<connection_set>stacked</connection_set>'),
    ].join('');
    x = x.replace(/<connection_sets>[\s\S]*?<\/connection_sets>/, `<connection_sets>${cs}</connection_sets>`);
  }

  // the cluster's own model string (outside <elements>)
  x = x.replace(/(<cluster><uid>[0-9a-f-]+<\/uid><name>[^<]*<\/name><model>)[^<]*(<\/model>)/, `$1${esc(c.model)}$2`);

  // The cluster-level acoustics block is the one carrying <source_usage>. Every
  // enclosure has its own zero-filled acoustics block BEFORE it, so anchoring on
  // <source_usage> is what keeps the delay/gain out of the wrong block.
  x = x.replace(
    /(<acoustics><delay>)[^<]*(<\/delay><gain>)[^<]*(<\/gain><inverted>)[01](<\/inverted><source_usage>)/,
    `$1${fmt17(c.delayMs)}$2${fmt17(c.gainDb)}$3${c.polarity === -1 ? 1 : 0}$4`,
  );
  return x;
}

/** LA12X ma 4 wyjścia: tyle obudów (albo slotów) mieści jeden wzmacniacz. */
const LA12X_OUTPUTS = 4;

function buildUnitsXml(clusters: SvCluster[]): string {
  let ip = 0;
  return clusters
    .map((c) => {
      const amp = c.stack?.amp;
      if (amp && amp.kind === 'cardioid') {
        // Wzorzec: jeden zestaw kanałów z presetem kardioidalnym i obudowami
        // jako sloty w kolejności slotOrder. Ponad 4 obudowy — kolejny LA12X.
        const units: string[] = [];
        for (let k = 0; k < amp.slotOrder.length; k += LA12X_OUTPUTS) {
          const slots = amp.slotOrder
            .slice(k, k + LA12X_OUTPUTS)
            .map((i) => `<slot><source><uid>${c.uid}</uid><indices>${i}</indices></source></slot>`)
            .join('');
          units.push(
            `<unit><model>LA12X</model><ip>${++ip}</ip><channelSet><firstOutput>0</firstOutput>` +
              `<preset>${esc(amp.preset)}</preset>${slots}</channelSet></unit>`,
          );
        }
        return units.join('');
      }
      // Szablon: zestaw kanałów na obudowę, preset obudowy. Ponad 4 — kolejny LA12X.
      const presetAt = (i: number) => (c.stack ? c.stack.enclosures[i].preset : c.preset);
      const units: string[] = [];
      for (let k = 0; k < c.boxCount; k += LA12X_OUTPUTS) {
        const chans = Array.from({ length: Math.min(LA12X_OUTPUTS, c.boxCount - k) }, (_, j) => {
          const i = k + j;
          return (
            `<channelSet><firstOutput>${j}</firstOutput><preset>${esc(presetAt(i))}</preset>` +
            `<slot><source><uid>${c.uid}</uid><indices>${i}</indices></source></slot></channelSet>`
          );
        }).join('');
        units.push(`<unit><model>LA12X</model><ip>${++ip}</ip>${chans}</unit>`);
      }
      return units.join('');
    })
    .join('');
}

function buildClusterParamsXml(clusters: SvCluster[]): string {
  return clusters
    .map(
      (c, i) =>
        `<cluster refId="${i + 1}"><clusterParameters><unitModel>LA12X</unitModel>` +
        // 2 dla klastra kardioidalnego — tak zapisał go Soundvision we wzorcu.
        `<unitOperatingMode>SE</unitOperatingMode><parallelChains/><nparallelMode>${c.stack?.amp.kind === 'cardioid' ? 2 : 0}</nparallelMode>` +
        `<nparallelValue>1</nparallelValue></clusterParameters></cluster>`,
    )
    .join('');
}

/** Produce the full plaintext XML for `doc`, using a decrypted golden file as template. */
export function writeSoundvisionXml(doc: SvDocument, template: string): string {
  const enclosureTpl = (template.match(/<enclosure>[\s\S]*?<\/enclosure>/) || [])[0];
  if (!enclosureTpl) throw new Error('Soundvision template: no <enclosure> block found.');

  const allClusters = template.match(/<cluster><uid>[\s\S]*?<\/cluster>/g) || [];
  const base = allClusters.find((c) => (c.match(/<enclosure>/g) || []).length === 1);
  if (!base) throw new Error('Soundvision template: no single-enclosure cluster to clone.');

  const clustersXml = doc.clusters.map((c) => buildClusterXml(base, enclosureTpl, c)).join('');

  const { open, close } = groupChildrenSpan(template);
  let out = template.slice(0, open) + clustersXml + template.slice(close);

  // The group's uid is replaced along with its name. Cluster uids were already
  // regenerated from the project; this one was not, so the template's own uid —
  // a constant from the Soundvision file the template was taken from — went out
  // in every export ever written, a stable fingerprint tying them all to one
  // source document. Nothing else in the file references it, so it is free to
  // derive from the project the way the clusters do.
  out = out.replace(
    /(<group><uid>)[0-9a-f-]+(<\/uid><name>)[^<]*(<\/name>)/,
    `$1${uidFor(`group:${doc.groupName}`)}$2${esc(doc.groupName)}$3`,
  );
  out = out.replace(
    /(<clustersToParameters>)[\s\S]*?(<\/clustersToParameters>)/,
    `$1${buildClusterParamsXml(doc.clusters)}$2`,
  );
  out = out.replace(/(<units>)[\s\S]*?(<\/units>)/, `$1${buildUnitsXml(doc.clusters)}$2`);

  return out;
}
