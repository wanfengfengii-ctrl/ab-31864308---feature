// metric.js — 度量校验 + 邻接法建树，全程精确有理数
import * as F from './fraction.js';
import { parseDecimalToken } from './matrixio.js';

// ---------------------------------------------------------------------------
// 解析与校验
// cells: string[n][n]（对角可为 0 或空）；labels: string[n]
// 返回 { ok, matrix?: F[][]（精确分数，原始单位）, scale: BigInt（统一位移）,
//        scaled?: bigint[][]（统一缩放后的非负整数）, decimals, error? }
// ---------------------------------------------------------------------------
export function buildModel(labels, cells) {
  const n = cells.length;
  if (n < 4 || n > 40) return { ok: false, error: `端点数必须在 4–40 之间（当前 ${n}）` };

  // 唯一性
  const seen = new Set();
  for (const l of labels) {
    const key = String(l).trim();
    if (!key) return { ok: false, error: '存在空的端点编号' };
    if (seen.has(key)) return { ok: false, error: `端点编号重复：${key}` };
    seen.add(key);
  }

  for (const row of cells) {
    if (row.length !== n) return { ok: false, error: '矩阵必须为方阵' };
  }

  // 解析全部 token，记录最大小数位
  const parsed = Array.from({ length: n }, () => Array(n));
  let digits = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const tok = cells[i][j] === '' || cells[i][j] == null ? '0' : String(cells[i][j]).trim();
      const p = parseDecimalToken(tok);
      if (!p) {
        return { ok: false, error: `单元格 (${labels[i]}, ${labels[j]}) 不是合法十进制数：“${cells[i][j]}”`, cell: [i, j] };
      }
      if (p.digits > 3) {
        return { ok: false, error: `单元格 (${labels[i]}, ${labels[j]}) 小数位超过三位：“${cells[i][j]}”`, cell: [i, j] };
      }
      digits = Math.max(digits, p.digits);
      parsed[i][j] = p;
    }
  }

  const scale = 10n ** BigInt(digits);
  const scaled = [];
  const matrix = [];
  for (let i = 0; i < n; i++) {
    const sr = [], mr = [];
    for (let j = 0; j < n; j++) {
      // 统一位移：不足位数补零
      const v = parsed[i][j].int * (10n ** BigInt(digits - parsed[i][j].digits));
      sr.push(v);
      mr.push(F.fr(v, scale));
    }
    scaled.push(sr);
    matrix.push(mr);
  }

  // 对角为零
  for (let i = 0; i < n; i++) {
    if (scaled[i][i] !== 0n) {
      return { ok: false, error: `对角线必须为 0：d(${labels[i]}, ${labels[i]}) = ${cells[i][i]}`, cell: [i, i], matrix, scale, scaled, decimals: digits };
    }
  }
  // 对称
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (scaled[i][j] !== scaled[j][i]) {
        return {
          ok: false, kind: 'asymmetry',
          error: `矩阵不对称：d(${labels[i]}, ${labels[j]}) = ${cells[i][j]} ≠ d(${labels[j]}, ${labels[i]}) = ${cells[j][i]}`,
          cells: [[i, j], [j, i]],
          matrix, scale, scaled, decimals: digits,
        };
      }
    }
  }
  // 非对角正数
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (scaled[i][j] <= 0n) {
        return {
          ok: false, kind: 'nonpositive',
          error: `非对角元素必须为正数：d(${labels[i]}, ${labels[j]}) = ${cells[i][j]}`,
          cells: [[i, j], [j, i]],
          matrix, scale, scaled, decimals: digits,
        };
      }
    }
  }

  return { ok: true, matrix, scaled, scale, decimals: digits };
}

