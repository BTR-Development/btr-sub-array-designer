/// <reference lib="webworker" />
/**
 * Prediction worker. Keeps the grid solve off the main thread so dragging a
 * cabinet never freezes the UI.
 */
import { computeGrid } from '../engine/engine';
import type { GridRequest } from '../engine/types';

export interface WorkerRequest {
  jobId: number;
  request: GridRequest;
}

export interface WorkerResponse {
  jobId: number;
  nx: number;
  nv: number;
  xMin: number; xMax: number; vMin: number; vMax: number;
  spl: Float32Array;
  maxDb: number;
  refDb: number;
  minDb: number;
  bandPoints: number;
  computeMs: number;
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { jobId, request } = e.data;
  const r = computeGrid(request);
  const msg: WorkerResponse = { jobId, ...r };
  // transfer the buffer instead of copying it
  (self as unknown as Worker).postMessage(msg, [r.spl.buffer]);
};
