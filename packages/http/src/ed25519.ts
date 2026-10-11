const P = 2n ** 255n - 19n;

interface Point {
  x: bigint;
  y: bigint;
}

const mod = (a: bigint): bigint => ((a % P) + P) % P;

function pow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  for (let e = exp; e > 0n; e >>= 1n) {
    if ((e & 1n) === 1n) result = (result * b) % P;
    b = (b * b) % P;
  }
  return result;
}

const inv = (a: bigint): bigint => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

function rootOf(u: bigint, v: bigint): bigint | null {
  const x = mod(u * pow(v, 3n) * pow(mod(u * pow(v, 7n)), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  if (vx2 === u) return x;
  return vx2 === mod(-u) ? mod(x * SQRT_M1) : null;
}

function decode(bytes: Buffer): Point | null {
  if (bytes.length !== 32) return null;
  const last = bytes[31] ?? 0;
  const sign = BigInt(last >> 7);
  const copy = Buffer.from(bytes);
  copy[31] = last & 0x7f;
  const y = BigInt(`0x${copy.reverse().toString('hex')}`);
  if (y >= P) return null;
  const y2 = (y * y) % P;
  const x = rootOf(mod(y2 - 1n), mod(D * y2 + 1n));
  if (x === null || (x === 0n && sign === 1n)) return null;
  return { x: (x & 1n) === sign ? x : mod(-x), y };
}

function add(a: Point, b: Point): Point {
  const t = mod(D * a.x * b.x * a.y * b.y);
  return { x: mod((a.x * b.y + a.y * b.x) * inv(mod(1n + t))), y: mod((a.y * b.y + a.x * b.x) * inv(mod(1n - t))) };
}

export function strongEd25519(raw: Buffer): boolean {
  const point = decode(raw);
  if (point === null) return false;
  let eight = point;
  for (let i = 0; i < 3; i += 1) eight = add(eight, eight);
  return !(eight.x === 0n && eight.y === 1n);
}
