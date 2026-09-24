// 单链路漂移复原验收测试（Node 内置 test runner，无第三方依赖）
// 运行：node --test tests/repair.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../js/fraction.js';
import { buildModel, validateMetric, reconstruct } from '../js/metric.js';
import { repairSingleLink, withValue } from '../js/repair.js';
import { scaledToText } from '../js/matrixio.js';
import { sampleTree, sampleTriangleBad, sampleFourPointBad } from '../js/samples.js';

function repair(labels, cells, p, q) {
  const m = buildModel(labels, cells.map(r => r.map(String)));
  assert.equal(m.ok, true);
  return { model: m, res: repairSingleLink(m, labels, p, q) };
}

// 在某候选值上走既有完整流水线
function fullCheck(model, labels, p, q, x) {
  const cand = withValue(model, p, q, x);
  const v = validateMetric(cand, labels);
  if (!v.ok) return { ok: false, stage: 'validate' };
  const r = reconstruct(cand, labels);
  return r.ok ? { ok: true, cand } : { ok: false, stage: 'reconstruct' };
}

// ---------------------------------------------------------------- 点区间（钉死）
test('三角反例：正确疑似对 → 唯一钉点 2.6，修正后完整重建通过', () => {
  const s = sampleTriangleBad();
  const A = s.labels.indexOf('A'), C = s.labels.indexOf('C');
  const { model, res } = repair(s.labels, s.cells, A, C);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.interval.pinned, true);
  assert.ok(F.eq(res.interval.lo, F.fr(26, 10)));
  assert.ok(F.eq(res.interval.hi, F.fr(26, 10)));
  assert.equal(res.interval.loOpen, false);
  assert.equal(res.interval.hiOpen, false);
  assert.ok(F.eq(res.fix, F.fr(26, 10)));
  assert.ok(F.eq(res.delta, F.fr(-64, 10)));
  assert.equal(res.grid.count, 1n);
  // 修正还原的树为规范树（9 条边、3 个内部节点）
  assert.equal(res.fixRecon.tree.edges.length, 9);
  // 端点皆闭且可用
  assert.equal(res.endpoints.lo.usable, true);
  assert.equal(res.endpoints.hi.usable, true);
});

test('三角反例：错误疑似对 → 区间为空，明确无法单独解释', () => {
  const s = sampleTriangleBad();
  const A = s.labels.indexOf('A'), B = s.labels.indexOf('B');
  const { res } = repair(s.labels, s.cells, A, B);
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'empty');
  assert.match(res.error, /无法单独解释|允许区间为空/);
});

test('四点反例：各候选对给出精确钉点并各自可重建；错误修正值不合法', () => {
  const s = sampleFourPointBad();
  const cases = [
    [0, 3, '5.000'], // A-D：7 → 5
    [0, 1, '8.000'], // A-B：4 → 8
    [1, 2, '3.000'], // B-C：5 → 3
  ];
  for (const [p, q, want] of cases) {
    const { model, res } = repair(s.labels, s.cells, p, q);
    assert.equal(res.ok, true, res.error);
    assert.equal(res.interval.pinned, true);
    assert.equal(F.toFixed(res.fix, 3), want);
    assert.equal(res.fixRecon.tree.edges.length, 5);
    // 钉点两侧任意偏移都不合法
    const step = F.fr(1, 1000);
    assert.equal(fullCheck(model, s.labels, p, q, F.add(res.fix, step)).ok, false);
    assert.equal(fullCheck(model, s.labels, p, q, F.sub(res.fix, step)).ok, false);
  }
});

test('钉点冲突：固定证据互相矛盾时区间为空（两处污染不能靠一条链路解释）', () => {
  const s = sampleTree();
  const A = 0, B = 1, C = 2;
  s.cells[A][B] = s.cells[B][A] = '9.000';
  s.cells[A][C] = s.cells[C][A] = '9.000';
  const { res } = repair(s.labels, s.cells, B, C);
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'empty');
});