// ---------------------------------------------------------------------------
// 三角不等式校验（精确）。
// 返回字典序最早（按端点编号排序后 (a,b,c)，a<b<c）的反例：
// 严格违反 d(a,b)+d(b,c) < d(a,c)；相等（退化）时作为退化提示附带返回。
// ---------------------------------------------------------------------------
export function findTriangleViolation(model, labels, order) {
  const { matrix } = model;
  const n = labels.length;
  // 同一三元组 {a,b,c}（a<b<c，按编号）需要检查三个方向，中间点依次为 b、a、c。
  // 严格违反全局优先于退化取等；同类内部按 (三元组字典序, 方向序号) 取最早。
  let strict = null;
  let degenerate = null;
  const dirsOf = (a, b, c) => [
    { mid: b, left: a, right: c, dir: 0 }, // d(a,b)+d(b,c)
    { mid: a, left: b, right: c, dir: 1 }, // d(b,a)+d(a,c)
    { mid: c, left: a, right: b, dir: 2 }, // d(a,c)+d(c,b)
  ];
  for (let x = 0; x < n; x++) {
    for (let y = x + 1; y < n; y++) {
      for (let z = y + 1; z < n; z++) {
        const a = order[x], b = order[y], c = order[z];
        for (const { mid, left, right, dir } of dirsOf(a, b, c)) {
          const dlm = matrix[left][mid], dmr = matrix[mid][right], dlr = matrix[left][right];
          const s = F.add(dlm, dmr);
          const key = (x * n * n + y * n + z) * 3 + dir;
          const make = isStrict => ({
            key, a, b, c, mid, left, right, degenerate: !isStrict,
            cells: [[left, mid], [mid, left], [mid, right], [right, mid], [left, right], [right, left]],
            message: isStrict
              ? `三角不等式反例：d(${labels[left]},${labels[mid]}) + d(${labels[mid]},${labels[right]}) = ${F.toDecimal(s)} < d(${labels[left]},${labels[right]}) = ${F.toDecimal(dlr)}`
              : `三角不等式退化反例：d(${labels[left]},${labels[mid]}) + d(${labels[mid]},${labels[right]}) = d(${labels[left]},${labels[right]}) = ${F.toDecimal(dlr)}，端点 ${labels[mid]} 落在 ${labels[left]}–${labels[right]} 的路径上，无法成为规范树的叶节点`,
          });
          if (F.lt(s, dlr) && (strict === null || key < strict.key)) strict = make(true);
          else if (F.eq(s, dlr) && (degenerate === null || key < degenerate.key)) degenerate = make(false);
        }
      }
    }
  }
  return { violation: strict || degenerate };
}

// ---------------------------------------------------------------------------
// 四点判据（精确）。
// 对任意 a<b<c<d，三个对边和
//   S1 = d(a,b)+d(c,d), S2 = d(a,c)+d(b,d), S3 = d(a,d)+d(b,c)
// 树度量 ⇔ 三个和的最大值恰好出现两次。
// 返回字典序最早反例。
// ---------------------------------------------------------------------------
export function findFourPointViolation(model, labels, order) {
  const { matrix } = model;
  const n = labels.length;
  for (let x = 0; x < n; x++) {
    for (let y = x + 1; y < n; y++) {
      for (let z = y + 1; z < n; z++) {
        for (let w = z + 1; w < n; w++) {
          const a = order[x], b = order[y], c = order[z], d = order[w];
          const s1 = F.add(matrix[a][b], matrix[c][d]);
          const s2 = F.add(matrix[a][c], matrix[b][d]);
          const s3 = F.add(matrix[a][d], matrix[b][c]);
          const m = F.maxF(F.maxF(s1, s2), s3);
          const ties = [F.eq(s1, m), F.eq(s2, m), F.eq(s3, m)].filter(Boolean).length;
          // 最大值出现两次（或三次全相等，对应四歧星型节点）均合法；
          // 最大值唯一（ties=1）即“无法形成两个相等最大值”，为反例。
          if (ties === 1) {
            return {
                violation: { a, b, c, d },
                sums: [s1, s2, s3],
                cells: [
                  [a, b], [b, a], [c, d], [d, c],
                  [a, c], [c, a], [b, d], [d, b],
                  [a, d], [d, a], [b, c], [c, b],
                ],
                message: `四点判据反例（${labels[a]},${labels[b]},${labels[c]},${labels[d]}）：` +
                  `d(${labels[a]},${labels[b]})+d(${labels[c]},${labels[d]})=${F.toDecimal(s1)}，` +
                  `d(${labels[a]},${labels[c]})+d(${labels[b]},${labels[d]})=${F.toDecimal(s2)}，` +
                  `d(${labels[a]},${labels[d]})+d(${labels[b]},${labels[c]})=${F.toDecimal(s3)}，` +
                  `最大值 ${F.toDecimal(m)} 仅出现一次（应出现两次）`,
            };
          }
        }
      }
    }
  }
  return { violation: null };
}

