import { soundvisionExporter } from './soundvision/exporter';
import { arraycalcExporter } from './arraycalc/exporter';
import { soundvisionImporter } from './soundvision/importer';
import { arraycalcImporter } from './arraycalc/importer';
import type { VendorExporter } from './types';
import type { VendorImporter } from './importTypes';

/** Foreign prediction-tool writers. Adding one touches nothing outside src/io/. */
export const VENDOR_EXPORTERS: VendorExporter[] = [soundvisionExporter, arraycalcExporter];

/** Foreign prediction-tool readers. */
export const VENDOR_IMPORTERS: VendorImporter[] = [soundvisionImporter, arraycalcImporter];

export function vendorExporterById(id: string): VendorExporter | undefined {
  return VENDOR_EXPORTERS.find((e) => e.id === id);
}

/** The reader that claims this file, if any. */
export function vendorImporterFor(file: File): VendorImporter | undefined {
  return VENDOR_IMPORTERS.find((i) => i.canImport(file));
}

/** Every extension the app can open, for the file picker. */
export function allImportExtensions(): string {
  return ['.btrsub', '.json', ...VENDOR_IMPORTERS.flatMap((i) => i.extensions)].join(',');
}
