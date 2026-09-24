// repair.js — 单链路漂移复原（single-link drift recovery）
//
// 前提：矩阵已通过 buildModel（对称、对角为零、非对角为正、最多三位小数）。
// 把维护人员指定的端点对 (p,q) 的读数视为唯一可能失真的值 x，其余读数全部固定
// 为证据，求“仍能形成规范无根树”的真实时延允许集合。
//
// 一、线性条件（全部以缩放后的精确有理数 BigInt 推导）
//   · 正数：x > 0
//   · 三角不等式（严格）：对每个 k∉{p,q}，|d(p,k)-d(q,k)| < x < d(p,k)+d(q,k)
//   · 四点判据（四元组 {p,q,k,l}，三个对边和）：
//       S1 = x + d(k,l)，A = d(p,k)+d(q,l)，B = d(p,l)+d(q,k)
//       最大值至少出现两次。A、B 与 x 无关：
//         A = B：最大值已由 A、B 并列，但 S1 不得严格越过它们，故 x ≤ A-d(k,l)
//               （闭上界；取等处该四元组三歧并列，由收缩零权内部边消化）；
//         A ≠ B：单独较大者必须被 S1 追平，x 被钉死为 max(A,B)-d(k,l)。
//       多个钉点必须完全相等，否则固定证据自相矛盾、允许集合为空。
//
// 二、区间内部的仿射树
//   无钉点时，在严格内部 p,q 恒为姐妹对（每个四元组分裂为 pq|kl），邻接法
//   拓扑恒定，取内部参考点 x* 处的（未收缩）二叉 NJ 树 T*：p、q 共父 u，
//   u 的第三个邻居为 z。仅三条边权随 x 仿射变化：
//     w(p,u)(x) = w*_p + (x-x*)/2，w(q,u)(x) = w*_q + (x-x*)/2，
//     w(u,z)(x) = w*_z − (x-x*)/2，其余边权恒定。
//   由此正权界：悬挂边严格为正（给出严格下界），内部边非负（给出闭上端点，
//   取等处多歧由零权内部边收缩消化）。点区间（钉死）无内部可言，直接在钉点
//   走完整流水线。
//
// 三、三位小数网格（x = k·step）穷尽复核
//   每个网格点：重算随 x 变化的全部三角不等式与四点判据；在仿射树上代入边权，
//   检查正性并对全部叶对做逐对路径核算（期望矩阵仅 (p,q) 改为 x）。
//   另在参考点、网格两端、最近修正与闭上端点执行完整 validateMetric →
//   neighborJoin → 收缩 → 规范校验流水线，并核对两端拓扑仍为 p,q 姐妹；
//   若拓扑在网格内发生非常态变化，退化为对每个网格点执行完整流水线。
import * as F from './fraction.js';
import { validateMetric, reconstruct, neighborJoin } from './metric.js';

const FULL_PIPELINE_LIMIT = 5000n; // 候选数不超过该值时每个网格点都完整重建

// floor / ceil（BigInt，分母恒正）
function floorDiv(num, den) {
  const q = num / den;
  return num < 0n && num % den !== 0n ? q - 1n : q;
}
const ceilDiv = (num, den) => -floorDiv(-num, den);

// 给定 x（分数）构造只改动 (p,q) 两个对称格的模型副本
function withValue(model, p, q, x) {
  const matrix = model.matrix.map(r => r.slice());
  matrix[p][q] = matrix[q][p] = x;
  return { ...model, matrix };
}

// 完整主流水线：三角 → 四点 → 邻接法 → 收缩 → 规范校验（含逐对路径核算）
function checkCandidate(model, labels, p, q, x) {
  const cand = withValue(model, p, q, x);
  const verdict = validateMetric(cand, labels);
  if (!verdict.ok) return { ok: false, stage: 'validate', verdict, model: cand };
  const recon = reconstruct(cand, labels);
  if (!recon.ok) return { ok: false, stage: 'reconstruct', recon, model: cand };
  return { ok: true, model: cand, recon };
}

