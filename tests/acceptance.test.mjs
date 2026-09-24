// 验收测试（Node 内置 test runner，无第三方依赖）
// 运行：node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../js/fraction.js';
import { buildModel, validateMetric, reconstruct } from '../js/metric.js';
import { parseMatrixText, modelToText } from '../js/matrixio.js';
import { sampleTree, sampleStar, sampleTriangleBad, sampleFourPointBad } from '../js/samples.js';

const L = (s) => s;

function build(labels, cells) {
  return buildModel(labels, cells.map(r => r.map(String)));
}

// 显式边表生成整数距离矩阵
function treeMatrix(n, edges) {
  const N = Math.max(...edges.flatMap(e => [e[0], e[1]])) + 1;
  const INF = 1e15;
  const d = Array.from({ length: N }, () => Array(N).fill(INF));
  for (let i = 0; i < N; i++) d[i][i] = 0;
  for (const [u, v, w] of edges) d[u][v] = d[v][u] = w;
  for (let k = 0; k < N; k++)
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++)
        if (d[i][k] + d[k][j] < d[i][j]) d[i][j] = d[i][k] + d[k][j];
  const cells = [];
  for (let i = 0; i < n; i++) { cells.push([]); for (let j = 0; j < n; j++) cells[i][j] = String(d[i][j]); }
  return cells;
}

test('有理数：运算保持精确，无浮点误差', () => {
  const a = F.fr(1, 3), b = F.fr(1, 7);
  assert.ok(F.eq(F.add(a, b), F.fr(10, 21)));
  assert.ok(F.eq(F.mul(a, b), F.fr(1, 21)));
  assert.ok(F.eq(F.sub(b, a), F.fr(-4, 21)));
  assert.ok(F.lt(F.div(a, F.fr(3)), F.fr(1, 8)));
  // 0.1+0.2 经典浮点问题在缩放大整数下不存在
  const x = F.fr(1, 10), y = F.fr(2, 10);
  assert.ok(F.eq(F.add(x, y), F.fr(3, 10)));
});

test('buildModel：合法矩阵缩放为统一整数（三位小数 → 1000）', () => {
  const s = sampleTree();
  const m = buildModel(s.labels, s.cells);
  assert.equal(m.ok, true);
  assert.equal(m.decimals, 3);
  assert.equal(m.scale, 1000n);
  assert.ok(m.scaled.every(row => row.every(v => typeof v === 'bigint')));
});

test('buildModel：端点数越界 / 重复编号 / 非方阵被拒', () => {
  const tiny = build(['a', 'b', 'c'], [['0', '1', '1'], ['1', '0', '1'], ['1', '1', '0']]);
  assert.equal(tiny.ok, false);
  const dup = build(['a', 'a', 'c', 'd'],
    [['0', '1', '1', '1'], ['1', '0', '1', '1'], ['1', '1', '0', '1'], ['1', '1', '1', '0']]);
  assert.match(dup.error, /重复/);
  const ragged = buildModel(['a', 'b', 'c', 'd'], [['0', '1'], ['1', '0'], ['1'], ['1']]);
  assert.equal(ragged.ok, false);
});

test('buildModel：对角非零 / 非正数 / 不对称 / 超三位小数 / 非法 token', () => {
  const L4 = ['a', 'b', 'c', 'd'];
  assert.equal(build(L4, [['1', '1', '1', '1'], ['1', '0', '1', '1'], ['1', '1', '0', '1'], ['1', '1', '1', '0']]).ok, false);
  assert.equal(build(L4, [['0', '0', '1', '1'], ['0', '0', '1', '1'], ['1', '1', '0', '1'], ['1', '1', '1', '0']]).ok, false);
  const asym = build(L4, [['0', '1', '2', '3'], ['1.1', '0', '3', '4'], ['2', '3', '0', '5'], ['3', '4', '5', '0']]);
  assert.equal(asym.ok, false);
  assert.deepEqual(asym.cells, [[0, 1], [1, 0]]);
  const tooMany = [['0', '1.2345', '2', '3'], ['1.2345', '0', '3', '4'], ['2', '3', '0', '5'], ['3', '4', '5', '0']];
  assert.equal(buildModel(L4, tooMany).ok, false);
  const bad = build(L4, [['0', 'x', '2', '3'], ['x', '0', '3', '4'], ['2', '3', '0', '5'], ['3', '4', '5', '0']]);
  assert.equal(bad.ok, false);
});

