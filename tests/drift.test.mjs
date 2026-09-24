// 单链路漂移复原验收测试（Node 内置 test runner，无第三方依赖）
// 运行：node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../js/fraction.js';
import { buildModel, validateMetric, reconstruct } from '../js/metric.js';
import { parseMatrixText, modelToText } from '../js/matrixio.js';
import { sampleTree, sampleStar, sampleTriangleBad, sampleFourPointBad, sampleDrift } from '../js/samples.js';
import { restoreInterval, verifyCorrected, verifyIntervalValues } from '../js/drift.js';

const idx = (labels, name) => labels.indexOf(name);

// 把修正值写回矩阵拷贝
function written(cells, p, q, text) {
  const t = cells.map(r => r.slice());
  t[p][q] = text;
  t[q][p] = text;
  return t;
}

test('漂移复原·区间交：三角下界 × 四点半线上界取交后吸附三位小数网格', () => {
  const s = sampleDrift(); // d(A,B) 被污染为 9.000（真值 1.900）
  const p = idx(s.labels, 'A'), q = idx(s.labels, 'B');

  // 被污染矩阵确实未通过既有校验（三角不等式）
  const bad = buildModel(s.labels, s.cells);
  assert.equal(validateMetric(bad, s.labels).ok, false);

  const res = restoreInterval(s.labels, s.cells, p, q);
  assert.equal(res.ok, true);
  assert.equal(res.empty, false);
  assert.equal(res.degenerate, false);

  // 约束来源：三角下界 L=0.3、三角上界 U=5.5、四点半线上界 4.3 → 交集 (0.3, 4.3]
  assert.ok(F.eq(res.bounds.L, F.fr(3, 10)));
  assert.ok(F.eq(res.bounds.U, F.fr(11, 2)));
  assert.ok(F.eq(res.bounds.halfMin, F.fr(43, 10)));
  assert.equal(res.bounds.equalityCount, 0);

  // 网格吸附后的闭区间 [0.301, 4.300]，端点为缩放后的精确有理数
  assert.ok(F.eq(res.lo, F.fr(301, 1000)));
  assert.ok(F.eq(res.hi, F.fr(43, 10)));
  assert.equal(res.kMin, 301n);
  assert.equal(res.kMax, 4300n);
  assert.equal(res.gridCount, 4000n);

  // 距原值 9.000 最近的可用修正为区间上端 4.300
  assert.equal(res.correctionText, '4.300');
  assert.ok(F.eq(res.delta, F.fr(-47, 10)));

  // 区间内全部 4000 个三位小数取值逐项通过三角/四点/重建/逐对核算（全量复核）
  const cov = verifyIntervalValues(s.labels, s.cells, p, q, res, 5000);
  assert.equal(cov.exhaustive, true);
  assert.equal(cov.checked, 4000);
  assert.equal(cov.ok, true, cov.firstFailure && JSON.stringify(cov.firstFailure));

  // 区间紧贴边界：紧邻网格外侧的 0.300 与 4.301 均不可行
  assert.equal(verifyCorrected(s.labels, s.cells, p, q, '0.300').ok, false);
  assert.equal(verifyCorrected(s.labels, s.cells, p, q, '4.301').ok, false);
});

test('漂移复原·退化边界：四点等式约束把区间压成单点', () => {
  // 三角反例样例：d(A,C) 被污染为 9.000（真值 2.600）
  const s = sampleTriangleBad();
  const p = idx(s.labels, 'A'), q = idx(s.labels, 'C');
  const res = restoreInterval(s.labels, s.cells, p, q);
  assert.equal(res.ok, true);
  assert.equal(res.empty, false);
  assert.equal(res.degenerate, true);
  assert.ok(F.eq(res.lo, F.fr(13, 5)));
  assert.ok(F.eq(res.hi, res.lo));
  assert.equal(res.gridCount, 1n);
  assert.equal(res.correctionText, '2.600');

  // 写回单点修正后既有流水线全部通过，且 A–C 路径和精确等于 2.6
  const v = verifyCorrected(s.labels, s.cells, p, q, '2.600');
  assert.equal(v.ok, true, v.error);
  const found = v.check.pathLengths.find(([a, b]) => a === p && b === q);
  assert.ok(found && F.eq(found[2], F.fr(13, 5)));

  // 四点反例样例（n=4）：唯一四元组给出等式 x = 8
  const s4 = sampleFourPointBad();
  const res4 = restoreInterval(s4.labels, s4.cells, idx(s4.labels, 'A'), idx(s4.labels, 'B'));
  assert.equal(res4.empty, false);
  assert.equal(res4.degenerate, true);
  assert.ok(F.eq(res4.lo, F.fr(8)));
  assert.equal(verifyCorrected(s4.labels, s4.cells, 0, 1, '8.000').ok, true);
});

