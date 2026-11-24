/**
 * Reading foreign prediction files.
 *
 * Both readers produce a `VendorScene`: the same neutral (= Soundvision) frame the
 * exporters consume, so import and export share one set of coordinate transforms and
 * one delay convention. A reader never maps devices or touches BTR state — that is
 * `sceneToProject`'s job.
 */

import type { VendorSource } from './internalModel';
import type { VendorTarget } from './deviceMap';

export interface VendorSceneGroup {
  id: string;
  name: string;
  /** the vendor's own classification, shown in the picker */
  system: string | null;
  boxType: string | null;
  /** ms — ArrayCalc's Delay (rel.); always 0 for Soundvision, which has no such field */
  relativeDelayMs: number;
  /**
   * Heuristic: does this group look like subwoofers? Used only to pre-tick the
   * import picker — the user always decides. ArrayCalc's group Type values are a
   * hypothesis, not confirmed semantics, so nothing branches on this.
   */
  looksLikeSubs: boolean;
  sources: VendorSource[];
}

export interface VendorScene {
  format: VendorTarget;
  projectName: string | null;
  groups: VendorSceneGroup[];
  /** anything the reader was unsure about; never a silent default */
  warnings: string[];
}

export class VendorReadError extends Error {}

export interface VendorImporter {
  readonly id: string;
  readonly label: string;
  readonly target: VendorTarget;
  readonly extensions: string[];
  readonly application: string;
  canImport(file: File): boolean;
  /** Parse to the neutral scene. Throws VendorReadError on an unrecognised file. */
  read(file: File): Promise<VendorScene>;
}
