/**
 * Trafianie kliknięciem w obudowę w widoku 3D.
 *
 * Geometria, nie wygląd: jeżeli to się rozjedzie z obrazem, operator klika
 * jedną obudowę, a zaznacza się inna — i dowie się o tym dopiero przy
 * sprawdzaniu, dlaczego zmiana poziomu trafiła nie tam. Liczone z tej samej
 * `cabinetFaces`, z której rysuje widok, i te przypadki tego pilnują.
 *
 * Czego tu NIE MA i dlaczego: odrzucania ścian odwróconych od kamery. Pudło
 * jest wypukłe, więc jego sylwetka na ekranie jest ta sama, czy liczyć trzy
 * ściany, czy sześć — ten filtr jest w kodzie oszczędnością, nie warunkiem
 * poprawności, i żaden przypadek tutaj nie padnie po jego usunięciu. Lepiej to
 * napisać, niż dopisać test, który przechodzi zawsze.
 */
import { describe, it, expect } from 'vitest';
import { pickCabinet } from './pick3d';
import { basisOf, project, DEFAULT_CAMERA, type Viewport3D } from './camera3d';

const KS28 = { widthM: 1.34, heightM: 0.55, depthM: 0.719 };
const upright = { azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 };
const vp: Viewport3D = { width: 800, height: 600, cam: { ...DEFAULT_CAMERA, target: { x: 0, y: 0, z: 0 } } };
const basis = basisOf(vp.cam);
const box = (id: string, x: number, y = 0, z = 0.275) => ({
  id, position: { x, y, z }, rotation: upright, size: KS28,
});

describe('co jest pod kursorem', () => {
  it('trafia w obudowę kliknięciem w jej środek', () => {
    const b = box('a', 0);
    const [px, py] = project(vp, b.position, basis);
    expect(pickCabinet(vp, basis, [b], px, py)).toBe('a');
  });

  it('nie trafia w nic obok rigu', () => {
    expect(pickCabinet(vp, basis, [box('a', 0)], 5, 5)).toBeNull();
    expect(pickCabinet(vp, basis, [box('a', 0)], 795, 595)).toBeNull();
  });

  it('wybiera obudowę z WIERZCHU, nie zasłoniętą', () => {
    // Dwie DOKŁADNIE jedna za drugą: druga przesunięta wzdłuż osi patrzenia,
    // więc rzutują się w ten sam punkt ekranu i naprawdę się zasłaniają.
    //
    // Pierwsza wersja tego przypadku stawiała je po prostu przed i za
    // słuchaczem — rzutowały się w RÓŻNE miejsca, każde kliknięcie trafiało
    // tylko w jedną, i test przechodził także wtedy, gdy wyrzuciłem z kodu
    // porównanie głębokości. Czyli nie sprawdzał niczego.
    const near = box('blisko', 0);
    const far = {
      ...box('daleko', 0),
      position: {
        x: near.position.x + basis.dir.x * 8,
        y: near.position.y + basis.dir.y * 8,
        z: near.position.z + basis.dir.z * 8,
      },
    };
    const [px, py] = project(vp, near.position, basis);
    const [fx, fy] = project(vp, far.position, basis);
    expect(fx).toBeCloseTo(px, 6);   // naprawdę jedna za drugą
    expect(fy).toBeCloseTo(py, 6);
    expect(pickCabinet(vp, basis, [far, near], px, py)).toBe('blisko');
    expect(pickCabinet(vp, basis, [near, far], px, py)).toBe('blisko');
  });

  it('rozróżnia sąsiadów w rzędzie', () => {
    const row = [box('l', -1.34), box('s', 0), box('p', 1.34)];
    for (const b of row) {
      const [px, py] = project(vp, b.position, basis);
      expect(pickCabinet(vp, basis, row, px, py), b.id).toBe(b.id);
    }
  });

  it('widzi obudowę leżącą na krótszej krawędzi tam, gdzie ona stoi', () => {
    const onEnd = { id: 'e', position: { x: 0, y: 0, z: 0.67 },
                    rotation: { ...upright, rollDeg: 90 }, size: KS28 };
    const [px, py] = project(vp, onEnd.position, basis);
    expect(pickCabinet(vp, basis, [onEnd], px, py)).toBe('e');
    // a metr w bok, poza jej 0.55 m szerokości, już nie
    const [ox] = project(vp, { x: 1.2, y: 0, z: 0.67 }, basis);
    expect(pickCabinet(vp, basis, [onEnd], ox, py)).toBeNull();
  });
});