// 完整校验：先三角不等式，再四点判据。端点按编号字典序遍历以保证反例唯一最早。
export function validateMetric(model, labels) {
  const order = labels.map((_, i) => i)
    .sort((i, j) => (labels[i] < labels[j] ? -1 : labels[i] > labels[j] ? 1 : i - j));
  const t = findTriangleViolation(model, labels, order);
  if (t.violation) return { ok: false, kind: 'triangle', ...t.violation };
  const fp = findFourPointViolation(model, labels, order);
  if (fp.violation) {
    return {
      ok: false, kind: 'fourpoint',
      ...fp.violation,
      sums: fp.sums,
      cells: fp.cells,
      message: fp.message,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 邻接法（Neighbor-Joining），精确有理数。
// 输入 F[][]；输出无根树 { nodes:[{id,leaf,label?}], edges:[[u,v,w:F]] }。
// 叶节点 id = 0..n-1；内部节点 id 从 n 开始。
// ---------------------------------------------------------------------------
export function neighborJoin(matrix, labels) {
  const n = matrix.length;
  let D = matrix.map(r => r.slice());
  let active = Array.from({ length: n }, (_, i) => i);
  let nextId = n;
  const nodes = labels.map((l, i) => ({ id: i, leaf: true, label: l }));
  const edges = [];

  const addEdge = (u, v, w) => {
    if (F.isNeg(w)) {
      // 数值上不应出现（树度量保证），防御性夹到 0 以便结构展示
      w = F.ZERO;
    }
    edges.push([u, v, w]);
  };

  while (active.length > 3) {
    const m = active.length;
    // 行和 r_i = Σ D(i,j)
    const r = new Map();
    for (const i of active) {
      let s = F.ZERO;
      for (const j of active) if (i !== j) s = F.add(s, D[i][j]);
      r.set(i, s);
    }
    const denom = BigInt(m - 2);
    // Q(i,j) = (m-2) D(i,j) - r_i - r_j；找最小（字典序最早取平局）
    let best = null;
    for (let x = 0; x < m; x++) {
      for (let y = x + 1; y < m; y++) {
        const i = active[x], j = active[y];
        const q = F.sub(F.sub(F.mul(F.fr(denom), D[i][j]), r.get(i)), r.get(j));
        if (!best || F.lt(q, best.q)) best = { i, j, q };
      }
    }
    const { i, j } = best;
    // 枝长
    const wi = F.add(F.divInt(D[i][j], 2), F.divInt(F.sub(r.get(i), r.get(j)), 2 * Number(denom)));
    const wj = F.sub(D[i][j], wi);
    const u = nextId++;
    nodes.push({ id: u, leaf: false });
    addEdge(i, u, wi);
    addEdge(j, u, wj);
    // 为 u 分配新的行列
    D[u] = [];
    for (let t = 0; t < u; t++) D[u][t] = D[t][u] = F.ZERO;
    D[u][u] = F.ZERO;
    // 新节点 u 到其余各点的距离
    for (const k of active) {
      if (k === i || k === j) continue;
      D[u][k] = D[k][u] = F.divInt(F.sub(F.add(D[i][k], D[j][k]), D[i][j]), 2);
    }
    active = active.filter(x => x !== i && x !== j);
    active.push(u);
  }

  // 剩余三元组 i,j,k：星形连接到新中心（正距离保证三枝长均为正）
  const [i, j, k] = active;
  const u = nextId++;
  nodes.push({ id: u, leaf: false });
  const wi = F.divInt(F.add(F.sub(D[i][j], D[j][k]), D[i][k]), 2);
  const wj = F.sub(D[i][j], wi);
  const wk = F.sub(D[i][k], wi);
  addEdge(i, u, wi);
  addEdge(j, u, wj);
  addEdge(k, u, wk);

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// 收缩内部节点之间的零权边（四点判据三组和全相等时 NJ 会产生多歧零枝）。
// 叶边若为零则不收缩——叶不能并入内部节点（会破坏“叶恰为端点”），
// 那种情况留给规范校验报错。
// ---------------------------------------------------------------------------
export function contractZeroEdges(tree) {
  let { nodes, edges } = tree;
  let changed = true;
  while (changed) {
    changed = false;
    const nodeMap = new Map(nodes.map(v => [v.id, v]));
    for (const [a, b] of edges) {
      if (F.isZero(edges.find(([x, y]) => x === a && y === b)?.[2]) &&
          !nodeMap.get(a).leaf && !nodeMap.get(b).leaf) {
        // 将 b 并入 a：删除零边，b 的其他邻边改接到 a
        edges = edges
          .filter(([x, y]) => !(x === a && y === b))
          .map(([x, y, w]) => [x === b ? a : x, y === b ? a : y, w])
          .filter(([x, y]) => x !== y);
        nodes = nodes.filter(v => v.id !== b);
        changed = true;
        break;
      }
    }
  }
  return { nodes, edges };
}


export function verifyTree(tree, matrix, labels) {
  const { nodes, edges } = tree;
  const n = labels.length;
  const adj = new Map(nodes.map(v => [v.id, []]));
  const weight = new Map();
  for (const [u, v, w] of edges) {
    adj.get(u).push(v);
    adj.get(v).push(u);
    weight.set(`${u}|${v}`, w);
    weight.set(`${v}|${u}`, w);
  }

  const problems = [];
  // 叶集合
  const graphLeaves = nodes.filter(v => adj.get(v.id).length === 1);
  if (graphLeaves.length !== n || graphLeaves.some(v => !v.leaf || v.id >= n)) {
    problems.push('叶节点集合与端点集合不一致');
  }
  for (const v of nodes) {
    const deg = adj.get(v.id).length;
    if (!v.leaf && deg < 3) problems.push(`内部节点 #${v.id} 度数为 ${deg}（应 ≥ 3）`);
    if (deg === 0) problems.push(`节点 #${v.id} 孤立`);
  }
  for (const [u, v, w] of edges) {
    if (!F.isPos(w)) problems.push(`边 ${labelOf(u)}–${labelOf(v)} 权非正（${F.toDecimal(w)}）`);
  }

  function labelOf(id) {
    const v = nodes.find(x => x.id === id);
    return v && v.leaf ? v.label : `#${id}`;
  }

  // 连通性
  const seen = new Set([nodes[0].id]);
  const stack = [nodes[0].id];
  while (stack.length) {
    const x = stack.pop();
    for (const y of adj.get(x)) if (!seen.has(y)) { seen.add(y); stack.push(y); }
  }
  if (seen.size !== nodes.length) problems.push('树不连通');

  // 逐对叶路径长度核对（BFS 路径 + 分数求和）
  const pathLengths = [];
  for (let a = 0; a < n && problems.length === 0; a++) {
    for (let b = a + 1; b < n; b++) {
      const p = shortestPath(adj, a, b);
      if (!p) { problems.push(`${labels[a]} 与 ${labels[b]} 之间不存在路径`); break; }
      let s = F.ZERO;
      for (let t = 0; t < p.length - 1; t++) s = F.add(s, weight.get(`${p[t]}|${p[t + 1]}`));
      pathLengths.push([a, b, s, p]);
      if (!F.eq(s, matrix[a][b])) {
        problems.push(`路径核算不符：d_tree(${labels[a]},${labels[b]})=${F.toDecimal(s)} ≠ ${F.toDecimal(matrix[a][b])}`);
        break;
      }
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    pathLengths,
    adj,
    weight,
    labelOf,
  };
}

export function shortestPath(adj, src, dst) {
  const prev = new Map([[src, null]]);
  const q = [src];
  while (q.length) {
    const x = q.shift();
    if (x === dst) break;
    for (const y of adj.get(x)) if (!prev.has(y)) { prev.set(y, x); q.push(y); }
  }
  if (!prev.has(dst)) return null;
  const path = [];
  let cur = dst;
  while (cur !== null) { path.push(cur); cur = prev.get(cur); }
  return path.reverse();
}

// 完整重建流水线：返回 { ok, tree?, check?, error? }
export function reconstruct(model, labels) {
  let tree = neighborJoin(model.matrix, labels);
  tree = contractZeroEdges(tree);
  const check = verifyTree(tree, model.matrix, labels);
  if (!check.ok) {
    return { ok: false, error: check.problems.join('；'), tree, check };
  }
  return { ok: true, tree, check };
}
