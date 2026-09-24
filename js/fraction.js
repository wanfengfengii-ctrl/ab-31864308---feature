// fraction.js — 精确有理数（BigInt 分子/分母），全程不使用浮点。
// 表示形式：[num, den]，den 恒为正，约分至最简；零为 [0n, 1n]。

export function fr(num, den = 1n) {
  num = BigInt(num);
  den = BigInt(den);
  if (den === 0n) throw new Error('有理数分母为零');
  if (den < 0n) { num = -num; den = -den; }
  if (num === 0n) return [0n, 1n];
  const g = gcd(num < 0n ? -num : num, den);
  return [num / g, den / g];
}

export function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

export const ZERO = [0n, 1n];
export const ONE = [1n, 1n];

export function isZero(x) { return x[0] === 0n; }
export function isPos(x) { return x[0] > 0n; }
export function isNeg(x) { return x[0] < 0n; }

export function neg(x) { return [-x[0], x[1]]; }

export function add(a, b) { return fr(a[0] * b[1] + b[0] * a[1], a[1] * b[1]); }
export function sub(a, b) { return fr(a[0] * b[1] - b[0] * a[1], a[1] * b[1]); }
export function mul(a, b) { return fr(a[0] * b[0], a[1] * b[1]); }
export function div(a, b) {
  if (b[0] === 0n) throw new Error('有理数除以零');
  return fr(a[0] * b[1], a[1] * b[0]);
}

// a < b -> -1, a == b -> 0, a > b -> 1
export function cmp(a, b) {
  const l = a[0] * b[1];
  const r = b[0] * a[1];
  return l < r ? -1 : l > r ? 1 : 0;
}
export const eq = (a, b) => cmp(a, b) === 0;
export const lt = (a, b) => cmp(a, b) < 0;
export const gt = (a, b) => cmp(a, b) > 0;
export const minF = (a, b) => (lt(a, b) ? a : b);
export const maxF = (a, b) => (gt(a, b) ? a : b);

// 除以正整数标量
export function divInt(a, k) { return fr(a[0], a[1] * BigInt(k)); }

export function toNumber(x) { return Number(x[0]) / Number(x[1]); }

// 精确十进制：长除法 + 四舍五入到 digits 位（恒返回 digits 位小数）
export function toFixed(x, digits = 6) {
  let n = x[0], d = x[1];
  const sign = n < 0n ? '-' : '';
  n = n < 0n ? -n : n;
  const whole = n / d;
  let rem = n % d;
  let out = '';
  for (let i = 0; i < digits; i++) {
    rem *= 10n;
    out += (rem / d).toString();
    rem %= d;
  }
  // 多算一位用于四舍五入
  rem *= 10n;
  if (rem / d >= 5n) {
    let carry = 1n;
    const arr = out.split('');
    for (let i = arr.length - 1; i >= 0 && carry; i--) {
      const v = Number(arr[i]) + 1;
      arr[i] = String(v % 10);
      carry = BigInt(Math.floor(v / 10));
    }
    let w = whole + carry;
    out = arr.join('');
    return `${sign}${w}.${out}`;
  }
  return `${sign}${whole}.${out}`;
}

// 去掉末尾多余的零
export function toDecimal(x, digits = 6) {
  return toFixed(x, digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0');
}
