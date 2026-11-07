/**
 * SpeakerDataProvider decouples the simulation engine and the UI from wherever
 * speaker data actually comes from.
 *
 *   GLL  ->  authorized importer / preprocessing  ->  BTR normalized data  ->  engine
 *
 * The MVP ships one implementation (StaticSpeakerDataProvider) fed by the
 * built-in library plus the project's custom models. A future provider could
 * fetch from a server-side GLL preprocessing service without the engine
 * knowing anything changed.
 */

import type { SpeakerModel } from './schema';
import { BUILTIN_SPEAKERS } from './library';

export interface SpeakerDataProvider {
  readonly name: string;
  list(): SpeakerModel[];
  get(id: string): SpeakerModel | undefined;
}

export class StaticSpeakerDataProvider implements SpeakerDataProvider {
  readonly name = 'builtin';
  private index = new Map<string, SpeakerModel>();

  constructor(models: SpeakerModel[] = BUILTIN_SPEAKERS) {
    this.setModels(models);
  }

  setModels(models: SpeakerModel[]) {
    this.index = new Map(models.map((m) => [m.id, m]));
  }

  list(): SpeakerModel[] {
    return [...this.index.values()];
  }

  get(id: string): SpeakerModel | undefined {
    return this.index.get(id);
  }
}

/** Provider that overlays project-local custom models on top of the library. */
export class CompositeSpeakerDataProvider implements SpeakerDataProvider {
  readonly name = 'composite';
  private base: SpeakerDataProvider;
  private overlay: SpeakerModel[];

  constructor(base: SpeakerDataProvider, overlay: SpeakerModel[] = []) {
    this.base = base;
    this.overlay = overlay;
  }

  setOverlay(models: SpeakerModel[]) {
    this.overlay = models;
  }

  list(): SpeakerModel[] {
    const ids = new Set(this.overlay.map((m) => m.id));
    return [...this.overlay, ...this.base.list().filter((m) => !ids.has(m.id))];
  }

  get(id: string): SpeakerModel | undefined {
    return this.overlay.find((m) => m.id === id) ?? this.base.get(id);
  }
}

export const builtinProvider = new StaticSpeakerDataProvider();