// 未收缩的 NJ 二叉树及其邻接
function rawTreeAt(model, labels, p, q, x) {
  const cand = withValue(model, p, q, x);
  const tree = neighborJoin(cand.matrix, labels);
  const adj = new Map(tree.nodes.map(v => [v.id, new Set()]));
  for (const [a, b] of tree.edges) { adj.get(a).add(b); adj.get(b).add(a); }
  return { cand, tree, adj };
}

// 随 x 变化的度量判据（其余三元/四元组与 x 无关，由参考点完整 validateMetric 覆盖）
function criteriaOnX(model, p, q, x) {
  const { matrix } = model;
  const n = matrix.length;
  if (!F.isPos(x)) return { ok: false, error: 'x 必须为正数' };
  const others = [];
  for (let k = 0; k < n; k++) if (k !== p && k !== q) others.push(k);

  for (const k of others) {
    const dpk = matrix[p][k], dqk = matrix[q][k];
    if (!F.gt(F.add(x, dpk), dqk)) return { ok: false, error: `三角不等式退化/违反：x+d(p,${k}) ≤ d(q,${k})` };
    if (!F.gt(F.add(x, dqk), dpk)) return { ok: false, error: `三角不等式退化/违反：x+d(q,${k}) ≤ d(p,${k})` };
    if (!F.gt(F.add(dpk, dqk), x)) return { ok: false, error: `三角不等式上界在端点 ${k} 处取等/违反` };
  }

  for (let u = 0; u < others.length; u++) {
    for (let v = u + 1; v < others.length; v++) {
      const k = others[u], l = others[v];
      const s1 = F.add(x, matrix[k][l]);
      const s2 = F.add(matrix[p][k], matrix[q][l]);
      const s3 = F.add(matrix[p][l], matrix[q][k]);
      const m = F.maxF(F.maxF(s1, s2), s3);
      const ties = [F.eq(s1, m), F.eq(s2, m), F.eq(s3, m)].filter(Boolean).length;
      if (ties === 1) return { ok: false, error: `四点判据违反：四元组 {${p},${q},${k},${l}} 最大值唯一` };
    }
  }
  return { ok: true };
}

// 推导 x 的线性条件
function collectConditions(model, p, q) {
  const { matrix } = model;
  const n = matrix.length;
  const lower = [F.ZERO]; // 严格下界 x > b
  const triUpper = [];    // 严格上界 x < b（三角）
  const fpUpper = [];     // 闭上界 x ≤ b（四点：S1 不得越过并列最大值）
  const pins = [];        // { v, quartet }

  for (let k = 0; k < n; k++) {
    if (k === p || k === q) continue;
    const dpk = matrix[p][k], dqk = matrix[q][k];
    lower.push(F.sub(dqk, dpk));
    lower.push(F.sub(dpk, dqk));
    triUpper.push(F.add(dpk, dqk));
  }

  const others = [];
  for (let k = 0; k < n; k++) if (k !== p && k !== q) others.push(k);
  for (let u = 0; u < others.length; u++) {
    for (let v = u + 1; v < others.length; v++) {
      const k = others[u], l = others[v];
      const A = F.add(matrix[p][k], matrix[q][l]);
      const B = F.add(matrix[p][l], matrix[q][k]);
      if (F.eq(A, B)) {
        // A、B 已并列：S1=x+d(k,l) 不得严格越过，否则成为唯一最大值
        fpUpper.push({ b: F.sub(A, matrix[k][l]), quartet: [p, q, k, l] });
      } else {
        pins.push({ v: F.sub(F.maxF(A, B), matrix[k][l]), quartet: [p, q, k, l] });
      }
    }
  }
  return { lower, triUpper, fpUpper, pins };
}

