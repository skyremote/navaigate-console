/** jsdom has no 2D canvas and logs "not implemented" on every getContext. Avatars cope with null, so say so quietly. */
export function silenceCanvas() {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
}