test('三角不等式：严格违反返回字典序最早三元组并标注涉及单元格', () => {
  const s = sampleTriangleBad();
  const m = buildModel(s.labels, s.cells);
  const v = validateMetric(m, s.labels);
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'triangle');
  assert.equal(v.degenerate, false);
  assert.deepEqual([s.labels[v.left], s.labels[v.mid], s.labels[v.right]], ['A', 'B', 'C']);
  assert.match(v.message, /= 4\.8 </);
  assert.match(v.message, /= 9\.0/);
  assert.ok(v.cells.length === 6);
});

test('三角不等式：编号顺序打乱后仍按编号字典序定位', () => {
  // 同样的反例矩阵，行序为 D,C,B,A
  const s = sampleTriangleBad();
  const idx = Object.fromEntries(s.labels.map((l, i) => [l, i]));
  const orderL = ['D', 'C', 'B', 'A', 'E', 'F', 'G'];
  const cells = orderL.map(a => orderL.map(b => s.cells[idx[a]][idx[b]]));
  const m = buildModel(orderL, cells);
  const v = validateMetric(m, orderL);
  assert.equal(v.kind, 'triangle');
  assert.deepEqual([orderL[v.left], orderL[v.mid], orderL[v.right]].sort(), ['A', 'B', 'C']);
});

test('三角退化取等被识别为反例（端点无法成为叶）', () => {
  const g = [['0', '1', '2', '5'], ['1', '0', '1', '5'], ['2', '1', '0', '5'], ['5', '5', '5', '0']];
  const v = validateMetric(build(['A', 'B', 'C', 'D'], g), ['A', 'B', 'C', 'D']);
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'triangle');
  assert.equal(v.degenerate, true);
});

test('四点判据：三组对边和无两个相等最大值时给出最早反例', () => {
  const s = sampleFourPointBad();
  const m = buildModel(s.labels, s.cells);
  const v = validateMetric(m, s.labels);
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'fourpoint');
  // 8, 10, 12：最大值唯一
  assert.ok(F.eq(v.sums[0], F.fr(8)));
  assert.ok(F.eq(v.sums[1], F.fr(10)));
  assert.ok(F.eq(v.sums[2], F.fr(12)));
  assert.equal(v.cells.length, 12);
});

test('树度量样例：重建为规范无根树且全部叶对路径和逐项相等', () => {
  const s = sampleTree();
  const m = buildModel(s.labels, s.cells);
  const v = validateMetric(m, s.labels);
  assert.equal(v.ok, true);
  const r = reconstruct(m, s.labels);
  assert.equal(r.ok, true, r.error);

  const { tree, check } = r;
  // 叶恰为端点
  const leafIds = tree.nodes.filter(x => x.leaf).map(x => x.id).sort((a, b) => a - b);
  assert.deepEqual(leafIds, s.labels.map((_, i) => i));
  // 内部节点度数 >= 3
  for (const x of tree.nodes.filter(x => !x.leaf)) {
    assert.ok(check.adj.get(x.id).length >= 3);
  }
  // 边权为正
  for (const [, , w] of tree.edges) assert.ok(F.isPos(w));
  // 边数 = 节点数 - 1 = n + 内部节点数 - 1（规范允许多歧，二叉时为 2n-3）
  const internalCount = tree.nodes.filter(x => !x.leaf).length;
  assert.equal(tree.edges.length, s.labels.length + internalCount - 1);
  assert.ok(tree.edges.length <= 2 * s.labels.length - 3);
});

test('星型度量：零权内部边被收缩为单个高度数中心', () => {
  const s = sampleStar();
  const m = buildModel(s.labels, s.cells);
  assert.equal(validateMetric(m, s.labels).ok, true);
  const r = reconstruct(m, s.labels);
  assert.equal(r.ok, true, r.error);
  const internals = r.tree.nodes.filter(x => !x.leaf);
  assert.equal(internals.length, 1);
  assert.equal(r.check.adj.get(internals[0].id).length, 5);
  assert.equal(r.tree.edges.length, 5);
});

test('路径核算：任意两端点路径长度精确等于输入（分数级）', () => {
  const s = sampleTree();
  const m = buildModel(s.labels, s.cells);
  const r = reconstruct(m, s.labels);
  for (const [a, b, total] of r.check.pathLengths) {
    assert.ok(F.eq(total, m.matrix[a][b]),
      `${s.labels[a]}-${s.labels[b]}: ${F.toDecimal(total)} != ${F.toDecimal(m.matrix[a][b])}`);
  }
  // 已知结构值：A-G = 0.8+1.2+2.35+2.1 = 6.45
  const ai = s.labels.indexOf('A'), gi = s.labels.indexOf('G');
  const found = r.check.pathLengths.find(([a, b]) => a === ai && b === gi);
  assert.ok(found);
  assert.ok(F.eq(found[2], F.fr(645, 100)));
});