// ---------------------------------------------------------------- 区间交
test('区间复原：允许区间 = (|差|下界, 三角上界] 与内部边闭界的交集，端点为精确有理数', () => {
  const s = sampleTree();
  const A = 0, B = 1;
  s.cells[A][B] = s.cells[B][A] = '9.000';
  const { model, res } = repair(s.labels, s.cells, A, B);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.interval.pinned, false);
  // 下界严格：max|d(A,k)-d(B,k)| = 0.3；三角上界 5.5；内部边闭界 4.3 更紧
  assert.ok(F.eq(res.interval.lo, F.fr(3, 10)), F.toDecimal(res.interval.lo));
  assert.ok(F.eq(res.interval.hi, F.fr(43, 10)), F.toDecimal(res.interval.hi));
  assert.equal(res.interval.loOpen, true);   // 三角严格界
  assert.equal(res.interval.hiOpen, false);  // 内部边闭界
  // 网格范围与数量精确
  assert.ok(F.eq(res.grid.lo, F.fr(301, 1000)));
  assert.ok(F.eq(res.grid.hi, F.fr(4300, 1000)));
  assert.equal(res.grid.count, 4000n);
  // 区间交正确性：格界外的最近值必失败，界内抽样必通过完整流水线
  const step = F.fr(1, 1000);
  assert.equal(fullCheck(model, s.labels, A, B, F.sub(res.grid.lo, step)).ok, false); // 0.300 退化
  assert.equal(fullCheck(model, s.labels, A, B, F.add(res.grid.hi, step)).ok, false); // 4.301 四点违反
  for (const thou of [350, 800, 1500, 2333, 3000, 3700, 4299]) {
    const x = F.fr(BigInt(thou), 1000n);
    assert.equal(fullCheck(model, s.labels, A, B, x).ok, true, `内部点 ${thou} 应合法`);
  }
});

test('区间复原：穷尽复核网格点数（数千点）且最近修正取夹紧后的网格值', () => {
  const s = sampleTree();
  const A = 0, B = 1;
  // 原值落在区间下方（开界外）→ 最近可表示修正 = 下界后第一个网格点
  s.cells[A][B] = s.cells[B][A] = '0.300';
  let r = repair(s.labels, s.cells, A, B).res;
  assert.equal(r.ok, true, r.error);
  assert.ok(F.eq(r.fix, F.fr(301, 1000)));
  assert.ok(F.eq(r.delta, F.fr(1, 1000)));
  assert.equal(r.fixAtOriginal, false);

  // 原值已在网格内 → 无需修正
  const s2 = sampleTree();
  s2.cells[A][B] = s2.cells[B][A] = '0.500';
  r = repair(s2.labels, s2.cells, A, B).res;
  assert.equal(r.ok, true);
  assert.ok(F.eq(r.fix, F.fr(1, 2)));
  assert.equal(r.fixAtOriginal, true);
  assert.equal(F.toFixed(r.delta, 3), '0.000');

  // 原值远在区间上方 → 夹紧到闭上端点
  const s3 = sampleTree();
  s3.cells[A][B] = s3.cells[B][A] = '9.000';
  r = repair(s3.labels, s3.cells, A, B).res;
  assert.ok(F.eq(r.fix, F.fr(43, 10)));
});

