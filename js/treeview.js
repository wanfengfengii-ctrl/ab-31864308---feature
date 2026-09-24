// treeview.js — 无根树的 SVG 渲染：径向（权重比例）与直角分支图两种布局
import * as F from './fraction.js';

const SVGNS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

// 构造邻接（保留分数边权）
function buildAdj(tree) {
  const adj = new Map(tree.nodes.map(v => [v.id, []]));
  for (const [u, v, w] of tree.edges) {
    adj.get(u).push({ to: v, w });
    adj.get(v).push({ to: u, w });
  }
  return adj;
}

// 以 root 为根：返回 parent / children / 排序后的 DFS 顺序（子树按最小叶标签排序）
function rootTree(tree, adj, root) {
  const parent = new Map([[root, null]]);
  const pedge = new Map();
  const order = [];
  (function dfs(x) {
    order.push(x);
    const kids = adj.get(x)
      .filter(e => e.to !== parent.get(x))
      .map(e => e.to);
    for (const k of kids) { parent.set(k, x); pedge.set(k, adj.get(x).find(e => e.to === k).w); dfs(k); }
  })(root);
  const children = new Map(tree.nodes.map(v => [v.id, []]));
  for (const [k, p] of parent) if (p !== null) children.get(p).push(k);
  const minLeaf = new Map();
  for (const id of [...order].reverse()) {
    const node = tree.nodes.find(v => v.id === id);
    let m = node.leaf ? node.label : null;
    for (const k of children.get(id)) {
      const km = minLeaf.get(k);
      if (m === null || (km !== null && km < m)) m = km;
    }
    minLeaf.set(id, m);
  }
  for (const arr of children.values()) {
    arr.sort((a, b) => {
      const x = minLeaf.get(a), y = minLeaf.get(b);
      return (x === null) - (y === null) || (x < y ? -1 : x > y ? 1 : 0);
    });
  }
  return { parent, children, pedge };
}

