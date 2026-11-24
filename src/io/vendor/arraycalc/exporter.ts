/**
 * BTR project -> d&b ArrayCalc `.dbpr`.
 *
 * A `.dbpr` is a plain SQLite 3 database shared by ArrayCalc and R1. It holds 53
 * tables: project metadata, simulation properties, views, R1 remote-control state and
 * a schema version per table. None of that is derivable from a source list, so we do
 * NOT build a database — we copy a real project and rewrite only the sub rows.
 *
 * What makes that safe (measured, not assumed):
 *   - sub cabinets have DeviceId = 0 and AmplifierChannel = 0, i.e. they are not
 *     patched to amplifiers, so no amp or patch table has to change;
 *   - every other table with a CabinetId column is empty in the reference projects,
 *     so there are no dangling references to maintain;
 *   - there is no checksum or signature over the file.
 *
 * The row surgery lives in writeDbpr.ts so it can be tested in Node. This module is
 * only the lazy loading of sql.js (SQLite as WASM) and the template, neither of which
 * belongs in the main bundle.
 */

import type { BTRProject } from '../../../core/types';
import type { SpeakerDataProvider } from '../../../speakers/provider';
import { toVendorModel, validateForTarget } from '../internalModel';
import { safeFilename, type VendorExporter, type VendorExportOptions } from '../types';

export const arraycalcExporter: VendorExporter = {
  id: 'arraycalc-dbpr',
  label: 'd&b ArrayCalc',
  target: 'arraycalc',
  extension: '.dbpr',
  mimeType: 'application/vnd.sqlite3',
  application: 'ArrayCalc',
  verificationNote: 'exp.noteArrayCalc',

  describe(project, provider) {
    return validateForTarget(toVendorModel(project, provider), 'arraycalc');
  },

  async export(project: BTRProject, provider: SpeakerDataProvider, _options?: VendorExportOptions) {
    void _options;
    const model = toVendorModel(project, provider);
    const diagnostics = validateForTarget(model, 'arraycalc');
    if (diagnostics.errors.length) {
      throw new Error(`Cannot export to ArrayCalc:\n  ${diagnostics.errors.join('\n  ')}`);
    }

    const [initSqlJs, wasmUrl, templateUrl, { writeDbpr }] = await Promise.all([
      import('sql.js').then((m) => m.default),
      import('sql.js/dist/sql-wasm.wasm?url').then((m) => m.default),
      import('../templates/arraycalc-template.dbpr?url').then((m) => m.default),
      import('./writeDbpr'),
    ]);

    const SQL = await initSqlJs({ locateFile: () => wasmUrl });
    const templateBytes = new Uint8Array(await (await fetch(templateUrl)).arrayBuffer());
    const bytes = writeDbpr(SQL, templateBytes, model);

    return {
      blob: new Blob([bytes as BlobPart], { type: this.mimeType }),
      filename: safeFilename(project.project.name, this.extension),
      diagnostics,
    };
  },
};
