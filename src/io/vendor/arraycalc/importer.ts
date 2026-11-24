/**
 * d&b ArrayCalc `.dbpr` importer.
 *
 * A .dbpr is plain SQLite, read here through sql.js (SQLite as WASM), loaded lazily
 * so neither it nor the reader is in the main bundle.
 */

import { VendorReadError, type VendorImporter } from '../importTypes';

export const arraycalcImporter: VendorImporter = {
  id: 'arraycalc-dbpr',
  label: 'd&b ArrayCalc',
  target: 'arraycalc',
  extensions: ['.dbpr'],
  application: 'ArrayCalc',

  canImport(file) {
    return /\.dbpr$/i.test(file.name);
  },

  async read(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length < 16 || new TextDecoder().decode(bytes.slice(0, 15)) !== 'SQLite format 3') {
      throw new VendorReadError('Not a SQLite database. An ArrayCalc .dbpr project was expected.');
    }
    const [initSqlJs, wasmUrl, { readDbpr }] = await Promise.all([
      import('sql.js').then((m) => m.default),
      import('sql.js/dist/sql-wasm.wasm?url').then((m) => m.default),
      import('./readDbpr'),
    ]);
    const SQL = await initSqlJs({ locateFile: () => wasmUrl });
    return readDbpr(SQL, bytes);
  },
};
