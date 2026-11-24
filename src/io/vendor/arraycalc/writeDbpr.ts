/**
 * The `.dbpr` row surgery itself, isolated from asset loading so it can be tested
 * in Node against the real template without a browser.
 *
 * See exporter.ts for why this is template-copy rather than build-from-scratch.
 */

import type { Database, SqlJsStatic } from 'sql.js';
import { toArrayCalcGeometry, type VendorModel } from '../internalModel';
import { arraycalcDeviceFor } from '../deviceMap';

/** The SUBS SourceGroup id in the shipped template. */
export const SUBS_GROUP_ID = 8;

/**
 * Written into the exported project's date fields instead of the export moment.
 * A generated file has no authoring session to record, and a fixed value keeps
 * two exports of the same project byte-comparable.
 */
const NEUTRAL_TIMESTAMP = '2000-01-01T00:00:00.000Z';

export function writeDbpr(
  SQL: SqlJsStatic,
  templateBytes: Uint8Array,
  model: VendorModel,
): Uint8Array {
  const db: Database = new SQL.Database(templateBytes);
  try {
    // Overwrite freed cells instead of leaving them in page slack. Without this
    // every DELETE and UPDATE below only unlinks its bytes, so the template's
    // old cabinets and its old ProjectInformation row would still be readable
    // in the exported file with a hex editor.
    db.run('PRAGMA secure_delete=ON');

    // 1. drop the template's sub cabinets
    const old = db.exec(`SELECT CabinetId FROM Cabinets WHERE SourceGroupId=${SUBS_GROUP_ID}`);
    const oldIds: number[] = old.length ? old[0].values.map((r) => Number(r[0])) : [];
    for (const id of oldIds) {
      db.run('DELETE FROM CabinetsAdditionalData WHERE CabinetId=?', [id]);
      db.run('DELETE FROM Cabinets WHERE CabinetId=?', [id]);
    }

    // 2. one Cabinets + one CabinetsAdditionalData row per source
    const maxRes = db.exec('SELECT COALESCE(MAX(CabinetId),0) FROM Cabinets');
    let nextId = (maxRes.length ? Number(maxRes[0].values[0][0]) : 0) + 1;

    const rel = model.groupRelativeDelayMs;
    let boxType = '';

    model.sources.forEach((s, i) => {
      const geo = toArrayCalcGeometry(s);
      const dev = arraycalcDeviceFor(s.btrSpeakerId).device;
      if (!boxType) boxType = dev.model;
      const cabId = nextId++;

      db.run(
        'INSERT INTO Cabinets (CabinetId, DeviceId, AmplifierChannel, SpeakerId, SourceGroupId,' +
          ' PositionIndex, OrderIndex, HorizontalAngle, VerticalAngle, RotationAngle, PivotAngle,' +
          ' Linked, OriginX, OriginY, OriginZ, HornRotationAngle)' +
          ' VALUES (?,0,0,?,?,?,1,?,0,0,0,0,?,?,?,-1)',
        [
          cabId,
          dev.speakerId,
          SUBS_GROUP_ID,
          i + 1,
          geo.horizontalAngle,
          geo.originX,
          geo.originY,
          geo.originZ,
        ],
      );

      // Delay is the TOTAL delay, in SECONDS — not the design delay.
      const totalS = (s.delay_ms + rel) / 1000;
      db.run(
        'INSERT INTO CabinetsAdditionalData (CabinetId, Name, ControllerSetup, SplayAngle,' +
          ' AlignmentToSubArrayTestPoint, CabinetsPerPosition, CompressionState,' +
          ' DraftSignalSourceDeviceId, DraftSignalSourceChannelNumber, Delay, Mute, Level,' +
          ' Switch1, Switch2, Switch3, Switch4, Switch5, PreviousObjectString, NextObjectString)' +
          " VALUES (?,?,0,0,0,1,0,NULL,NULL,?,?,?,0,0,0,-5.5,0.5,'','')",
        [cabId, dev.model, totalS, s.muted ? 1 : 0, s.gain_db],
      );
    });

    // 3. group and project metadata
    db.run('UPDATE SourceGroups SET Name=?, RelativeDelay=? WHERE SourceGroupId=?', [
      model.groupName,
      rel,
      SUBS_GROUP_ID,
    ]);
    db.run('UPDATE SourceGroupsAdditionalData SET BoxType=?, System=? WHERE SourceGroupId=?', [
      boxType || 'B2-SUB',
      'SUBs',
      SUBS_GROUP_ID,
    ]);
    // The template is a real ArrayCalc project, so its ProjectInformation row
    // carried whoever made it: an author name, a password hash and two session
    // timestamps. Setting only the project name left all of those in every file
    // this program has ever written, on every machine it runs on.
    //
    // The template itself has been scrubbed, so this is defence in depth: it
    // covers a future template that reintroduces them. Note it is SQL-level
    // only — an UPDATE frees the old cell rather than overwriting it, so the
    // bytes could still sit in page slack. `secure_delete` above is what makes
    // the clear reach the bytes.
    //
    // Empty strings rather than NULL: the vendor wrote non-null columns here and
    // this format has never been opened in real ArrayCalc, so the smaller change
    // is the safer one. The timestamps are a fixed epoch rather than the export
    // moment, which keeps two exports of the same project byte-comparable.
    db.run(
      'UPDATE ProjectInformation SET ProjectName=?, AuthorName=?, Password=?, Comment=NULL,' +
        ' ProjectDateTime=?, AuthorDateTime=?',
      [model.projectName, '', '', NEUTRAL_TIMESTAMP, NEUTRAL_TIMESTAMP],
    );

    const integrity = db.exec('PRAGMA integrity_check');
    const verdict = integrity.length ? String(integrity[0].values[0][0]) : 'unknown';
    if (verdict !== 'ok') {
      throw new Error(`Generated ArrayCalc database failed integrity_check: ${verdict}`);
    }

    return db.export();
  } finally {
    db.close();
  }
}
