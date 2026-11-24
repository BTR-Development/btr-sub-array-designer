/**
 * Soundvision `.xmlc` plaintext -> neutral VendorScene.
 *
 * Parsed with anchored regular expressions rather than a DOM, for the same reason
 * the writer uses template surgery: the document is deeply nested, and the fields we
 * need have exact, verified anchors. The important one:
 *
 *   Every `<enclosure>` carries its OWN zero-filled <delay>/<gain>/<inverted> block
 *   before the cluster-level one. Only the cluster's block is followed by
 *   <source_usage>, so that is what we anchor on. A looser pattern silently reads
 *   zeros — this cost the original reverse-engineering two false test passes.
 *
 * Coordinates go through fromSvPlacement — the inverse of the measured export
 * mapping (file (−x, z, y) of the front-face bottom centre, azimuth negated). The
 * front-face datum is undone in sceneToProject, which knows the cabinet depth.
 */

import type { VendorScene, VendorSceneGroup } from '../importTypes';
import { VendorReadError } from '../importTypes';
import type { VendorSource } from '../internalModel';
import { fromSvPlacement } from '../internalModel';

/** The cluster-level acoustics block, distinguished by its <source_usage> tail. */
const CLUSTER_ACOUSTICS =
  /<acoustics><delay>([^<]*)<\/delay><gain>([^<]*)<\/gain><inverted>([01])<\/inverted><source_usage>/;

function tidy(v: number, decimals = 9): number {
  const r = Number(v.toFixed(decimals));
  return Object.is(r, -0) ? 0 : r;
}

function num(s: string | undefined): number {
  const v = Number.parseFloat(String(s ?? ''));
  return Number.isFinite(v) ? v : 0;
}

function first(re: RegExp, hay: string): string | null {
  const m = hay.match(re);
  return m ? m[1] : null;
}

/** Every `<group>` in the document, with the span of its direct `<children>`. */
function groupSpans(xml: string): Array<{ uid: string; name: string; children: string }> {
  const out: Array<{ uid: string; name: string; children: string }> = [];
  const head = /<group><uid>([0-9a-f-]+)<\/uid><name>([^<]*)<\/name>/g;
  let m: RegExpExecArray | null;
  while ((m = head.exec(xml))) {
    const open = xml.indexOf('<children>', m.index);
    if (open < 0) continue;
    // the group's <children> is closed immediately before its own <acoustics> sibling
    const close = xml.indexOf('</children><acoustics>', open);
    if (close < 0) continue;
    out.push({ uid: m[1], name: m[2], children: xml.slice(open + '<children>'.length, close) });
  }
  if (out.length) return out;

  /*
   * A FILE THAT NEVER MADE A GROUP
   *
   * Soundvision only writes a <group> when the operator makes one. Save a
   * single stack — which is how anybody exports one configuration to send to
   * somebody else — and its cluster sits straight under the root <children>
   * with no group anywhere in the file.
   *
   * Read for groups alone, every one of those files was refused outright with
   * "The configuration contains no loudspeaker clusters", which is both wrong
   * and the opposite of what it looks like: the clusters are right there. The
   * root therefore stands in as an implicit group when no explicit one exists.
   */
  const root = xml.indexOf('<physical_configuration><children>');
  if (root < 0) return out;
  const from = root + '<physical_configuration><children>'.length;
  const body = xml.slice(from, lastIndexOrEnd(xml, '</children></physical_configuration>', from));
  if (!/<cluster><uid>/.test(body)) return out;
  return [{ uid: 'root', name: '', children: body }];
}

function lastIndexOrEnd(xml: string, needle: string, from: number): number {
  const i = xml.lastIndexOf(needle);
  return i >= from ? i : xml.length;
}