// 主渲染
// opts: { layout: 'radial'|'cladogram', rootId, showWeights, onLeafClick }
export function renderTree(svg, tree, labels, opts) {
  const viewport = svg.querySelector(`#${opts.viewportId || 'treeViewport'}`);
  viewport.innerHTML = '';

  const adj = buildAdj(tree);
  const { children, pedge, parent } = rootTree(tree, adj, opts.rootId);

  // 每个节点下的叶序号区间（按叶子排序后的角度/纵向位置）
  const leafPos = new Map();
  const subtreeSpan = new Map();
  let leafCount = 0;
  (function place(x) {
    const node = tree.nodes.find(v => v.id === x);
    if (node.leaf) {
      leafPos.set(x, leafCount++);
      subtreeSpan.set(x, [leafPos.get(x), leafPos.get(x)]);
      return;
    }
    for (const k of children.get(x)) place(k);
    const lo = subtreeSpan.get(children.get(x)[0])[0];
    const hi = subtreeSpan.get(children.get(x)[children.get(x).length - 1])[1];
    subtreeSpan.set(x, [lo, hi]);
  })(opts.rootId);

  const W = svg.clientWidth || 800;
  const H = svg.clientHeight || 480;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const pos = new Map();      // id -> [x,y]
  const edgeGeom = new Map(); // "u|v" -> path d

  if (opts.layout === 'radial') {
    // 径向：角度按叶序均分；半径与根到节点的精确距离成比例
    const cx = W / 2, cy = H / 2;
    const rootDist = new Map([[opts.rootId, F.ZERO]]);
    (function dists(x) {
      for (const k of children.get(x)) {
        rootDist.set(k, F.add(rootDist.get(x), pedge.get(k)));
        dists(k);
      }
    })(opts.rootId);
    let maxD = F.ONE;
    for (const [, d] of rootDist) if (F.gt(d, maxD)) maxD = d;
    const maxR = Math.min(W, H) / 2 - 70;
    const angleOf = (p) => labels.length === 1 ? -Math.PI / 2
      : -Math.PI / 2 + (p / Math.max(1, leafCount - 1)) * Math.PI * 2;
    for (const v of tree.nodes) {
      const node = tree.nodes.find(z => z.id === v.id);
      let angle;
      if (node.leaf) angle = angleOf(leafPos.get(v.id));
      else {
        const [lo, hi] = subtreeSpan.get(v.id);
        angle = (angleOf(lo) + angleOf(hi)) / 2;
      }
      const r = maxR * F.toNumber(F.div(rootDist.get(v.id), maxD));
      pos.set(v.id, [cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
    }
    for (const [u, v] of tree.edges.map(e => [e[0], e[1]])) {
      const [x1, y1] = pos.get(u), [x2, y2] = pos.get(v);
      edgeGeom.set(`${u}|${v}`, `M ${x1} ${y1} L ${x2} ${y2}`);
    }
  } else {
    // 直角分支图：纵向叶序均匀；x 为根到节点距离
    const padL = 60, padR = 90, padT = 30, padB = 30;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const rootDist = new Map([[opts.rootId, F.ZERO]]);
    (function dists(x) {
      for (const k of children.get(x)) {
        rootDist.set(k, F.add(rootDist.get(x), pedge.get(k)));
        dists(k);
      }
    })(opts.rootId);
    let maxD = F.ONE;
    for (const [, d] of rootDist) if (F.gt(d, maxD)) maxD = d;
    const yOf = (p) => leafCount <= 1 ? H / 2 : padT + (p / (leafCount - 1)) * plotH;
    for (const v of tree.nodes) {
      const node = tree.nodes.find(z => z.id === v.id);
      const y = node.leaf ? yOf(leafPos.get(v.id))
        : yOf((subtreeSpan.get(v.id)[0] + subtreeSpan.get(v.id)[1]) / 2);
      const x = padL + plotW * F.toNumber(F.div(rootDist.get(v.id), maxD));
      pos.set(v.id, [x, y]);
    }
    for (const [u, v] of tree.edges.map(e => [e[0], e[1]])) {
      const [x1, y1] = pos.get(u), [x2, y2] = pos.get(v);
      const xm = (x1 + x2) / 2;
      edgeGeom.set(`${u}|${v}`, `M ${x1} ${y1} L ${xm} ${y1} L ${xm} ${y2} L ${x2} ${y2}`);
    }
  }

  // 绘制
  const edgeLayer = el('g', { class: 'edge-layer' });
  const nodeLayer = el('g', { class: 'node-layer' });
  const labelLayer = el('g', { class: 'label-layer' });
  viewport.append(edgeLayer, nodeLayer, labelLayer);

  const edgeEls = new Map();
  const weightEls = new Map();
  for (const [u, v, w] of tree.edges) {
    const path = el('path', { class: 'edge', d: edgeGeom.get(`${u}|${v}`) });
    edgeLayer.appendChild(path);
    edgeEls.set(`${u}|${v}`, path);
    edgeEls.set(`${v}|${u}`, path);
    if (opts.showWeights) {
      const [x1, y1] = pos.get(u), [x2, y2] = pos.get(v);
      const t = el('text', {
        class: 'wlabel',
        x: (x1 + x2) / 2 + 3,
        y: (y1 + y2) / 2 - 3,
      }, F.toDecimal(w, 3));
      labelLayer.appendChild(t);
      weightEls.set(`${u}|${v}`, t);
      weightEls.set(`${v}|${u}`, t);
    }
  }

  const nodeEls = new Map();
  const labelEls = new Map();
  for (const v of tree.nodes) {
    const [x, y] = pos.get(v.id);
    if (v.leaf) {
      const c = el('circle', { class: 'node-leaf', cx: x, cy: y, r: 6 });
      nodeLayer.appendChild(c);
      nodeEls.set(v.id, c);
      let tx = x + 9, ty = y + 4, anchor = 'start';
      if (opts.layout === 'radial') {
        const ang = Math.atan2(y - H / 2, x - W / 2);
        anchor = Math.cos(ang) >= 0 ? 'start' : 'end';
        tx = x + (Math.cos(ang) >= 0 ? 9 : -9);
      }
      const t = el('text', { class: 'llabel', x: tx, y: ty, 'text-anchor': anchor }, v.label);
      t.addEventListener('click', () => opts.onLeafClick && opts.onLeafClick(v.id));
      labelLayer.appendChild(t);
      labelEls.set(v.id, t);
    } else {
      const c = el('rect', {
        class: 'node-internal',
        x: x - 5, y: y - 5, width: 10, height: 10, rx: 2,
      });
      c.appendChild(el('title', {}, `内部节点（分路/熔接）id=${v.id}，度数 ${adj.get(v.id).length}`));
      nodeLayer.appendChild(c);
      nodeEls.set(v.id, c);
    }
  }

  // 路径高亮
  function setHotPath(pathIds) {
    const hotNodes = new Set(pathIds);
    const hotEdges = new Set();
    for (let i = 0; i < pathIds.length - 1; i++) {
      hotEdges.add(`${pathIds[i]}|${pathIds[i + 1]}`);
    }
    for (const [key, e] of edgeEls) {
      const on = hotEdges.has(key);
      e.classList.toggle('hot', on);
      e.classList.toggle('dim', !on && pathIds.length > 0);
    }
    for (const [id, e] of nodeEls) {
      e.classList.toggle('hot', hotNodes.has(id));
    }
    for (const [id, e] of labelEls) {
      e.classList.toggle('hot', hotNodes.has(id));
    }
    for (const [key, e] of weightEls) {
      e.classList.toggle('hot', hotEdges.has(key));
    }
  }

  return { setHotPath, pos, adj };
}

// 简单的缩放/平移控制
export function attachPanZoom(svg, viewportId = 'treeViewport') {
  const viewport = svg.querySelector(`#${viewportId}`);
  const state = { k: 1, tx: 0, ty: 0 };
  function apply() {
    viewport.setAttribute('transform', `translate(${state.tx} ${state.ty}) scale(${state.k})`);
  }
  apply();

  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    const k2 = Math.min(8, Math.max(0.3, state.k * factor));
    state.tx = mx - (mx - state.tx) * (k2 / state.k);
    state.ty = my - (my - state.ty) * (k2 / state.k);
    state.k = k2;
    apply();
  }, { passive: false });

  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  svg.addEventListener('mousedown', (ev) => {
    dragging = true; sx = ev.clientX; sy = ev.clientY; ox = state.tx; oy = state.ty;
    svg.classList.add('dragging');
  });
  window.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    state.tx = ox + (ev.clientX - sx);
    state.ty = oy + (ev.clientY - sy);
    apply();
  });
  window.addEventListener('mouseup', () => { dragging = false; svg.classList.remove('dragging'); });

  return { reset: apply, state };
}
