// Binaries a model may see as a hash and still land, in the package review and the tap surface scan.
// A matching extension is not enough: the bytes have to start as that format. A name is no proof
// (require("./asset.png") runs a NUL-bearing script). Any other added or changed binary holds.

const bytesAre = (b: Uint8Array, at: number, sig: (number | string)[]) => {
  const want = sig.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x]));
  return b.length >= at + want.length && want.every((v, i) => b[at + i] === v);
};

/** One list for review.ts and apply/surface.ts. Do not copy it. */
export const BENIGN_BINARY: [RegExp, (b: Uint8Array) => boolean][] = [
  [/\.png$/i, (b) => bytesAre(b, 0, [0x89, "PNG\r\n", 0x1a, "\n"])],
  [/\.jpe?g$/i, (b) => bytesAre(b, 0, [0xff, 0xd8, 0xff])],
  [/\.gif$/i, (b) => bytesAre(b, 0, ["GIF87a"]) || bytesAre(b, 0, ["GIF89a"])],
  [/\.ico$/i, (b) => bytesAre(b, 0, [0, 0, 1, 0])],
  [/\.icns$/i, (b) => bytesAre(b, 0, ["icns"])],
  [/\.webp$/i, (b) => bytesAre(b, 0, ["RIFF"]) && bytesAre(b, 8, ["WEBP"])],
  [/\.bmp$/i, (b) => bytesAre(b, 0, ["BM"])],
  [/\.pdf$/i, (b) => bytesAre(b, 0, ["%PDF-"])],
  [/\.(ttf|otf)$/i, (b) => bytesAre(b, 0, [0, 1, 0, 0]) || bytesAre(b, 0, ["OTTO"]) || bytesAre(b, 0, ["true"])],
  [/\.eot$/i, (b) => bytesAre(b, 34, ["LP"])],
  [/\.woff$/i, (b) => bytesAre(b, 0, ["wOFF"])],
  [/\.woff2$/i, (b) => bytesAre(b, 0, ["wOF2"])],
];

export function benignBinary(path: string, bytes: Uint8Array | undefined): boolean {
  const kind = BENIGN_BINARY.find(([re]) => re.test(path));
  return !!kind && !!bytes && kind[1](bytes);
}
