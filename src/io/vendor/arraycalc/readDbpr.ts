/**
 * ArrayCalc `.dbpr` -> neutral VendorScene.
 *
 * Reads only; it applies the coordinate transform into the neutral frame and the
 * delay convention, and nothing else. Device mapping happens later.
 *
 * DELAY — the trap, in reverse. `CabinetsAdditionalData.Delay` is the UI's
 * **Total dly.** column in SECONDS, so the design delay an operator typed is
 *
 *     design_ms = stored_s * 1000 - SourceGroups.RelativeDelay
 *
 * ArrayCalc stores that total with float noise — the golden project holds
 * 16.998053 ms for a design delay the operator set as 12.4 ms. Its UI works at
 * 0.1 ms, so the recovered design delay is rounded to 0.1 ms; anything the file
 * carried beyond that resolution is reported rather than dropped silently.
 *
 * COORDINATES — inverse of the confirmed export mapping:
 *
 *     x = -OriginY    lateral   CONFIRMED
 *     y =  OriginX    depth     sign unverified (no reference file has non-zero depth)
 *     z =  OriginZ    height    CONFIRMED
 *     yaw = -HorizontalAngle    CONFIRMED
 */

import type { Database, SqlJsStatic } from 'sql.js';
import type { VendorScene, VendorSceneGroup } from '../importTypes';
import { VendorReadError } from '../importTypes';
import type { VendorSource } from '../internalModel';

const REQUIRED_TABLES = ['SourceGroups', 'Cabinets', 'CabinetsAdditionalData'];

/** Round away float noise like 4.599999999999999 without losing real precision. */
function tidy(v: unknown, decimals = 9): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  const r = Number(n.toFixed(decimals));
  return Object.is(r, -0) ? 0 : r;
}

function rows(db: Database, sql: string): Record<string, unknown>[] {
  const res = db.exec(sql);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}

