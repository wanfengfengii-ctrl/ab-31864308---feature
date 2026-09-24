// samples.js — 内置样例。树型样例由显式边表精确生成叶间距矩阵。
import { format3 } from './matrixio.js';

// 边表 → 全部叶节点间距离（树，BFS 路径求和）
// edges: [[nodeA, nodeB, weight(number)]]；leaves: string[]
function treeDistances(leaves, edges) {
  const nodes = new Set();
  for (const [u, v] of edges) { nodes.add(u); nodes.add(v); }
  const adj = new Map([...nodes].map(x => [x, []]));
  for (const [u, v, w] of edges) {
    adj.get(u).push([v, w]);
    adj.get(v).push([u, w]);
  }
  function dist(s, t) {
    const prev = new Map([[s, null]]);
    const dw = new Map([[s, 0]]);
    const q = [s];
    while (q.length) {
      const x = q.shift();
      if (x === t) break;
      for (const [y, w] of adj.get(x)) {
        if (!prev.has(y)) { prev.set(y, x); dw.set(y, dw.get(x) + w); q.push(y); }
      }
    }
    return dw.get(t);
  }
  const cells = leaves.map((a, i) => leaves.map((b, j) =>
    i === j ? '0.000' : format3(dist(a, b))));
  return cells;
}

// 树度量样例：7 端点、3 个内部节点（分路/熔接点），内部度数 3、4、4
export function sampleTree() {
  const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const edges = [
    ['U', 'V', 1.20], ['V', 'W', 2.35],
    ['A', 'U', 0.80], ['B', 'U', 1.10],
    ['C', 'V', 0.60], ['D', 'V', 1.40],
    ['E', 'W', 0.90], ['F', 'W', 1.70], ['G', 'W', 2.10],
  ];
  return { labels, cells: treeDistances(labels, edges) };
}

// 星型样例：5 端点共一个四分以上中心，所有叶间距 = 2（臂长 1）
export function sampleStar() {
  const labels = ['A', 'B', 'C', 'D', 'E'];
  const cells = labels.map((_, i) =>
    labels.map((_, j) => i === j ? '0.000' : '2.000'));
  return { labels, cells };
}

// 三角不等式反例：取自真实树后把 d(A,C) 改坏（4.8 < 9）
export function sampleTriangleBad() {
  const { labels, cells } = sampleTree();
  const i = labels.indexOf('A'), j = labels.indexOf('C');
  cells[i][j] = cells[j][i] = '9.000';
  return { labels, cells };
}

// 四点判据反例（三角不等式全部成立，但三组对边和 8 / 10 / 12 无两个相等最大值）
export function sampleFourPointBad() {
  const labels = ['A', 'B', 'C', 'D'];
  const cells = [
    ['0.000', '4.000', '5.000', '7.000'],
    ['4.000', '0.000', '5.000', '5.000'],
    ['5.000', '5.000', '0.000', '4.000'],
    ['7.000', '5.000', '4.000', '0.000'],
  ];
  return { labels, cells };
}