const qname = (quartet, labels) => quartet.map(i => labels[i]).join(',');

// 仿射边权：slope 为 1 / -1（意义为 ±(x-x*)/2）/ 0
function affineWeightMap(refTree, slope, x, xStar) {
  const half = F.divInt(F.sub(x, xStar), 2);
  const weight = new Map();
  for (const [a, b, w0] of refTree.edges) {
    const s = slope.get(`${a}|${b}`) || 0;
    const w = s === 1 ? F.add(w0, half) : s === -1 ? F.sub(w0, half) : w0;
    weight.set(`${a}|${b}`, w);
    weight.set(`${b}|${a}`, w);
  }
  return weight;
}

function pathSum(adj, weight, s, t) {
  const prev = new Map([[s, null]]);
  const qq = [s];
  while (qq.length) {
    const u = qq.shift();
    if (u === t) break;
    for (const v of adj.get(u)) if (!prev.has(v)) { prev.set(v, u); qq.push(v); }
  }
  if (!prev.has(t)) return null;
  const path = [];
  let cur = t, sum = F.ZERO;
  while (cur !== null) { path.push(cur); cur = prev.get(cur); }
  for (let i = 0; i < path.length - 1; i++) sum = F.add(sum, weight.get(`${path[i]}|${path[i + 1]}`));
  return sum;
}