test('40 端点随机规范树：校验、重建与全部 780 对路径复核通过', () => {
  const n = 40;
  let E = [[0, n, 1], [1, n, 2], [2, n, 3]];
  let nextId = n + 1;
  for (let leaf = 3; leaf < n; leaf++) {
    const idx = Math.floor(Math.random() * E.length);
    const [u, v, w] = E[idx];
    const w1 = 1 + Math.floor(Math.random() * (w - 1 || 1));
    const w2 = w - w1 > 0 ? w - w1 : 1;
    const c = nextId++;
    E.splice(idx, 1);
    E.push([u, c, w1], [v, c, w2], [leaf, c, 1 + Math.floor(Math.random() * 9)]);
  }
  const labels = Array.from({ length: n }, (_, i) => `N${String(i + 1).padStart(2, '0')}`);
  const cells = treeMatrix(n, E);
  const m = buildModel(labels, cells);
  assert.equal(validateMetric(m, labels).ok, true);
  const r = reconstruct(m, labels);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.tree.edges.length, 2 * n - 3);
  assert.ok(r.tree.nodes.filter(x => !x.leaf).every(x => r.check.adj.get(x.id).length >= 3));
  assert.equal(r.check.pathLengths.length, 780);
});

test('缩放精确性：三位小数矩阵边权以 1000 为分母正确还原', () => {
  // 四叶树：中心 u,v；a-u=0.001 等，全部为三位小数
  const labels = ['a', 'b', 'c', 'd'];
  // 构造：u-a .100, u-b .200, u-v .300, v-c .400, v-d .500
  const cells = [
            /* a      b      c      d */
    /* a */ ['0',   '0.300', '0.800', '0.900'],
    /* b */ ['0.300', '0',   '0.900', '1.000'],
    /* c */ ['0.800', '0.900', '0',   '0.900'],
    /* d */ ['0.900', '1.000', '0.900', '0'],
  ];
  const m = buildModel(labels, cells);
  const r = reconstruct(m, labels);
  assert.equal(r.ok, true, r.error);
  const pendant = r.tree.edges
    .filter(([u, v]) => u < 4 || v < 4)
    .map(([, , w]) => w);
  const expected = [F.fr(100, 1000), F.fr(200, 1000), F.fr(400, 1000), F.fr(500, 1000)];
  for (const e of expected) assert.ok(pendant.some(w => F.eq(w, e)), `缺边权 ${F.toDecimal(e)}`);
  // 内部边 u-v = 0.300
  const internal = r.tree.edges.find(([u, v]) => u >= 4 && v >= 4);
  assert.ok(internal && F.eq(internal[2], F.fr(300, 1000)));
});

test('文本解析：纯矩阵 / 带表头 CSV / 仅行标签', () => {
  const plain = '0 1 2\n1 0 3\n2 3 0';
  // 3x3 可解析但建模会因 n<4 被拒；这里只测解析
  assert.deepEqual(parseMatrixText(plain).labels, ['E1', 'E2', 'E3']);

  const csv = ',A,B,C,D\nA,0,1,2,3\nB,1,0,3,4\nC,2,3,0,5\nD,3,4,5,0';
  const p = parseMatrixText(csv);
  assert.deepEqual(p.labels, ['A', 'B', 'C', 'D']);
  assert.equal(p.cells[0][1], '1');

  const rowOnly = 'A,0,1,2,3\nB,1,0,3,4\nC,2,3,0,5\nD,3,4,5,0';
  const q = parseMatrixText(rowOnly);
  assert.deepEqual(q.labels, ['A', 'B', 'C', 'D']);
  assert.equal(q.cells[3][0], '3');

  // 往返
  const s = sampleTree();
  const text = modelToText(s.labels, s.cells);
  const back = parseMatrixText(text);
  assert.deepEqual(back.labels, s.labels);
  assert.deepEqual(back.cells, s.cells);
});

test('解析失败：空文本 / 行列不齐', () => {
  assert.equal(parseMatrixText('').ok, false);
  const bad = '0 1 2\n1 0 3\n2 3';
  assert.equal(parseMatrixText(bad).ok, false);
});
