/** Rectangle with all values normalized to 0..1 of its reference frame. */
export interface NRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Rotation = 0 | 90 | 180 | 270;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The live view canvas shows the camera image rotated by `rot`. "Display" coordinates are
 * normalized to the rotated, displayed image; "image" coordinates to the camera's unrotated
 * frame, which is what the camera APIs (autofocus point, output crop) expect.
 */
export function displayToImage(dx: number, dy: number, rot: Rotation): [number, number] {
  switch (rot) {
    case 90:
      return [dy, 1 - dx];
    case 180:
      return [1 - dx, 1 - dy];
    case 270:
      return [1 - dy, dx];
    default:
      return [dx, dy];
  }
}

export function imageToDisplay(ix: number, iy: number, rot: Rotation): [number, number] {
  switch (rot) {
    case 90:
      return [1 - iy, ix];
    case 180:
      return [1 - ix, 1 - iy];
    case 270:
      return [iy, 1 - ix];
    default:
      return [ix, iy];
  }
}

function mapRect(r: NRect, map: (a: number, b: number) => [number, number]): NRect {
  const [ax, ay] = map(r.x, r.y);
  const [bx, by] = map(r.x + r.w, r.y + r.h);
  const x = Math.min(ax, bx);
  const y = Math.min(ay, by);
  return { x, y, w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

export function rectDisplayToImage(r: NRect, rot: Rotation): NRect {
  return mapRect(r, (a, b) => displayToImage(a, b, rot));
}

export function rectImageToDisplay(r: NRect, rot: Rotation): NRect {
  return mapRect(r, (a, b) => imageToDisplay(a, b, rot));
}

/** Where an image of imgW x imgH lands inside a stage with `object-fit: contain`. */
export function containBox(stageW: number, stageH: number, imgW: number, imgH: number): Box {
  if (stageW <= 0 || stageH <= 0 || imgW <= 0 || imgH <= 0) {
    return { left: 0, top: 0, width: stageW, height: stageH };
  }
  const scale = Math.min(stageW / imgW, stageH / imgH);
  const width = imgW * scale;
  const height = imgH * scale;
  return { left: (stageW - width) / 2, top: (stageH - height) / 2, width, height };
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