// ---------------------------------------------------------------- 退化边界
test('退化边界：闭上端点可取（多歧收缩），开端点不可取', () => {
  const s = sampleTree();
  const A = 0, B = 1;
  s.cells[A][B] = s.cells[B][A] = '9.000';
  const { model, res } = repair(s.labels, s.cells, A, B);
  assert.equal(res.ok, true);

  // 开端点 0.3：不可取，明确原因
  assert.equal(res.endpoints.lo.included, false);
  assert.equal(res.endpoints.lo.usable, false);
  assert.match(res.endpoints.lo.reason, /三角不等式|叶/);

  // 闭端点 4.3：可取，完整重建成功，且内部边权归零被收缩（度 4 节点，边数 8 < 9）
  assert.equal(res.endpoints.hi.included, true);
  assert.equal(res.endpoints.hi.usable, true);
  const atHi = fullCheck(model, s.labels, A, B, F.fr(43, 10));
  assert.equal(atHi.ok, true);
  // 恰为闭端点的网格点 4.300 重建后含一个 4 度内部节点
  const rr = reconstruct(withValue(model, A, B, F.fr(43, 10)), s.labels);
  assert.equal(rr.ok, true);
  const degs = rr.tree.nodes.filter(v => !v.leaf).map(v => rr.check.adj.get(v.id).length);
  assert.ok(degs.some(d => d >= 4), `应有多歧节点，实际度数 ${degs.join(',')}`);
});

test('退化三元组：修复值落在开边界时区间为空（端点无法成为叶）', () => {
  // d(A,B)=1,d(B,C)=1,d(A,C)=2：B 退化在 A-C 路径上；四点钉点恰落在开边界
  const labels = ['A', 'B', 'C', 'D'];
  const cells = [
    ['0', '1', '2', '5'],
    ['1', '0', '1', '5'],
    ['2', '1', '0', '5'],
    ['5', '5', '5', '0'],
  ];
  const { res } = repair(labels, cells, 0, 3); // A-D 钉为 6 = 三角开上界
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'empty');
});

// ---------------------------------------------------------------- 星型（全多歧）
test('星型：污染一对后区间下界 0、闭上端点为叶臂长两倍，网格逐点合法', () => {
  const labels = ['A', 'B', 'C', 'D', 'E'];
  const cells = labels.map((_, i) => labels.map((_, j) => (i === j ? '0.000' : '2.000')));
  cells[0][1] = cells[1][0] = '3.000';
  const { model, res } = repair(labels, cells, 0, 1);
  assert.equal(res.ok, true, res.error);
  assert.ok(F.eq(res.interval.lo, F.ZERO));
  assert.equal(res.interval.loOpen, true);
  assert.ok(F.eq(res.interval.hi, F.fr(2)));
  assert.equal(res.interval.hiOpen, false);
  assert.equal(res.grid.count, 2000n);
  // 最近修正 = 2.0（闭端点，星心收缩为单个 5 度节点）
  assert.ok(F.eq(res.fix, F.fr(2)));
  assert.equal(res.fixRecon.tree.nodes.filter(v => !v.leaf).length, 1);
  assert.equal(res.fixRecon.check.adj.get(res.fixRecon.tree.nodes.find(v => !v.leaf).id).length, 5);
});

// ---------------------------------------------------------------- 回写兼容重建
test('一键回写：三位小数字符串写回后既有建模/校验/重建结果与修正模型逐项一致', () => {
  const s = sampleTriangleBad();
  const A = s.labels.indexOf('A'), C = s.labels.indexOf('C');
  const { model, res } = repair(s.labels, s.cells, A, C);
  assert.equal(res.ok, true);

  // 模拟 UI 的写回：分数 → 缩放整数 → 三位小数字符串
  const intVal = res.fix[0] * model.scale / res.fix[1];
  const txt = scaledToText(intVal, model.decimals);
  assert.equal(txt, '2.600');
  const written = s.cells.map(r => r.slice());
  written[A][C] = written[C][A] = txt;

  // 走既有 buildModel → validateMetric → reconstruct
  const m2 = buildModel(s.labels, written);
  assert.equal(m2.ok, true);
  assert.equal(validateMetric(m2, s.labels).ok, true);
  const r2 = reconstruct(m2, s.labels);
  assert.equal(r2.ok, true, r2.error);
  // 矩阵逐项等于修复模型
  for (let i = 0; i < s.labels.length; i++)
    for (let j = 0; j < s.labels.length; j++)
      assert.ok(F.eq(m2.matrix[i][j], res.fixModel.matrix[i][j]));
  // 全部叶对路径核算
  for (const [a, b, d] of r2.check.pathLengths) assert.ok(F.eq(d, m2.matrix[a][b]));
  // 780→ 21 对（7 端点）
  assert.equal(r2.check.pathLengths.length, 21);
});