// 主入口：单链路漂移复原
export function repairSingleLink(model, labels, p, q) {
  if (p === q || p < 0 || q < 0 || p >= labels.length || q >= labels.length) {
    return { ok: false, kind: 'input', error: '请选择两个不同的端点' };
  }
  p = Number(p); q = Number(q);
  const original = model.matrix[p][q];
  const step = F.fr(1n, model.scale); // 仪表最小单位（三位小数即 1/1000）
  const fail = (kind, error, extra = {}) =>
    ({ ok: false, kind, p, q, original, step, error, ...extra });

  const { lower, triUpper, fpUpper, pins } = collectConditions(model, p, q);

  // 1) 钉点必须全部相等
  let pinned = null;
  if (pins.length > 0) {
    pinned = pins[0].v;
    for (const t of pins.slice(1)) {
      if (!F.eq(t.v, pinned)) {
        return fail('empty',
          `允许区间为空：固定证据内部矛盾——四元组 (${qname(pins[0].quartet, labels)}) 把该读数钉为 ` +
          `${F.toDecimal(pins[0].v)}，四元组 (${qname(t.quartet, labels)}) 却钉为 ${F.toDecimal(t.v)}；` +
          '仅修正这一条链路无法同时满足，异常不能由该链路单独解释');
      }
    }
  }

  // 2) 三角开区间 (tLo, tHi) 与四点闭上界 x ≤ fHi
  let tLo = F.ZERO;
  for (const b of lower) if (F.gt(b, tLo)) tLo = b;
  let tHi = triUpper[0];
  for (const b of triUpper) if (F.lt(b, tHi)) tHi = b;
  // 四点闭上界：所有 A=B 四元组要求 x+d(k,l) ≤ A
  let fHi = null;
  for (const t of fpUpper) if (fHi === null || F.lt(t.b, fHi)) fHi = t.b;

  if (pinned !== null) {
    const pinOk = F.gt(pinned, tLo) && F.lt(pinned, tHi) && (fHi === null || !F.gt(pinned, fHi));
    if (!pinOk) {
      return fail('empty',
        `允许区间为空：四点判据把读数钉为 ${F.toDecimal(pinned)}，但可行边界要求 ` +
        `${F.toDecimal(tLo)} < x < ${F.toDecimal(tHi)}${fHi ? ` 且 x ≤ ${F.toDecimal(fHi)}` : ''}` +
        '（越界处端点落在路径上或四元组最大值唯一，无法成为规范树的叶），该链路无法单独解释异常');
    }
  } else {
    const coreHi = fHi === null ? tHi : F.minF(tHi, fHi);
    if (F.cmp(tLo, coreHi) >= 0) {
      return fail('empty',
        `允许区间为空：严格三角下界 ${F.toDecimal(tLo)} ${F.eq(tLo, coreHi) ? '与上界重合（退化三元组，端点无法成为叶）' : `高于上界 ${F.toDecimal(coreHi)}`}，该链路无法单独解释异常`);
    }
  }
  const isPoint = pinned !== null;

  // 3) 点区间：钉点处完整流水线
  if (isPoint) {
    const r = checkCandidate(model, labels, p, q, pinned);
    if (!r.ok) {
      return fail('empty',
        `钉点 ${F.toDecimal(pinned)} 处无法形成规范无根树：` +
        (r.stage === 'validate' ? r.verdict.message : r.recon.error));
    }
    const iv = { lo: pinned, hi: pinned, loOpen: false, hiOpen: false, pinned: true };
    return {
      ok: true, p, q, original, step, interval: iv, triangleInterval: { lo: tLo, hi: tHi },
      grid: { lo: pinned, hi: pinned, count: 1n, fullReconstructed: 1n, perGridPipeline: true },
      endpoints: { lo: { x: pinned, included: true, usable: true }, hi: { x: pinned, included: true, usable: true } },
      midpoint: pinned, fix: pinned, delta: F.sub(pinned, original), fixAtOriginal: F.eq(pinned, original),
      fixModel: r.model, fixRecon: r.recon,
    };
  }

  // 4) 严格内部参考点 x*（可行段 1/4 处）及其 NJ 树
  const coreHi = fHi === null ? tHi : F.minF(tHi, fHi);
  const xStar = F.add(tLo, F.divInt(F.sub(coreHi, tLo), 4));
  const refCheck = checkCandidate(model, labels, p, q, xStar);
  if (!refCheck.ok) {
    return fail('empty',
      `允许区间内部参考点 ${F.toDecimal(xStar)} 不能形成规范无根树（固定证据存在不经该链路的矛盾）：` +
      (refCheck.stage === 'validate' ? refCheck.verdict.message : refCheck.recon.error),
      { interval: { lo: tLo, hi: coreHi, loOpen: true, hiOpen: true, pinned: false } });
  }
  const raw = rawTreeAt(model, labels, p, q, xStar);
  const np = [...raw.adj.get(p)][0], nq = [...raw.adj.get(q)][0];
  let affine = null;
  if (np === nq) {
    const u = np;
    const rest = [...raw.adj.get(u)].filter(z => z !== p && z !== q);
    if (rest.length === 1) {
      const z = rest[0];
      const slope = new Map();
      const setS = (a, b, s) => { slope.set(`${a}|${b}`, s); slope.set(`${b}|${a}`, s); };
      setS(p, u, 1); setS(q, u, 1); setS(u, z, -1);
      affine = { u, z, slope };
    }
  }
  if (!affine) {
    return fail('empty',
      '允许区间内部邻接法树中该端点对不构成姐妹对，固定证据与“仅该链路失真”的假设不相容，该链路无法单独解释异常',
      { interval: { lo: tLo, hi: coreHi, loOpen: true, hiOpen: true, pinned: false } });
  }

  // 5) 合并上界：三角开上界 tHi、四点闭上界 fHi、仿射内部边闭界 wHiInternal
  //    （后两者对同一樱桃拓扑恒相等，一并求交以防实现误差）；下界叠加悬挂边正权界。
  const refW = (a, b) => raw.tree.edges.find(([x, y]) => (x === a && y === b) || (x === b && y === a))[2];
  const wpS = refW(p, affine.u), wqS = refW(q, affine.u), wzS = refW(affine.u, affine.z);
  const bLo1 = F.sub(xStar, F.add(wpS, wpS)); // x > x* - 2w*_p
  const bLo2 = F.sub(xStar, F.add(wqS, wqS));
  const wHiInternal = F.add(xStar, F.add(wzS, wzS)); // x ≤ x* + 2w*_z（闭）
  const lo = F.maxF(F.maxF(tLo, bLo1), bLo2);
  const hiCandidates = [{ b: tHi, closed: false }, { b: wHiInternal, closed: true }];
  if (fHi !== null) hiCandidates.push({ b: fHi, closed: true });
  let hi = hiCandidates[0].b, hiClosed = hiCandidates[0].closed;
  for (const c of hiCandidates.slice(1)) {
    if (F.lt(c.b, hi)) { hi = c.b; hiClosed = c.closed; }
    else if (F.eq(c.b, hi) && !c.closed) hiClosed = false; // 与开界重合 → 开
  }
  if (F.gt(lo, hi) || (F.eq(lo, hi) && !hiClosed)) {
    return fail('empty',
      `允许区间为空：可行交集 (${F.toDecimal(tLo)}, ${F.toDecimal(coreHi)}] 内不存在边权全部合范的规范树` +
      '（悬挂边或内部边在交集内即为零/负），该链路无法单独解释异常',
      { interval: { lo, hi, loOpen: true, hiOpen: !hiClosed, pinned: false } });
  }

  // 6) 三位小数网格
  const ratio = (x) => { const r = F.div(x, step); return { num: r[0], den: r[1] }; };
  const rLo = ratio(lo), rHi = ratio(hi);
  const kLo = floorDiv(rLo.num, rLo.den) + 1n; // 下界恒严格
  const kHi = hiClosed ? floorDiv(rHi.num, rHi.den) : ceilDiv(rHi.num, rHi.den) - 1n;
  if (kLo > kHi) {
    return fail('empty',
      '真实时延区间非空，但其中没有任何三位小数可表示的值（仪表精度不足），无法形成可用修正',
      { interval: { lo, hi, loOpen: true, hiOpen: !hiClosed, pinned: false } });
  }
  const grid = (k) => F.mul(F.fr(k, 1n), step);
  const gridCount = kHi - kLo + 1n;

  // 7) 距原值最近的可用网格修正
  const ro = ratio(original);
  if (ro.den !== 1n) return fail('input', '内部错误：原值不是最小单位整数倍');
  const ko = ro.num;
  const kFix = ko < kLo ? kLo : ko > kHi ? kHi : ko;
  const fix = grid(kFix);

  // 8) 必做完整流水线点：参考点、网格两端、最近修正、（若不是网格点的）闭上端点
  const fullPoints = new Map();
  const addPoint = (x) => { fullPoints.set(`${x[0]}/${x[1]}`, x); };
  addPoint(xStar); addPoint(grid(kLo)); addPoint(grid(kHi)); addPoint(fix);
  const hiOnGrid = hiClosed && F.eq(grid(kHi), hi);
  if (hiClosed && !hiOnGrid) addPoint(hi);

  const fullResults = new Map();
  for (const x of fullPoints.values()) {
    const r = checkCandidate(model, labels, p, q, x);
    if (!r.ok) {
      return fail('empty',
        `候选值 ${F.toDecimal(x)} 的完整重建/逐对路径核算失败：` +
        (r.stage === 'validate' ? r.verdict.message : r.recon.error),
        { interval: { lo, hi, loOpen: true, hiOpen: !hiClosed, pinned: false } });
    }
    fullResults.set(`${x[0]}/${x[1]}`, r);
  }

  // 9) 网格两端拓扑常态性核对：p,q 仍为姐妹对且无负权边。
  // 开区间内四元组分裂恒定（S1 与 A、B 的相等只发生在闭上端点），固定叶集上的
  // NJ 树与 (p,q) 樱桃的挂载位置均恒定；原始树中与 x 无关的常量零权内部边
  // （固定证据本身的多歧节点）对路径和贡献为 0，仿射核算无需特殊处理。
  let topologyConstant = true;
  const leafOf = new Map(raw.tree.nodes.map(v => [v.id, v.leaf]));
  for (const k of [kLo, kHi]) {
    const x = grid(k);
    const rt = rawTreeAt(model, labels, p, q, x);
    const a = [...rt.adj.get(p)][0], b = [...rt.adj.get(q)][0];
    if (a !== b) { topologyConstant = false; break; }
    for (const [, , w] of rt.tree.edges) {
      if (F.isNeg(w)) { topologyConstant = false; break; }
    }
    if (!topologyConstant) break;
  }

  // 10) 逐网格点穷尽复核
  let fullReconstructed = BigInt(fullResults.size);
  // 候选数不多时，对每个三位小数候选都完整走一遍主流水线（三角→四点→邻接法→
  // 收缩→规范校验→逐对路径核算）。
  const fullEvery = gridCount <= FULL_PIPELINE_LIMIT;
  let affineUsed = false;
  if (topologyConstant && !fullEvery) {
    // 候选巨大：改用代数证明，与逐点复核严格等价，且复杂度与候选数无关。
    affineUsed = true;
    // (a) 逐对路径核算的仿射恒等式：在 x* 处全量逐对核算已由完整流水线通过；
    //     再证明每条叶对路径的斜率系数——(p,q) 路径系数为 2（随 (x-x*)/2 单位），
    //     即路径长恰为 x；其余叶对系数为 0，即路径长恒等于固定矩阵值。
    const slopeAtPath = (s, t) => {
      const prev = new Map([[s, null]]);
      const qq = [s];
      while (qq.length) {
        const u = qq.shift();
        if (u === t) break;
        for (const v of raw.adj.get(u)) if (!prev.has(v)) { prev.set(v, u); qq.push(v); }
      }
      if (!prev.has(t)) return null;
      const path = [];
      let cur = t, coeff = 0;
      while (cur !== null) { path.push(cur); cur = prev.get(cur); }
      for (let i = 0; i < path.length - 1; i++) coeff += affine.slope.get(`${path[i]}|${path[i + 1]}`) || 0;
      return coeff;
    };
    const wStar = affineWeightMap(raw.tree, affine.slope, xStar, xStar);
    const nLeaves = labels.length;
    const defy = (msg) => fail('empty', `仿射模型内部校验失败：${msg}`,
      { interval: { lo, hi, loOpen: true, hiOpen: !hiClosed, pinned: false } });
    for (let a = 0; a < nLeaves; a++) {
      for (let b = a + 1; b < nLeaves; b++) {
        const coeff = slopeAtPath(a, b);
        if (coeff === null) return defy(`叶 ${labels[a]}-${labels[b]} 在仿射树上不连通`);
        if (a === p && b === q) {
          if (coeff !== 2) return defy(`(p,q) 路径斜率系数应为 2，实际 ${coeff}`);
          if (!F.eq(pathSum(raw.adj, wStar, a, b), xStar)) return defy('x* 处 (p,q) 路径不等于 x*');
        } else if (coeff !== 0) {
          return defy(`叶 ${labels[a]}-${labels[b]} 路径随 x 变化（系数 ${coeff}），与仿射模型不符`);
        }
      }
    }
    // (b) 边权正性是 x 的一次函数：悬挂边（斜率 +1）随 x 单调增，最小处在网格
    //     最低点；内部边 (u,z)（斜率 −1）随 x 单调减，最小处在网格最高点；其余
    //     边权恒定且在 x* 已为正。故只需检查两端。
    for (const [ea, eb] of raw.tree.edges.map(e => [e[0], e[1]])) {
      const s = affine.slope.get(`${ea}|${eb}`) || 0;
      const pendant = leafOf.get(ea) || leafOf.get(eb);
      const checkX = s === -1 ? grid(kHi) : s === 1 ? grid(kLo) : xStar;
      const w = affineWeightMap(raw.tree, affine.slope, checkX, xStar).get(`${ea}|${eb}`);
      if (pendant ? !F.isPos(w) : F.isNeg(w)) {
        return fail('empty', `网格边界 ${F.toDecimal(checkX)} 处${pendant ? '悬挂' : '内部'}边权${F.isZero(w) ? '为零（叶不能落在节点上）' : '为负'}，该区间内不构成规范树`,
          { interval: { lo, hi, loOpen: true, hiOpen: !hiClosed, pinned: false } });
      }
    }
    // (c) 三角/四点判据关于 x 单调：下界类（x>常数）只需验网格最低点，上界类
    //     （x<常数、S1≤A=B）只需验网格最高点。
    for (const x of [grid(kLo), grid(kHi)]) {
      const cr = criteriaOnX(model, p, q, x);
      if (!cr.ok) return fail('empty', `网格点 ${F.toDecimal(x)} 重算三角不等式/四点判据失败：${cr.error}`,
        { interval: { lo, hi, loOpen: true, hiOpen: !hiClosed, pinned: false } });
    }
  } else {
    // 每个网格点完整走主流水线（候选较少，或区间内拓扑发生非常态变化）
    if (!fullEvery && !topologyConstant) {
      return fail('too-large',
        `允许区间含 ${gridCount.toString()} 个三位小数候选且区间内树拓扑发生变化，完整穷尽重建超过上限 ${FULL_PIPELINE_LIMIT.toString()}`,
        { interval: { lo, hi, loOpen: true, hiOpen: !hiClosed, pinned: false } });
    }
    for (let k = kLo; k <= kHi; k++) {
      const x = grid(k);
      const key = `${x[0]}/${x[1]}`;
      if (fullResults.has(key)) continue;
      const r = checkCandidate(model, labels, p, q, x);
      fullReconstructed++;
      if (!r.ok) {
        return fail('empty',
          `网格点 ${F.toDecimal(x)} 完整重建/逐对路径核算失败：` +
          (r.stage === 'validate' ? r.verdict.message : r.recon.error),
          { interval: { lo, hi, loOpen: true, hiOpen: !hiClosed, pinned: false } });
      }
      fullResults.set(key, r);
    }
  }

  // 11) 最近修正的完整重建结果（展示还原树）
  const fixR = fullResults.get(`${fix[0]}/${fix[1]}`);
  // 端点展示信息
  const loEp = { x: lo, included: false, usable: false,
    reason: '开端点：严格三角不等式（或悬挂边正权）取等，端点会落到路径上，不能成为规范树的叶' };
  let hiEp;
  if (hiClosed) {
    const r = hiOnGrid ? fullResults.get(`${grid(kHi)[0]}/${grid(kHi)[1]}`) : fullResults.get(`${hi[0]}/${hi[1]}`);
    hiEp = r.ok
      ? { x: hi, included: true, usable: true }
      : { x: hi, included: true, usable: false, reason: r.stage === 'validate' ? r.verdict.message : `规范校验失败：${r.recon.error}` };
  } else {
    hiEp = { x: hi, included: false, usable: false, reason: '开端点：三角不等式取等，端点不能成为规范树的叶' };
  }

  return {
    ok: true, p, q, original, step,
    interval: { lo, hi, loOpen: true, hiOpen: !hiClosed, pinned: false },
    triangleInterval: { lo: tLo, hi: tHi },
    grid: { kLo, kHi, lo: grid(kLo), hi: grid(kHi), count: gridCount,
            fullReconstructed, perGridPipeline: !affineUsed },
    endpoints: { lo: loEp, hi: hiEp },
    midpoint: xStar,
    fix,
    delta: F.sub(fix, original),
    fixAtOriginal: F.eq(fix, original),
    fixModel: fixR.model,
    fixRecon: fixR.recon,
  };
}

export { withValue };