test('漂移复原·空区间：固定证据自相矛盾时明确该链路无法单独解释', () => {
  // 固定三元组 {C,D,E} 违反三角不等式（与疑似链路 (A,B) 无关）
  const labels = ['A', 'B', 'C', 'D', 'E'];
  const cells = [
    ['0', '3', '2', '2', '2'],
    ['3', '0', '2', '2', '2'],
    ['2', '2', '0', '1', '5'],
    ['2', '2', '1', '0', '1'],
    ['2', '2', '5', '1', '0'],
  ];
  const res = restoreInterval(labels, cells, 0, 1);
  assert.equal(res.ok, true);
  assert.equal(res.empty, true);
  assert.equal(res.reason, 'fixed-triangle');
  assert.match(res.message, /无法作为|自相矛盾|三角不等式/);
  assert.ok(res.cells.length === 6);

  // 固定读数不对称（疑点对之外）→ 证据不合法，同样为空
  const asym = [
    ['0', '3', '2', '2', '2'],
    ['3', '0', '2', '2', '2'],
    ['2', '2.5', '0', '1', '2'],
    ['2', '2', '1', '0', '1'],
    ['2', '2', '2', '1', '0'],
  ];
  const res2 = restoreInterval(labels, asym, 0, 1);
  assert.equal(res2.empty, true);
  assert.equal(res2.reason, 'fixed-invalid');
});

test('漂移复原·最近修正：原值低于区间时夹到下端', () => {
  const s = sampleTree();
  const p = idx(s.labels, 'A'), q = idx(s.labels, 'B');
  s.cells[p][q] = s.cells[q][p] = '0.100'; // 真值 1.900，漂移到区间 (0.300, 4.300] 之下
  const m = buildModel(s.labels, s.cells);
  assert.equal(validateMetric(m, s.labels).ok, false);

  const res = restoreInterval(s.labels, s.cells, p, q);
  assert.equal(res.empty, false);
  assert.equal(res.correctionText, '0.301');
  assert.ok(F.eq(res.correction, res.lo));
  assert.ok(F.gt(res.delta, F.ZERO)); // 向上修正
  assert.equal(verifyCorrected(s.labels, s.cells, p, q, '0.301').ok, true);
});

test('漂移复原·星型大区间：抽样复核路径与正性下界', () => {
  const s = sampleStar(); // 全部叶间距 2.000
  const p = idx(s.labels, 'A'), q = idx(s.labels, 'B');
  s.cells[p][q] = s.cells[q][p] = '3.500';
  const m = buildModel(s.labels, s.cells);
  assert.equal(validateMetric(m, s.labels).ok, false);

  const res = restoreInterval(s.labels, s.cells, p, q);
  assert.equal(res.empty, false);
  // (0, 4) ∩ (x ≤ 2) ∩ (x > 0) → 网格 [0.001, 2.000]
  assert.ok(F.eq(res.lo, F.fr(1, 1000)));
  assert.ok(F.eq(res.hi, F.fr(2)));
  assert.equal(res.gridCount, 2000n);
  assert.equal(res.correctionText, '2.000');

  // 小 maxChecks 走抽样路径：端点 + 修正 + 均匀抽样
  const cov = verifyIntervalValues(s.labels, s.cells, p, q, res, 60);
  assert.equal(cov.exhaustive, false);
  assert.ok(cov.checked <= 60);
  assert.equal(cov.ok, true, cov.firstFailure && JSON.stringify(cov.firstFailure));
});

test('回写后的兼容重建：写回修正值后既有流水线、反例排序与 CSV 行为不变', () => {
  const s = sampleDrift();
  const p = idx(s.labels, 'A'), q = idx(s.labels, 'B');
  const res = restoreInterval(s.labels, s.cells, p, q);
  assert.equal(res.empty, false);

  // 一键写回
  const cells = written(s.cells, p, q, res.correctionText);

  // 既有流水线：解析缩放 → 三角 → 四点 → 重建 → 逐对核算
  const m = buildModel(s.labels, cells);
  assert.equal(m.ok, true);
  assert.equal(m.scale, 1000n); // 三位小数统一缩放
  assert.equal(validateMetric(m, s.labels).ok, true);
  const r = reconstruct(m, s.labels);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.check.pathLengths.length, (s.labels.length * (s.labels.length - 1)) / 2);
  for (const [a, b, total] of r.check.pathLengths) {
    assert.ok(F.eq(total, m.matrix[a][b]));
  }
  // 被修正链路的路径和精确等于写回值 4.300
  const ab = r.check.pathLengths.find(([a, b]) => a === p && b === q);
  assert.ok(ab && F.eq(ab[2], F.fr(43, 10)));
  // 规范树性质：内部节点度数 ≥ 3、边权为正
  for (const v of r.tree.nodes.filter(x => !x.leaf)) {
    assert.ok(r.check.adj.get(v.id).length >= 3);
  }
  for (const [, , w] of r.tree.edges) assert.ok(F.isPos(w));

  // CSV 导出/导入行为不变：写回后的矩阵可无损往返
  const text = modelToText(s.labels, cells);
  const back = parseMatrixText(text);
  assert.equal(back.ok, true);
  assert.deepEqual(back.labels, s.labels);
  assert.deepEqual(back.cells, cells);

  // 既有反例排序不受影响：同样的污染矩阵仍定位同一最早反例（三元组 {A,B,C}）
  const badAgain = buildModel(s.labels, s.cells);
  const v1 = validateMetric(badAgain, s.labels);
  assert.equal(v1.ok, false);
  assert.equal(v1.kind, 'triangle');
  assert.deepEqual([s.labels[v1.left], s.labels[v1.mid], s.labels[v1.right]].sort(), ['A', 'B', 'C']);
  assert.match(v1.message, /5\.5 </);
});

