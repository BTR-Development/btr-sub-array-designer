import type { ProjectExporter, ProjectImporter } from './types';
import { btrJsonImporter, btrJsonExporter } from './btrJson';

/**
 * Add a converter here and it appears in the File menu — nothing else needs to
 * know about it.
 */
export const IMPORTERS: ProjectImporter[] = [btrJsonImporter];
export const EXPORTERS: ProjectExporter[] = [btrJsonExporter];

export function importerFor(file: File): ProjectImporter | undefined {
  return IMPORTERS.find((i) => i.canImport(file));
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
