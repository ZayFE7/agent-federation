export type MascotPose = Record<string, number>;
export interface MascotState {
  id: string;
  name: string;
  note: string;
  group: string;
  kind: string;
  duration: number;
  still: number;
  blinks: number[];
  write(t: number, o: MascotPose): void;
}
export const STATES: MascotState[];
export const BASE_KEYS: string[];
export function resetPose(o: MascotPose): void;
export function poseFor(
  state: MascotState,
  t: number,
  o: MascotPose,
): MascotPose;
export function resolveState(state: string | MascotState | number): MascotState;
export function drawMascot(
  ctx: CanvasRenderingContext2D,
  state: string | MascotState,
  t: number,
  options?: {
    width?: number;
    height?: number;
    pixelRatio?: number;
    background?: string;
    pose?: MascotPose;
  },
): void;