test('漂移复原·疑点对读数异常也能复原（不对称 / 无法解析的读数被忽略）', () => {
  // 疑点两格不对称：以固定证据为准复原
  const s = sampleTree();
  const p = idx(s.labels, 'A'), q = idx(s.labels, 'B');
  s.cells[p][q] = '9.000';
  s.cells[q][p] = '7.500';
  const res = restoreInterval(s.labels, s.cells, p, q);
  assert.equal(res.empty, false);
  assert.equal(res.original.asymmetric, true);
  assert.equal(res.correctionText, '4.300'); // 距 9.000（p,q 格）最近
  assert.equal(verifyCorrected(s.labels, s.cells, p, q, '4.300').ok, true);

  // 疑点格无法解析：原值不可用，取区间下端
  const s2 = sampleTree();
  s2.cells[p][q] = s2.cells[q][p] = 'N/A';
  const res2 = restoreInterval(s2.labels, s2.cells, p, q);
  assert.equal(res2.empty, false);
  assert.equal(res2.original.value, null);
  assert.equal(res2.correctionText, '0.301');
});

test('漂移复原·随机规范树：污染任意链路后区间含真值且修正可重建', () => {
  // 随机 12 端点规范树（整数边权），随机选一对端点污染后复原
  const n = 12;
  let E = [[0, n, 1], [1, n, 2], [2, n, 3]];
  let nextId = n + 1;
  let seed = 20260924;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
  for (let leaf = 3; leaf < n; leaf++) {
    const k = Math.floor(rnd() * E.length);
    const [u, v, w] = E[k];
    const w1 = 1 + Math.floor(rnd() * (w - 1 || 1));
    const w2 = w - w1 > 0 ? w - w1 : 1;
    const c = nextId++;
    E.splice(k, 1);
    E.push([u, c, w1], [v, c, w2], [leaf, c, 1 + Math.floor(rnd() * 9)]);
  }
  const N = nextId;
  const INF = 1e15;
  const d = Array.from({ length: N }, () => Array(N).fill(INF));
  for (let i = 0; i < N; i++) d[i][i] = 0;
  for (const [u, v, w] of E) d[u][v] = d[v][u] = w;
  for (let k = 0; k < N; k++)
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++)
        if (d[i][k] + d[k][j] < d[i][j]) d[i][j] = d[i][k] + d[k][j];

  const labels = Array.from({ length: n }, (_, i) => `N${i + 1}`);
  const good = labels.map((_, i) => labels.map((_, j) => (i === j ? '0' : String(d[i][j]))));

  for (const [p, q] of [[0, 1], [3, 7], [5, 11]]) {
    const trueVal = d[p][q];
    const cells = good.map(r => r.slice());
    cells[p][q] = cells[q][p] = String(trueVal + 17); // 漂移 +17
    const res = restoreInterval(labels, cells, p, q);
    assert.equal(res.ok, true);
    assert.equal(res.empty, false, `链路 ${p}-${q} 区间不应为空`);
    // 真值落在区间内（闭区间含端点）
    assert.ok(!F.lt(F.fr(trueVal), res.lo) && !F.gt(F.fr(trueVal), res.hi),
      `真值 ${trueVal} 应在 [${F.toDecimal(res.lo)}, ${F.toDecimal(res.hi)}]`);
    // 区间内三位小数取值全部通过完整流水线（区间可能很大，限制全量上限）
    const cov = verifyIntervalValues(labels, cells, p, q, res, 400);
    assert.equal(cov.ok, true, cov.firstFailure && JSON.stringify(cov.firstFailure));
    // 最近修正写回后可重建
    assert.equal(verifyCorrected(labels, cells, p, q, res.correctionText).ok, true);
  }
});
