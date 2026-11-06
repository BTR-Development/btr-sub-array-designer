/**
 * Trafianie kliknięciem w obudowę w widoku 3D.
 *
 * Osobny plik, bo to czysta geometria — tak jak `camera3d` i `box3d`, obok
 * których stoi. Trzymanie jej w komponencie psuło szybkie odświeżanie modułu
 * i mieszało rysowanie z liczeniem.
 */
import { basisOf, depthOf, project, type Viewport3D } from './camera3d';
import { cabinetFaces, facesCamera, type BoxSize, type Face3D, type Rotation3D } from './box3d';
import type { Vec3 } from '../core/types';

export interface PickableBox {
  id: string;
  position: Vec3;
  rotation: Rotation3D;
  size: BoxSize;
}

/**
 * Która obudowa jest pod kursorem.
 *
 * Rzut jest ortograficzny, a obudowa wypukła, więc wystarczy sprawdzić ściany
 * zwrócone do obserwatora: jeżeli punkt leży w którejkolwiek z nich, leży na
 * obudowie. Z trafionych wygrywa NAJBLIŻSZA kamerze, bo inaczej kliknięcie w
 * gęstym rigu wybierałoby obudowę zasłoniętą przez tę, w którą się celowało.
 *
 * Liczone z tej samej geometrii, z której rysuje widok — `cabinetFaces` na
 * ramce silnika — więc trafienie nie może się rozjechać z obrazem.
 */
export function pickCabinet(
  vp: Viewport3D,
  basis: ReturnType<typeof basisOf>,
  boxes: PickableBox[],
  px: number,
  py: number,
): string | null {
  let best: string | null = null;
  let bestDepth = Infinity;
  for (const b of boxes) {
    for (const f of cabinetFaces(b.position, b.rotation, b.size)) {
      if (!facesCamera(f.normal, basis.dir)) continue;
      const poly = f.corners.map((c) => project(vp, c, basis));
      if (!pointInPolygon(px, py, poly)) continue;
      const d = depthOf(vp.cam, faceCentre(f), basis);
      if (d < bestDepth) {
        bestDepth = d;
        best = b.id;
      }
    }
  }
  return best;
}

/** Zwykły test parzystości przecięć; wielokąt jest czworokątem. */
function pointInPolygon(x: number, y: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}


function faceCentre(f: Face3D): Vec3 {
  return f.corners.reduce(
    (a, c) => ({ x: a.x + c.x / 4, y: a.y + c.y / 4, z: a.z + c.z / 4 }),
    { x: 0, y: 0, z: 0 },
  );
}