export function readDbpr(SQL: SqlJsStatic, bytes: Uint8Array): VendorScene {
  if (bytes.length < 16 || new TextDecoder().decode(bytes.slice(0, 15)) !== 'SQLite format 3') {
    throw new VendorReadError('Not a SQLite database. An ArrayCalc .dbpr project was expected.');
  }

  let db: Database;
  try {
    db = new SQL.Database(bytes);
  } catch (e) {
    throw new VendorReadError(`Could not open the database: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const tables = rows(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => String(r.name));
    for (const t of REQUIRED_TABLES) {
      if (!tables.includes(t)) {
        throw new VendorReadError(
          `Unrecognised ArrayCalc schema: required table "${t}" is missing (found ${tables.length} tables). Refusing to guess.`,
        );
      }
    }

    const warnings: string[] = [];
    const hasSgAdd = tables.includes('SourceGroupsAdditionalData');
    if (!hasSgAdd) warnings.push('SourceGroupsAdditionalData is missing: group system/box type will be unknown.');

    const projectName = tables.includes('ProjectInformation')
      ? ((rows(db, 'SELECT ProjectName FROM ProjectInformation')[0]?.ProjectName as string) ?? null)
      : null;

    const sgSql = hasSgAdd
      ? 'SELECT sg.SourceGroupId, sg.Name, sg.Type, sg.RelativeDelay, a.System, a.BoxType,' +
        ' a.OriginX AS gx, a.OriginY AS gy, a.OriginZ AS gz' +
        ' FROM SourceGroups sg LEFT JOIN SourceGroupsAdditionalData a USING(SourceGroupId)'
      : 'SELECT SourceGroupId, Name, Type, RelativeDelay, NULL AS System, NULL AS BoxType,' +
        ' 0 AS gx, 0 AS gy, 0 AS gz FROM SourceGroups';

    const cabs = rows(
      db,
      'SELECT c.CabinetId, c.SourceGroupId, c.PositionIndex, c.OrderIndex, c.OriginX, c.OriginY,' +
        ' c.OriginZ, c.HorizontalAngle, c.VerticalAngle, c.RotationAngle,' +
        ' a.Name, a.Level, a.Delay, a.Mute' +
        ' FROM Cabinets c LEFT JOIN CabinetsAdditionalData a USING(CabinetId)',
    );

    const groups: VendorSceneGroup[] = [];
    for (const sg of rows(db, sgSql)) {
      const gid = Number(sg.SourceGroupId);
      const rel = tidy(sg.RelativeDelay, 6);
      const mine = cabs.filter((c) => Number(c.SourceGroupId) === gid);
      if (!mine.length) continue;

      // A non-zero group origin has never been observed; both writers assume the
      // cabinet coordinates are absolute. Say so rather than silently applying it.
      const gOrigin = [tidy(sg.gx), tidy(sg.gy), tidy(sg.gz)];
      if (gOrigin.some((v) => v !== 0)) {
        warnings.push(
          `Group "${String(sg.Name)}" has a non-zero group origin (${gOrigin.join(', ')} m). ` +
            'Whether ArrayCalc offsets its cabinets by it is unconfirmed, so it was NOT applied.',
        );
      }

      mine.sort(
        (a, b) =>
          Number(a.PositionIndex) - Number(b.PositionIndex) ||
          Number(a.OrderIndex ?? 0) - Number(b.OrderIndex ?? 0) ||
          Number(a.CabinetId) - Number(b.CabinetId),
      );

      const sources: VendorSource[] = mine.map((c, i) => {
        if (c.Name == null) {
          warnings.push(`Cabinet ${String(c.CabinetId)} has no CabinetsAdditionalData row; level, delay and model are unknown.`);
        }
        const totalMs = tidy(Number(c.Delay ?? 0) * 1000, 6);
        const rawDesign = totalMs - rel;
        const design = Math.round(rawDesign * 10) / 10;
        if (Math.abs(rawDesign - design) > 0.01) {
          warnings.push(
            `Cabinet ${String(c.CabinetId)} has a delay of ${rawDesign.toFixed(4)} ms, finer than ` +
              `ArrayCalc's 0.1 ms UI resolution; it was rounded to ${design} ms.`,
          );
        }
        const vertical = tidy(c.VerticalAngle);
        if (vertical !== 0) {
          warnings.push(`Cabinet ${String(c.CabinetId)} has VerticalAngle ${vertical}°; no confirmed mapping exists, so it was dropped.`);
        }
        return {
          id: `ac-${gid}-${String(c.CabinetId)}`,
          name: `${String(sg.Name ?? 'SUB')} ${String(i + 1).padStart(2, '0')}`,
          btrSpeakerId: String(c.Name ?? ''), // vendor model name; resolved later
          x_m: tidy(-Number(c.OriginY ?? 0)),
          y_m: tidy(Number(c.OriginX ?? 0)),
          z_m: tidy(Number(c.OriginZ ?? 0)),
          yaw_deg: tidy(-Number(c.HorizontalAngle ?? 0)),
          pitch_deg: 0,
          roll_deg: 0,
          gain_db: tidy(c.Level, 3),
          delay_ms: design,
          polarity: 1, // .dbpr has no per-cabinet polarity column
          muted: Number(c.Mute ?? 0) === 1,
        };
      });

      const system = sg.System == null ? null : String(sg.System);
      const boxType = sg.BoxType == null ? null : String(sg.BoxType);
      groups.push({
        id: String(gid),
        name: String(sg.Name ?? `Group ${gid}`),
        system,
        boxType,
        relativeDelayMs: rel,
        // Heuristic only, for pre-ticking the picker: ArrayCalc's Type values are a
        // hypothesis, so this never gates the import.
        looksLikeSubs: system === 'SUBs' || Number(sg.Type) === 3,
        sources,
      });
    }

    if (!groups.length) throw new VendorReadError('The project contains no loudspeakers.');
    return { format: 'arraycalc', projectName, groups, warnings };
  } finally {
    db.close();
  }
}
