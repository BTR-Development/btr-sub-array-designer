import type { MessageKey } from '../../i18n';
import type { BTRProject } from '../../core/types';
import type { SpeakerDataProvider } from '../../speakers/provider';
import type { ExportDiagnostics } from './internalModel';
import type { VendorTarget } from './deviceMap';

export interface VendorExportOptions {
  /**
   * Write the native vendor product name where BTR has an equivalent, instead of
   * substituting the target's verified fallback. Off by default: only the fallback
   * device is backed by a real vendor file.
   */
  nativeModels?: boolean;
}

export interface VendorExportResult {
  blob: Blob;
  filename: string;
  diagnostics: ExportDiagnostics;
}

/**
 * A converter that writes a foreign prediction-tool file.
 *
 * Separate from `ProjectExporter` because these need the speaker provider (to map
 * devices), take options, and must report what they had to change — a plain
 * `project -> Blob` signature cannot express any of that.
 */
export interface VendorExporter {
  readonly id: string;
  readonly label: string;
  readonly target: VendorTarget;
  readonly extension: string;
  readonly mimeType: string;
  /** what the vendor application is called, for UI copy */
  readonly application: string;
  /** honest statement of how far this path has been verified */
  readonly verificationNote: MessageKey;

  /** Dry run: what would happen, without building a file. */
  describe(
    project: BTRProject,
    provider: SpeakerDataProvider,
    options?: VendorExportOptions,
  ): ExportDiagnostics;

  export(
    project: BTRProject,
    provider: SpeakerDataProvider,
    options?: VendorExportOptions,
  ): Promise<VendorExportResult>;
}

export function safeFilename(name: string, extension: string): string {
  const base = (name || 'export').replace(/[^\w\-. ]+/g, '_').trim() || 'export';
  return `${base}${extension}`;
}