export function readSoundvisionXml(xml: string): VendorScene {
  if (!xml.includes('<physical_configuration>')) {
    throw new VendorReadError(
      'Not a Soundvision configuration: <physical_configuration> is missing.',
    );
  }

  const warnings: string[] = [];
  const groups: VendorSceneGroup[] = [];

  for (const g of groupSpans(xml)) {
    // clusters never nest, so a non-greedy match is safe inside the children span
    const clusters = g.children.match(/<cluster><uid>[\s\S]*?<\/cluster>/g) || [];
    if (!clusters.length) continue;

    const sources: VendorSource[] = [];
    clusters.forEach((c, ci) => {
      const name = first(/<name>([^<]*)<\/name>/, c) ?? `CLUSTER ${ci + 1}`;
      const model = first(/<model>([^<]*)<\/model>/, c) ?? '';
      const pos = (first(/<position>([^<]*)<\/position>/, c) ?? '0 0 0').trim().split(/\s+/);
      const ori = (first(/<orientation>([^<]*)<\/orientation>/, c) ?? '0 0 0').trim().split(/\s+/);
      const enclosures = Math.max(1, (c.match(/<enclosure>/g) || []).length);
      const at = fromSvPlacement(pos.map(num), ori.map(num));
      // "Rows" (horizontal_stacked): obudowy obok siebie, #1 na końcu +X;
      // deployment 1 ("Vertical") = obudowa na boku, w BTR roll 90.
      const row = /<configuration>horizontal_stacked<\/configuration>/.test(c);
      const onEnd = /<deployment_orientation>1<\/deployment_orientation>/.test(c);
      // Which enclosures the file says are turned round. Soundvision marks it
      // twice over — a `*_cardioid` configuration on the enclosure and an
      // `..._C_R` amplifier preset — and either is enough.
      const encBodies = c.match(/<enclosure>[\s\S]*?<\/enclosure>/g) || [];
      const reversedAt = encBodies.map(
        (e) => /<configuration>[^<]*cardioid[^<]*<\/configuration>/.test(e) || /<preset>[^<]*_C_R<\/preset>/.test(e),
      );

      const ac = c.match(CLUSTER_ACOUSTICS);
      if (!ac) {
        warnings.push(`Cluster "${name}" has no cluster-level acoustics block; level and delay were read as 0.`);
      }
      const delayMs = ac ? tidy(num(ac[1]), 4) : 0;
      const gainDb = ac ? tidy(num(ac[2]), 3) : 0;
      const inverted = ac ? ac[3] === '1' : false;

      const pitch = tidy(num(ori[0]));
      const roll = tidy(num(ori[2]));
      if (pitch !== 0 || roll !== 0) {
        warnings.push(
          `Cluster "${name}" has non-zero orientation components (${pitch}, ${roll}). ` +
            'Which of them is pitch and which is roll is unknown, so both were dropped.',
        );
      }

      for (let i = 0; i < enclosures; i++) {
        sources.push({
          id: `sv-${g.uid}-${ci}-${i}`,
          name: enclosures > 1 ? `${name} #${i + 1}` : name,
          btrSpeakerId: model, // vendor model name; resolved later
          x_m: tidy(at.refX),
          y_m: tidy(at.refY),
          z_m: tidy(at.bottomZ),
          yaw_deg: tidy(at.azimuthDeg),
          pitch_deg: 0,
          roll_deg: onEnd ? 90 : 0,
          frontRef: true,
          gain_db: gainDb,
          delay_ms: delayMs,
          polarity: inverted ? -1 : 1,
          muted: false,
          ...(enclosures > 1 ? { stack: { index: i, count: enclosures, layout: row ? 'row' : 'pile' } } : {}),
          cluster: { id: `${g.uid}-${ci}`, name, size: enclosures },
          ...(reversedAt[i] ? { reversed: true } : {}),
        });
      }

      if (enclosures > 1 && !row) {
        warnings.push(
          `Cluster "${name}" is a stack of ${enclosures} cabinets. Soundvision stores one ground ` +
            'position per cluster and derives the vertical spacing itself, so the per-box height ' +
            'was rebuilt from the cabinet height.',
        );
      }
    });

    const models = [...new Set(sources.map((s) => s.btrSpeakerId).filter(Boolean))];
    groups.push({
      id: g.uid,
      name: g.name || 'SUBS',
      system: null,
      boxType: models[0] ?? null,
      relativeDelayMs: 0, // Soundvision has no group delay
      looksLikeSubs: true,
      sources,
    });
  }

  if (!groups.length) throw new VendorReadError('The configuration contains no loudspeaker clusters.');
  return { format: 'soundvision', projectName: null, groups, warnings };
}
