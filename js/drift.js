// drift.js — 单链路漂移复原
// 把 d(p,q) 视为唯一可能被仪表漂移污染的读数（未知量 x），其余读数作为固定证据，
// 用缩放后的精确有理数求出仍能使完整矩阵成为树度量（可重建为规范无根树）的 x 闭区间。
//
// 数学要点（n 个端点，S = 其余 n-2 个端点）：
//  · 固定证据须先自洽：不含 {p,q} 双方的三元组严格满足三角不等式、
//    不含 {p,q} 双方的四元组满足四点判据；否则任何 x 都无力回天（空区间）。
//  · 三角不等式（三元组 {p,q,k}）给出开区间：
//      max_k |d(p,k)-d(q,k)|  <  x  <  min_k ( d(p,k)+d(q,k) )
//  · 四点判据（四元组 {p,q,a,b}）：记 S2=d(p,a)+d(q,b)，S3=d(p,b)+d(q,a)，e=d(a,b)。
//    三个对边和为 x+e、S2、S3，最大值须出现至少两次：
//      S2≠S3 ⇒ 必须 x = max(S2,S3)-e（等式约束，区间退化为单点）；
//      S2=S3 ⇒ 只需 x ≤ S2-e（半线上界）。
//  · 全部约束均为精确有理数线性约束，可行集是实数区间；再吸附到三位小数网格
//    k/1000，得到闭区间 [kMin/1000, kMax/1000]：区间内每个三位小数值都满足
//    严格三角不等式 + 四点判据，从而邻接重建与逐对路径核算必然通过。
import * as F from './fraction.js';
import { parseDecimalToken, scaledToText } from './matrixio.js';
import { buildModel, validateMetric, reconstruct } from './metric.js';

const GRID = 1000n; // 三位小数网格

// b > 0 的向下取整除法（BigInt 截断向零，负数需修正）
function floorDiv(a, b) {
  const q = a / b;
  return (a % b !== 0n && a < 0n) ? q - 1n : q;
}
// 精确分数 x → floor(1000·x) / ceil(1000·x) / round(1000·x)（x ≥ 0 时 round 有效）
const floorK = (x) => floorDiv(x[0] * GRID, x[1]);
const ceilK = (x) => -floorDiv(-(x[0] * GRID), x[1]);
const roundK = (x) => floorDiv(x[0] * 2n * GRID + x[1], x[1] * 2n);

// ---------------------------------------------------------------------------
// 固定证据模型：解析并校验除 (p,q)/(q,p) 两格之外的全部读数。
// 返回 { ok, matrix?: (F|null)[][]（疑点格为 null）, scale, decimals, error?, cell?, cells? }
// ---------------------------------------------------------------------------
export function buildFixedEvidence(labels, cells, p, q) {
  const n = cells.length;
  if (n < 4 || n > 40) return { ok: false, error: `端点数必须在 4–40 之间（当前 ${n}），无法做漂移复原` };
  for (const row of cells) {
    if (!row || row.length !== n) return { ok: false, error: '矩阵必须为方阵' };
  }
  const isPair = (i, j) => (i === p && j === q) || (i === q && j === p);

  const parsed = Array.from({ length: n }, () => Array(n).fill(null));
  let digits = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (isPair(i, j)) continue;
      const tok = cells[i][j] === '' || cells[i][j] == null ? '0' : String(cells[i][j]).trim();
      const pr = parseDecimalToken(tok);
      if (!pr) {
        return { ok: false, error: `固定读数 (${labels[i]}, ${labels[j]}) 不是合法十进制数：“${cells[i][j]}”`, cell: [i, j] };
      }
      if (pr.digits > 3) {
        return { ok: false, error: `固定读数 (${labels[i]}, ${labels[j]}) 小数位超过三位：“${cells[i][j]}”`, cell: [i, j] };
      }
      digits = Math.max(digits, pr.digits);
      parsed[i][j] = pr;
    }
  }

  const scale = 10n ** BigInt(digits);
  const matrix = Array.from({ length: n }, () => Array(n).fill(null));
  const scaled = Array.from({ length: n }, () => Array(n).fill(null));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (isPair(i, j)) continue;
      const v = parsed[i][j].int * (10n ** BigInt(digits - parsed[i][j].digits));
      scaled[i][j] = v;
      matrix[i][j] = F.fr(v, scale);
    }
  }

  for (let i = 0; i < n; i++) {
    if (scaled[i][i] !== 0n) {
      return { ok: false, error: `对角线必须为 0：d(${labels[i]}, ${labels[i]}) = ${cells[i][i]}`, cell: [i, i] };
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (isPair(i, j)) continue;
      if (scaled[i][j] !== scaled[j][i]) {
        return {
          ok: false,
          error: `固定读数不对称：d(${labels[i]}, ${labels[j]}) = ${cells[i][j]} ≠ d(${labels[j]}, ${labels[i]}) = ${cells[j][i]}`,
          cells: [[i, j], [j, i]],
        };
      }
      if (scaled[i][j] <= 0n) {
        return {
          ok: false,
          error: `固定读数必须为正数：d(${labels[i]}, ${labels[j]}) = ${cells[i][j]}`,
          cells: [[i, j], [j, i]],
        };
      }
    }
  }
  return { ok: true, matrix, scale, decimals: digits };
}

