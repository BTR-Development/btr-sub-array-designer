import type { BTRProject } from '../core/types';

/**
 * Import/export plug-in contract.
 *
 * Only the native BTR JSON pair is implemented today, but every future
 * converter plugs in
 * here, so nothing outside this folder has to change to add one.
 */
export interface ProjectImporter {
  readonly id: string;
  readonly label: string;
  /** file extensions this importer claims, e.g. ['.json', '.btr.json'] */
  readonly extensions: string[];
  canImport(file: File): boolean;
  import(file: File): Promise<BTRProject>;
}

export interface ProjectExporter {
  readonly id: string;
  readonly label: string;
  readonly extension: string;
  readonly mimeType: string;
  export(project: BTRProject): Promise<Blob>;
}

export class ImportError extends Error {}
