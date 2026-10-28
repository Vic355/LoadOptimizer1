// How a carton stands in the load, so loaders do not have to guess it from a flat drawing.
// Faces of a carton: the top ("tutup", length × width, where the flaps and tape are), the long
// side (length × height) and the short side (width × height). Engine axes: dx runs towards the
// door, so the face a loader sees from the door is dy × dz.

/** A–F: which face is up and which faces the door. */
export type Pose = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

/** For each pose, the carton side (0 length, 1 width, 2 height) along the truck (dx), across it (dy) and up (dz). */
export const POSES: Record<Pose, [number, number, number]> = {
  A: [1, 0, 2], // upright, long side to the door
  B: [0, 1, 2], // upright, short side to the door
  C: [2, 0, 1], // lying on its long side, top to the door
  D: [0, 2, 1], // lying on its long side, short side to the door
  E: [2, 1, 0], // standing on its short side, top to the door
  F: [1, 2, 0], // standing on its short side, long side to the door
};

/** The pose of a placed carton of size [length, width, height]; the first that matches when sides are equal. */
export function poseOf(box: { dx: number; dy: number; dz: number }, dims: [number, number, number]): Pose {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  for (const [pose, [ax, ay, az]] of Object.entries(POSES) as [Pose, [number, number, number]][])
    if (near(box.dx, dims[ax]) && near(box.dy, dims[ay]) && near(box.dz, dims[az])) return pose;
  return 'A';
}