// ---------------------------------------------------------------------------
// 核心：求 d(p,q) 的允许闭区间。
// 返回：
//  非空：{ ok:true, empty:false, lo, hi, kMin, kMax, degenerate, gridCount,
//          correction, correctionK, correctionText, delta,
//          original:{textPQ,textQP,value,asymmetric}, bounds:{L,U,halfMin,equalities} }
//  空区间：{ ok:true, empty:true, reason, message, cells? }
//  无法计算：{ ok:false, error }
// ---------------------------------------------------------------------------
export function restoreInterval(labels, cells, p, q) {
  const n = cells.length;
  if (!Number.isInteger(p) || !Number.isInteger(q) || p === q || p < 0 || q < 0 || p >= n || q >= n) {
    return { ok: false, error: '疑似端点对无效：请选择两个不同的端点' };
  }
  if (n < 4 || n > 40) {
    return { ok: false, error: `端点数须在 4–40 之间（当前 ${n}），才能进行漂移复原` };
  }

  const ev = buildFixedEvidence(labels, cells, p, q);
  if (!ev.ok) {
    return {
      ok: true, empty: true, reason: 'fixed-invalid',
      message: `其余读数本身不合法，无法作为固定证据：${ev.error}`,
      cells: ev.cells || (ev.cell ? [ev.cell] : undefined),
    };
  }
  const M = ev.matrix;
  const S = [];
  for (let k = 0; k < n; k++) if (k !== p && k !== q) S.push(k);

  // 端点按编号字典序（与既有反例排序一致），固定证据的冲突也按此顺序定位最早者
  const order = labels.map((_, i) => i)
    .sort((i, j) => (labels[i] < labels[j] ? -1 : labels[i] > labels[j] ? 1 : i - j));
  const hasBoth = (idxs) => idxs.includes(p) && idxs.includes(q);

  // —— 固定证据自洽性：严格三角不等式（不含 {p,q} 双方的三元组）——
  for (let x = 0; x < n; x++) {
    for (let y = x + 1; y < n; y++) {
      for (let z = y + 1; z < n; z++) {
        const a = order[x], b = order[y], c = order[z];
        if (hasBoth([a, b, c])) continue;
        const dirs = [[b, a, c], [a, b, c], [c, a, b]]; // [mid,left,right]
        for (const [mid, left, right] of dirs) {
          const s = F.add(M[left][mid], M[mid][right]);
          if (!F.gt(s, M[left][right])) {
            const deg = F.eq(s, M[left][right]);
            return {
              ok: true, empty: true, reason: 'fixed-triangle',
              message: `其余读数在三角不等式上已自相矛盾（不涉及该链路）：` +
                `d(${labels[left]},${labels[mid]}) + d(${labels[mid]},${labels[right]}) = ${F.toDecimal(s)}` +
                `${deg ? ' = ' : ' < '}d(${labels[left]},${labels[right]}) = ${F.toDecimal(M[left][right])}` +
                (deg ? '（退化取等）' : ''),
              cells: [[left, mid], [mid, left], [mid, right], [right, mid], [left, right], [right, left]],
            };
          }
        }
      }
    }
  }

  // —— 固定证据自洽性：四点判据（不含 {p,q} 双方的四元组）——
  for (let x = 0; x < n; x++) {
    for (let y = x + 1; y < n; y++) {
      for (let z = y + 1; z < n; z++) {
        for (let w = z + 1; w < n; w++) {
          const a = order[x], b = order[y], c = order[z], d = order[w];
          if (hasBoth([a, b, c, d])) continue;
          const s1 = F.add(M[a][b], M[c][d]);
          const s2 = F.add(M[a][c], M[b][d]);
          const s3 = F.add(M[a][d], M[b][c]);
          const m = F.maxF(F.maxF(s1, s2), s3);
          const ties = [F.eq(s1, m), F.eq(s2, m), F.eq(s3, m)].filter(Boolean).length;
          if (ties === 1) {
            return {
              ok: true, empty: true, reason: 'fixed-fourpoint',
              message: `其余读数在四点判据上已自相矛盾（不涉及该链路）：` +
                `(${labels[a]},${labels[b]},${labels[c]},${labels[d]}) 三组对边和 ` +
                `${F.toDecimal(s1)} / ${F.toDecimal(s2)} / ${F.toDecimal(s3)} 的最大值仅出现一次`,
              cells: [
                [a, b], [b, a], [c, d], [d, c],
                [a, c], [c, a], [b, d], [d, b],
                [a, d], [d, a], [b, c], [c, b],
              ],
            };
          }
        }
      }
    }
  }

  // —— x 的约束：三角不等式（开区间）——
  let L = F.ZERO, U = null;
  for (const k of S) {
    const diff = F.gt(M[p][k], M[q][k]) ? F.sub(M[p][k], M[q][k]) : F.sub(M[q][k], M[p][k]);
    if (F.gt(diff, L)) L = diff;
    const sum = F.add(M[p][k], M[q][k]);
    if (U === null || F.lt(sum, U)) U = sum;
  }

  // —— x 的约束：四点判据（等式 / 半线）——
  const equalities = []; // x 必须等于这些值
  const halfLines = [];  // x 不得超过这些值
  for (let i = 0; i < S.length; i++) {
    for (let j = i + 1; j < S.length; j++) {
      const a = S[i], b = S[j];
      const s2 = F.add(M[p][a], M[q][b]);
      const s3 = F.add(M[p][b], M[q][a]);
      const c = F.sub(F.maxF(s2, s3), M[a][b]);
      if (F.eq(s2, s3)) halfLines.push(c);
      else equalities.push(c);
    }
  }

  let lo, hi, kMin, kMax, degenerate;
  if (equalities.length > 0) {
    // 等式约束：所有候选必须同为一点（固定证据自洽时数学上必然一致，仍防御性核对）
    const c = equalities[0];
    if (equalities.some(c2 => !F.eq(c2, c))) {
      const c2 = equalities.find(c2 => !F.eq(c2, c));
      return {
        ok: true, empty: true, reason: 'equality-conflict',
        message: `四点判据对该链路给出互相矛盾的等式要求：x = ${F.toDecimal(c)} 与 x = ${F.toDecimal(c2)} 无法同时成立`,
      };
    }
    if (!F.isPos(c)) {
      return {
        ok: true, empty: true, reason: 'equality-infeasible',
        message: `四点判据唯一允许的取值 x = ${F.toDecimal(c)} 不是正数，无法作为时延`,
      };
    }
    if (!F.lt(L, c) || !F.lt(c, U)) {
      return {
        ok: true, empty: true, reason: 'equality-infeasible',
        message: `四点判据唯一允许的取值 x = ${F.toDecimal(c)} 不满足三角不等式开区间 ` +
          `(${F.toDecimal(L)}, ${F.toDecimal(U)})`,
      };
    }
    const badHalf = halfLines.find(h => F.gt(c, h));
    if (badHalf) {
      return {
        ok: true, empty: true, reason: 'equality-infeasible',
        message: `四点判据唯一允许的取值 x = ${F.toDecimal(c)} 越过另一四点约束的上界 ${F.toDecimal(badHalf)}`,
      };
    }
    const k = c[0] * GRID;
    if (k % c[1] !== 0n) {
      return {
        ok: true, empty: true, reason: 'equality-infeasible',
        message: `四点判据唯一允许的取值 x = ${F.toDecimal(c, 9)} 无法表示为三位小数`,
      };
    }
    kMin = kMax = k / c[1];
    lo = hi = c;
    degenerate = true;
  } else {
    // 无等式约束：开区间 (L, U) 与半线 x ≤ h 求交，再吸附三位小数网格
    kMin = floorK(L) + 1n;
    if (kMin < 1n) kMin = 1n; // 正性：x > 0
    kMax = ceilK(U) - 1n;
    for (const h of halfLines) {
      const kh = floorK(h);
      if (kh < kMax) kMax = kh;
    }
    if (kMin > kMax) {
      return {
        ok: true, empty: true, reason: 'empty-grid',
        message: `三角不等式与四点判据的交集 (${F.toDecimal(L)}, ${F.toDecimal(U)}` +
          (halfLines.length ? `，且 x ≤ ${F.toDecimal(halfLines.reduce(F.minF))}` : '') +
          `) 内不存在可表示为三位小数的正值`,
      };
    }
    lo = F.fr(kMin, GRID);
    hi = F.fr(kMax, GRID);
    degenerate = false;
  }

  // —— 原值与距原值最近的可用修正 ——
  const textPQ = String(cells[p][q] ?? '').trim();
  const textQP = String(cells[q][p] ?? '').trim();
  const parse = (t) => {
    const pr = parseDecimalToken(t);
    return pr ? F.fr(pr.int, 10n ** BigInt(pr.digits)) : null;
  };
  const vPQ = parse(textPQ), vQP = parse(textQP);
  const original = {
    textPQ, textQP,
    value: vPQ || vQP,
    asymmetric: vPQ && vQP && !F.eq(vPQ, vQP),
  };

  let correctionK;
  if (degenerate) correctionK = kMin;
  else if (!original.value) correctionK = kMin; // 原值不可解析时取区间下端
  else {
    const kx = roundK(original.value);
    correctionK = kx < kMin ? kMin : kx > kMax ? kMax : kx;
  }
  const correction = F.fr(correctionK, GRID);
  const correctionText = scaledToText(correctionK, 3);

  return {
    ok: true,
    empty: false,
    p, q,
    lo, hi, kMin, kMax, degenerate,
    gridCount: kMax - kMin + 1n,
    correction, correctionK, correctionText,
    delta: original.value ? F.sub(correction, original.value) : null,
    original,
    bounds: {
      L, U,
      halfMin: halfLines.length ? halfLines.reduce(F.minF) : null,
      halfCount: halfLines.length,
      equalityCount: equalities.length,
    },
    scale: ev.scale,
  };
}