test('回写后原矩阵合法：既有重建结果不被复原流程影响（回归）', () => {
  const s = sampleTree();
  const m = buildModel(s.labels, s.cells);
  assert.equal(validateMetric(m, s.labels).ok, true);
  const r = reconstruct(m, s.labels);
  assert.equal(r.ok, true);
  assert.equal(r.check.pathLengths.length, 21);
});

// ---------------------------------------------------------------- 输入校验
test('非法疑似对（同一端点/越界）被拒', () => {
  const s = sampleTriangleBad();
  const m = buildModel(s.labels, s.cells);
  assert.equal(repairSingleLink(m, s.labels, 1, 1).ok, false);
  assert.equal(repairSingleLink(m, s.labels, -1, 2).ok, false);
  assert.equal(repairSingleLink(m, s.labels, 1, 99).ok, false);
});

// ---------------------------------------------------------------- 大区间仿射复核
test('大区间（候选 >5000）：仿射穷尽复核路径正确，随机网格点独立完整重建一致', () => {
  // 5 端点星型，臂长 10000：叶间距 20000，污染 A-B=30000 → 允许 (0, 20000]，2 千万个网格点
  const labels = ['A', 'B', 'C', 'D', 'E'];
  const cells = labels.map((_, i) => labels.map((_, j) => (i === j ? '0.000' : '20000.000')));
  cells[0][1] = cells[1][0] = '30000.000';
  const { model, res } = repair(labels, cells, 0, 1);
  assert.equal(res.ok, true, res.error);
  assert.ok(res.grid.count > 5000n);
  assert.equal(res.grid.perGridPipeline, false); // 走仿射等价复核
  assert.ok(F.eq(res.interval.lo, F.ZERO));
  assert.ok(F.eq(res.interval.hi, F.fr(20000)));
  assert.equal(res.interval.hiOpen, false);
  assert.ok(F.eq(res.fix, F.fr(20000)));

  // 对区间内随机网格点独立走完整主流水线，必须全部通过（含逐对路径核算）
  for (let i = 0; i < 20; i++) {
    const k = 1n + BigInt(Math.floor(Math.random() * 19999999));
    const xx = F.fr(k, 1000n);
    const r = fullCheck(model, labels, 0, 1, xx);
    assert.equal(r.ok, true, `随机网格点 ${F.toDecimal(xx)} 完整流水线失败`);
  }
  // 闭上端点与首个内点
  assert.equal(fullCheck(model, labels, 0, 1, F.fr(20000)).ok, true);
  assert.equal(fullCheck(model, labels, 0, 1, F.fr(1, 1000)).ok, true);
});

// 两处污染：只有真正失真的那一对可单独解释；分析另一对（其读数本身未失真）
// 时区间为空，维护人员据此判定“不能只改这一条”
test('两处污染时：仅真正失真对可修复；把未失真对当嫌疑对 → 区间为空', () => {
  const s = sampleTree();
  const A = 0, B = 1, C = 2, D = 3;
  s.cells[C][D] = s.cells[D][C] = '9.000'; // 只污染 C-D
  // 正确嫌疑对 C-D：可修复（A、B 同在 U 下，C-D 为跨树距）
  const good = repair(s.labels, s.cells, C, D).res;
  assert.equal(good.ok, true, good.error);
  assert.equal(F.toFixed(good.fix, 3), '2.000'); // 真值 d(C,D)=0.6+1.2+0.2? = 见下断言
  // 修正模型必须是树度量
  assert.equal(validateMetric(good.fixModel, s.labels).ok, true);
  // 未失真的嫌疑对 A-B：固定证据中的 C-D 矛盾不经 A-B → 区间为空
  const bad = repair(s.labels, s.cells, A, B).res;
  assert.equal(bad.ok, false);
  assert.equal(bad.kind, 'empty');
});
