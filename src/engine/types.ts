import type { BalloonDataset, RadiatingElement } from '../speakers/schema';
import type { GroundModel, PredictionPlane, Vec3 } from '../core/types';

/**
 * The flattened form the simulation engine consumes. Group transforms and
 * speaker-library lookups are already resolved by the time we get here, so the
 * engine has no knowledge of groups, the UI, or where speaker data came from.
 */
export interface EngineSource {
  id: string;
  position: Vec3;
  azimuthDeg: number;
  elevationDeg: number;
  rollDeg: number;
  /** total relative level (source + group), dB */
  levelDb: number;
  /** total delay (source + group), SECONDS */
  delayS: number;
  invertPolarity: boolean;
  /** dB SPL at 1 m on axis when levelDb = 0 */
  refSplDb: number;
  /** null => omnidirectional point source */
  elements: RadiatingElement[] | null;
  normaliseOnAxis: boolean;
  balloon?: BalloonDataset;
  /**
   * Where this cabinet radiates from, in its LOCAL frame, relative to
   * `position`. The engine rotates it with the cabinet, so turning a box round
   * moves its acoustic origin — which is the entire mechanism behind a
   * reverse-stack cardioid. Absent or zero reproduces the old behaviour of a
   * dimensionless point at the handle. See speakers/schema.ts acousticOrigin.
   */
  originOffset?: { x: number; y: number; z: number } | null;
}

export interface GridRequest {
  sources: EngineSource[];
  frequencyHz: number;
  speedOfSound: number;
  plane: PredictionPlane;
  ground: GroundModel;
  /** horizontal (X) extents */
  xMin: number;
  xMax: number;
  /** vertical-axis extents: Y for 'top', Z for 'side' */
  vMin: number;
  vMax: number;
  /** constant coordinate: Z for 'top', Y for 'side' */
  planeOffset: number;
  nx: number;
  nv: number;
  /**
   * Cells closer than this to any source are excluded when picking the
   * reference level for the relative colour scale. Without it the 1/r
   * near-field spike right at a cabinet becomes "0 dB" and the whole audience
   * area renders 25-40 dB down. Metres; 0 disables the exclusion.
   */
  nearFieldExclusionM?: number;
  /**
   * Width of the averaging band as a fraction of an octave: 1/3 for a third
   * octave, 1 for a full octave. 0 or absent means a single tone at
   * `frequencyHz`, which is what the app did before band averaging existed.
   */
  bandOct?: number;
  /** Override for the number of frequencies evaluated; normally derived. */
  bandPoints?: number;
}

export interface GridResult {
  nx: number;
  nv: number;
  xMin: number;
  xMax: number;
  vMin: number;
  vMax: number;
  /** absolute SPL in dB (re 20 uPa) assuming the models' 1 m reference SPL */
  spl: Float32Array;
  /** true maximum over every cell, near field included */
  maxDb: number;
  /**
   * Reference for the relative scale: the loudest cell at least
   * `nearFieldExclusionM` away from every source. Equals maxDb when no cell
   * qualifies.
   */
  refDb: number;
  minDb: number;
  /** How many frequencies were actually summed. 1 for a single tone. */
  bandPoints: number;
  computeMs: number;
}

export interface SourceContribution {
  sourceId: string;
  distanceM: number;
  propagationDelayS: number;
  sourceDelayS: number;
  totalDelayS: number;
  /** degrees, wrapped to (-180, 180] */
  phaseDeg: number;
  /** dB, magnitude of this source alone at the receiver */
  magnitudeDb: number;
  directivityGainDb: number;
  re: number;
  im: number;
}

export interface PointResult {
  splDb: number;
  phaseDeg: number;
  re: number;
  im: number;
  contributions: SourceContribution[];
}