// ---------------------------------------------------------------------------
// 把某个修正值写回拷贝矩阵后跑完整既有流水线（解析缩放 → 三角 → 四点 → 重建 → 逐对核算）
// ---------------------------------------------------------------------------
export function verifyCorrected(labels, cells, p, q, text) {
  const trial = cells.map(r => r.slice());
  trial[p][q] = text;
  trial[q][p] = text;
  const model = buildModel(labels, trial);
  if (!model.ok) return { ok: false, stage: 'build', error: model.error };
  const verdict = validateMetric(model, labels);
  if (!verdict.ok) return { ok: false, stage: verdict.kind, error: verdict.message };
  const r = reconstruct(model, labels);
  if (!r.ok) return { ok: false, stage: 'reconstruct', error: r.error };
  return { ok: true, model, tree: r.tree, check: r.check };
}

// ---------------------------------------------------------------------------
// 区间内三位小数取值的复核计划：区间不大时逐点全量；过大时取端点、
// 最近修正与均匀抽样代表（可行性本身由同一组精确线性约束保证）。
// 返回 { total, exhaustive, ks: BigInt[] }
// ---------------------------------------------------------------------------
export function planIntervalChecks(res, maxChecks = 200) {
  const total = res.kMax - res.kMin + 1n;
  const exhaustive = total <= BigInt(maxChecks);
  const ks = [];
  const seen = new Set();
  const add = (k) => {
    if (k < res.kMin || k > res.kMax) return;
    const s = k.toString();
    if (!seen.has(s)) { seen.add(s); ks.push(k); }
  };
  if (exhaustive) {
    for (let k = res.kMin; k <= res.kMax; k++) add(k);
  } else {
    add(res.kMin);
    add(res.kMax);
    if (res.correctionK != null) add(res.correctionK);
    const denom = BigInt(maxChecks - 1);
    for (let i = 0n; ks.length < maxChecks && i < denom; i++) {
      add(res.kMin + ((total - 1n) * i) / denom);
    }
    // 抽样碰撞时从下端顺序补足
    for (let k = res.kMin; ks.length < maxChecks && k <= res.kMax; k++) add(k);
    ks.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  return { total, exhaustive, ks };
}

// 同步执行复核计划（供测试与小区间使用）
export function verifyIntervalValues(labels, cells, p, q, res, maxChecks = 200) {
  const plan = planIntervalChecks(res, maxChecks);
  let firstFailure = null;
  for (const k of plan.ks) {
    const text = scaledToText(k, 3);
    const r = verifyCorrected(labels, cells, p, q, text);
    if (!r.ok) { firstFailure = { text, stage: r.stage, error: r.error }; break; }
  }
  return { total: plan.total, checked: plan.ks.length, exhaustive: plan.exhaustive, ok: !firstFailure, firstFailure };
}
