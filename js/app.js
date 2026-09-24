// app.js — 工作台主控制器（纯浏览器，无任何网络业务调用）
import * as F from './fraction.js';
import { buildModel, validateMetric, reconstruct, shortestPath } from './metric.js';
import { parseMatrixText, modelToText, scaledToText } from './matrixio.js';
import { sampleTree, sampleStar, sampleTriangleBad, sampleFourPointBad } from './samples.js';
import { renderTree, attachPanZoom } from './treeview.js';
import { repairSingleLink } from './repair.js';

const $ = (id) => document.getElementById(id);

const state = {
  labels: [],
  cells: [],            // string[][]
  result: null,         // { tree, check, model }
  view: null,
  panzoom: null,
  path: null,           // 当前核算路径的节点 id 序列
  badModel: null,       // 最近一次未通过度量校验的合法模型（供单链路复原）
  repair: null,         // 最近一次单链路复原结论
  repairPanzoom: null,
};

// ---------------------------------------------------------------- 矩阵表格
function renderGrid() {
  const table = $('matrixTable');
  table.innerHTML = '';
  const n = state.labels.length;

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'corner';
  corner.textContent = '端点';
  hr.appendChild(corner);
  for (let j = 0; j < n; j++) {
    const th = document.createElement('th');
    const inp = document.createElement('input');
    inp.value = state.labels[j];
    inp.dataset.j = j;
    inp.addEventListener('input', () => { state.labels[j] = inp.value; invalidateRepair(); });
    inp.addEventListener('change', () => {
      const rowInput = table.querySelector(`tbody tr[data-i="${j}"] th input`);
      if (rowInput && rowInput !== document.activeElement) rowInput.value = inp.value;
      syncResultSelections();
    });
    th.appendChild(inp);
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (let i = 0; i < n; i++) {
    const tr = document.createElement('tr');
    tr.dataset.i = i;
    const th = document.createElement('th');
    th.className = 'rowhead';
    const lin = document.createElement('input');
    lin.value = state.labels[i];
    lin.dataset.i = i;
    lin.addEventListener('input', () => {
      state.labels[i] = lin.value;
      invalidateRepair();
      const headCol = table.querySelector(`thead th:nth-child(${i + 2}) input`);
      if (headCol && headCol !== document.activeElement) headCol.value = lin.value;
    });
    th.appendChild(lin);
    tr.appendChild(th);

    for (let j = 0; j < n; j++) {
      const td = document.createElement('td');
      td.dataset.i = i;
      td.dataset.j = j;
      const inp = document.createElement('input');
      inp.inputMode = 'decimal';
      inp.value = state.cells[i][j];
      inp.dataset.i = i;
      inp.dataset.j = j;
      if (i === j) inp.readOnly = true;
      inp.addEventListener('input', () => { state.cells[i][j] = inp.value; invalidateRepair(); });
      inp.addEventListener('change', () => {
        // 便利编辑：勾选“自动镜像对称”时同步对称位置；取消勾选可手工构造不对称矩阵
        if (i !== j && $('chkMirror').checked && state.cells[j][i] !== inp.value) {
          state.cells[j][i] = inp.value;
          const other = table.querySelector(`td[data-i="${j}"][data-j="${i}"] input`);
          if (other) other.value = inp.value;
          invalidateRepair();
        }
      });
      inp.addEventListener('keydown', onCellKey);
      td.appendChild(inp);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  $('epCount').textContent = n;
}

function onCellKey(ev) {
  const i = Number(ev.target.dataset.i), j = Number(ev.target.dataset.j);
  const n = state.labels.length;
  let ni = i, nj = j;
  if (ev.key === 'ArrowRight' || ev.key === 'Tab') nj = j + 1;
  else if (ev.key === 'ArrowLeft') nj = j - 1;
  else if (ev.key === 'ArrowDown') ni = i + 1;
  else if (ev.key === 'ArrowUp') ni = i - 1;
  else if (ev.key === 'Enter') { ni = i + 1; nj = j; }
  else return;
  ev.preventDefault();
  ni = (ni + n) % n; nj = (nj + n) % n;
  focusCell(ni, nj);
}

function focusCell(i, j) {
  const el = document.querySelector(`#matrixTable td[data-i="${i}"][data-j="${j}"] input`);
  if (el) { el.focus(); el.select(); }
}

function clearHighlight() {
  document.querySelectorAll('td.cell-highlight,td.cell-bad,tr.row-highlight').forEach(e => {
    e.classList.remove('cell-highlight', 'cell-bad', 'row-highlight');
  });
}

function highlightCells(cellList, bad = true) {
  clearHighlight();
  const rows = new Set();
  for (const [i, j] of cellList) {
    const td = document.querySelector(`#matrixTable td[data-i="${i}"][data-j="${j}"]`);
    if (td) td.classList.add(bad ? 'cell-bad' : 'cell-highlight');
    rows.add(i);
  }
  for (const i of rows) {
    const tr = document.querySelector(`#matrixTable tbody tr[data-i="${i}"]`);
    if (tr) tr.classList.add('row-highlight');
  }
}

function loadData(labels, cells) {
  state.labels = labels.slice();
  state.cells = cells.map(r => r.slice());
  state.result = null;
  state.badModel = null;
  state._lastBadPair = null;
  invalidateRepair(true);
  renderGrid();
  clearHighlight();
  $('resultBody').hidden = true;
  $('emptyResult').hidden = false;
  $('topoTools').hidden = true;
  $('validationBox').hidden = true;
  $('repairEntry').hidden = true;
  $('runStatus').textContent = '已载入数据，尚未重建。';
}

// 输入、端点标签或任一矩阵格修改时撤下旧复原结论
function invalidateRepair(silent = false) {
  state.repair = null;
  state.repairPanzoom = null;
  const out = $('repairOut');
  if (out) out.innerHTML = '';
  if (!silent) {
    // 矩阵已改：旧的“未通过模型”也失效，复原入口在下次“启动重建”后重新出现
    state.badModel = null;
    const entry = $('repairEntry');
    if (entry) entry.hidden = true;
  }
}

function blankMatrix(n) {
  const labels = Array.from({ length: n }, (_, i) => `E${i + 1}`);
  const cells = labels.map((_, i) => labels.map((_, j) => (i === j ? '0' : '')));
  return { labels, cells };
}

// ---------------------------------------------------------------- 重建流程
function setValidation(level, html) {
  const box = $('validationBox');
  box.hidden = false;
  box.className = `validation ${level}`;
  box.innerHTML = html;
}

function runReconstruct() {
  clearHighlight();
  const n = state.labels.length;
  $('runStatus').textContent = '计算中…';
  invalidateRepair(true);
  $('repairEntry').hidden = true;
  state.badModel = null;

  // 1) 解析 + 缩放 + 精确有理化
  const model = buildModel(state.labels, state.cells);
  if (!model.ok) {
    if (model.cell) highlightCells([model.cell]);
    if (model.cells) highlightCells(model.cells);
    setValidation('err', `<span class="kind">输入非法</span>${escapeHtml(model.error)}`);
    $('runStatus').textContent = '输入校验未通过。';
    $('resultBody').hidden = true;
    $('emptyResult').hidden = false;
    $('topoTools').hidden = true;
    return;
  }

  // 2) 三角不等式 → 四点判据（字典序最早反例）
  const verdict = validateMetric(model, state.labels);
  if (!verdict.ok) {
    highlightCells(verdict.cells);
    const kindText = verdict.kind === 'triangle' ? '三角不等式反例' : '四点判据反例';
    const detail = verdict.kind === 'fourpoint'
      ? `<span class="detail">三组对边和：` +
        `<code>${state.labels[verdict.a]}${state.labels[verdict.b]}+${state.labels[verdict.c]}${state.labels[verdict.d]} = ${F.toDecimal(verdict.sums[0])}</code>，` +
        `<code>${state.labels[verdict.a]}${state.labels[verdict.c]}+${state.labels[verdict.b]}${state.labels[verdict.d]} = ${F.toDecimal(verdict.sums[1])}</code>，` +
        `<code>${state.labels[verdict.a]}${state.labels[verdict.d]}+${state.labels[verdict.b]}${state.labels[verdict.c]} = ${F.toDecimal(verdict.sums[2])}</code>` +
        `（无法形成两个相等的最大值）</span>`
      : '';
    setValidation('err',
      `<span class="kind">${kindText}</span>${escapeHtml(verdict.message)}` +
      `<span class="detail">已按端点编号字典序定位到最早反例，涉及单元格已高亮。` +
      `若怀疑仅是某一对端点的读数被仪表漂移污染，可使用下方“单链路漂移复原”判断该读数能否单独修正。</span>${detail}`);
    $('runStatus').textContent = '该矩阵不是树度量。';
    $('resultBody').hidden = true;
    $('emptyResult').hidden = false;
    $('topoTools').hidden = true;
    // 默认疑似对：三角反例取被违反边 (left,right)；四点反例取最早对边 (a,b)
    state._lastBadPair = verdict.kind === 'triangle'
      ? [Math.min(verdict.left, verdict.right), Math.max(verdict.left, verdict.right)]
      : [verdict.a, verdict.b];
    // 模型本身合法（对称、正数、三位小数），仅度量判据失败 → 允许单链路复原
    state.badModel = model;
    showRepairEntry();
    return;
  }

  // 3) 邻接法重建 + 规范校验（逐对叶路径核对）
  const r = reconstruct(model, state.labels);
  if (!r.ok) {
    setValidation('err', `<span class="kind">规范校验失败</span>${escapeHtml(r.error)}` +
      `<span class="detail">模型通过了三角不等式与四点判据但重建失败；仍可尝试下方“单链路漂移复原”。</span>`);
    $('runStatus').textContent = '重建结果不满足规范树要求。';
    state.badModel = model;
    showRepairEntry();
    return;
  }

  const n3 = (n * (n - 1) * (n - 2)) / 6;
  const n4 = (n * (n - 1) * (n - 2) * (n - 3)) / 24;
  const pairs = (n * (n - 1)) / 2;
  setValidation('ok',
    `✔ 缩放 <b>×${Number(model.scale)}</b> 后以精确有理数（BigInt）计算：<br>` +
    `三角不等式 <b>${n3}</b> 个三元组全部严格成立；四点判据 <b>${n4}</b> 个四元组全部满足；<br>` +
    `邻接法重建成功，收缩零权内部边后得到规范无根树；<b>${pairs}</b> 对叶间路径长度逐项等于输入矩阵。`);

  state.result = { tree: r.tree, check: r.check, model };
  state._lastBadPair = null;
  $('runStatus').textContent = '重建完成：树度量成立，规范树校验通过。';
  $('emptyResult').hidden = true;
  $('resultBody').hidden = false;
  $('topoTools').hidden = false;
  showResult();
}

// ---------------------------------------------------------------- 结果展示
function showResult() {
  const { tree, check } = state.result;
  const n = state.labels.length;
  const internals = tree.nodes.filter(v => !v.leaf);
  const degs = internals.map(v => check.adj.get(v.id).length);

  $('statsLine').innerHTML =
    `<span>叶节点（端点）：<b>${n}</b></span>` +
    `<span>内部节点（分路/熔接）：<b>${internals.length}</b></span>` +
    `<span>边：<b>${tree.edges.length}</b>（理论 ${2 * n - 3}）</span>` +
    `<span>内部节点度数：<b>${Math.min(...degs)}–${Math.max(...degs)}</b>（均 ≥ 3）</span>` +
    `<span>全部边权：<b>正</b></span>`;

  // 端点选择
  for (const selId of ['selFrom', 'selTo']) {
    const sel = $(selId);
    const cur = sel.value;
    sel.innerHTML = '';
    state.labels.forEach((l, i) => {
      const o = document.createElement('option');
      o.value = i; o.textContent = l;
      sel.appendChild(o);
    });
    if (state.labels.includes(cur)) sel.value = cur;
  }
  $('selFrom').value = 0;
  $('selTo').value = Math.min(1, n - 1);

  // 根节点选择：默认加权中心内部节点
  const rootSel = $('selRoot');
  rootSel.innerHTML = '';
  const centerId = weightedCenter(tree, check);
  internals.forEach(v => {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = `内部节点 #${v.id}（度 ${check.adj.get(v.id).length}）`;
    rootSel.appendChild(o);
  });
  rootSel.value = centerId;

  drawTree();
  computePath();
}

function weightedCenter(tree, check) {
  const internals = tree.nodes.filter(v => !v.leaf).map(v => v.id);
  let best = internals[0], bestMax = null;
  for (const r of internals) {
    // 从 r 到所有节点的精确距离
    const dist = new Map([[r, F.ZERO]]);
    const q = [r];
    while (q.length) {
      const x = q.shift();
      for (const y of check.adj.get(x)) {
        if (!dist.has(y)) {
          dist.set(y, F.add(dist.get(x), check.weight.get(`${x}|${y}`)));
          q.push(y);
        }
      }
    }
    let mx = F.ZERO;
    for (const [, d] of dist) if (F.gt(d, mx)) mx = d;
    if (bestMax === null || F.lt(mx, bestMax)) { bestMax = mx; best = r; }
  }
  return best;
}

function drawTree() {
  if (!state.result) return;
  const { tree } = state.result;
  const svg = $('treeSvg');
  state.view = renderTree(svg, tree, state.labels, {
    layout: $('selLayout').value,
    rootId: Number($('selRoot').value),
    showWeights: $('chkWeights').checked,
    onLeafClick: (id) => onLeafClicked(id),
  });
  if (!state.panzoom) state.panzoom = attachPanZoom(svg);
  if (state.path) state.view.setHotPath(state.path);
}

function onLeafClicked(id) {
  const from = Number($('selFrom').value), to = Number($('selTo').value);
  // 再次点击当前终点则改起点；否则把点击的叶设为终点
  if (id === to && id !== from) $('selFrom').value = id;
  else $('selTo').value = id;
  computePath();
}

// ---------------------------------------------------------------- 路径核算
function computePath() {
  if (!state.result) return;
  const a = Number($('selFrom').value);
  const b = Number($('selTo').value);
  const { tree, check, model } = state.result;

  const path = shortestPath(check.adj, a, b);
  state.path = a === b ? [a] : path;
  if (state.view) state.view.setHotPath(state.path);

  const tbody = $('pathTable').querySelector('tbody');
  tbody.innerHTML = '';
  const summary = $('pathSummary');
  summary.hidden = false;

  if (a === b) {
    summary.innerHTML = `起点与终点相同（${escapeHtml(state.labels[a])}），路径长度为 <span class="total">0</span>。`;
    return;
  }

  let acc = F.ZERO;
  for (let k = 0; k < path.length; k++) {
    const id = path[k];
    const node = tree.nodes.find(v => v.id === id);
    const name = node.leaf ? node.label : `内部 #${id}`;
    let seg = null, segTxt = '', accTxt = '';
    if (k > 0) {
      seg = check.weight.get(`${path[k - 1]}|${id}`);
      acc = F.add(acc, seg);
      segTxt = `<span class="frac">${seg[0]}/${seg[1]}</span> = ${F.toDecimal(seg, 6)}`;
    }
    accTxt = F.toDecimal(acc, 6);
    const tr = document.createElement('tr');
    if (k === 0 || k === path.length - 1) tr.className = 'hot';
    tr.innerHTML =
      `<td>${k + 1}</td>` +
      `<td>${escapeHtml(name)}</td>` +
      `<td>${k === 0 ? '—' : segTxt}</td>` +
      `<td>${accTxt}</td>`;
    tbody.appendChild(tr);
  }

  const expect = model.matrix[a][b];
  const match = F.eq(acc, expect);
  summary.innerHTML =
    `路径 <b>${escapeHtml(state.labels[a])}</b> → <b>${escapeHtml(state.labels[b])}</b>：` +
    `途经 ${path.length - 2} 个内部节点、${path.length - 1} 条边；` +
    `路径和 = <span class="total">${F.toDecimal(acc, 6)}</span>` +
    ` <span class="exact">（精确有理数 ${acc[0]}/${acc[1]}，由 ×${Number(model.scale)} 缩放整数约分得到）</span>` +
    `，输入矩阵 d = <b>${F.toDecimal(expect, 6)}</b>，` +
    (match ? '✔ <b style="color:var(--ok)">逐项核算一致</b>' : '✘ <b style="color:var(--bad)">不一致</b>');
}

// ---------------------------------------------------------------- 单链路漂移复原
function showRepairEntry() {
  const pSel = $('repP'), qSel = $('repQ');
  pSel.innerHTML = ''; qSel.innerHTML = '';
  state.labels.forEach((l, i) => {
    pSel.appendChild(new Option(l, i));
    qSel.appendChild(new Option(l, i));
  });
  // 默认疑似对：最近一次反例涉及的两个端点；否则取前两个
  let dp = 0, dq = Math.min(1, state.labels.length - 1);
  if (state._lastBadPair) {
    const [a, b] = state._lastBadPair;
    if (a < state.labels.length && b < state.labels.length && a !== b) { dp = a; dq = b; }
  }
  pSel.value = dp;
  qSel.value = dq === dp ? (dq + 1) % state.labels.length : dq;
  $('repairEntry').hidden = false;
  $('repairOut').innerHTML = '';
}

function runRepair() {
  if (!state.badModel) {
    $('runStatus').textContent = '请先点击“启动重建”，矩阵未通过原有校验后才能进行单链路复原。';
    return;
  }
  const p = Number($('repP').value), q = Number($('repQ').value);
  if (p === q) { $('repairOut').innerHTML = '<div class="repair-msg err">请选择两个不同的端点。</div>'; return; }
  state._lastBadPair = [p, q];
  $('repairOut').innerHTML = '<div class="repair-msg">以 BigInt 精确有理数求交区间并穷尽复核网格候选…</div>';
  // 让提示先绘制
  setTimeout(() => {
    const res = repairSingleLink(state.badModel, state.labels, p, q);
    state.repair = res;
    renderRepairResult();
  }, 0);
}

function intervalText(iv) {
  const lb = iv.loOpen ? '(' : '[', rb = iv.hiOpen ? ')' : ']';
  return `${lb}${F.toDecimal(iv.lo, 6)}，${F.toDecimal(iv.hi, 6)}${rb}`;
}
const exactFrac = (x) => `<span class="frac">${x[0]}/${x[1]}</span>`;

function renderRepairResult() {
  const res = state.repair;
  const out = $('repairOut');
  const { p, q } = res;
  const lp = escapeHtml(state.labels[p]), lq = escapeHtml(state.labels[q]);

  if (!res.ok) {
    const title = res.kind === 'too-large'
      ? `⚠ 链路 ${lp}–${lq}：候选过多，无法在限定开销内穷尽`
      : `✘ 链路 ${lp}–${lq} 无法单独解释异常（允许区间为空）`;
    out.innerHTML =
      `<div class="repair-card bad">
        <div class="repair-title">${title}</div>
        <div class="repair-row"><span>原读数：</span><b>${F.toDecimal(res.original, 6)}</b>（精确 ${exactFrac(res.original)}）</div>
        ${res.interval ? `<div class="repair-row"><span>实算边界：</span>${intervalText(res.interval)}</div>` : ''}
        <div class="repair-reason">${escapeHtml(res.error)}</div>
        ${res.kind === 'too-large' ? '' : '<div class="repair-sub muted">结论：不能只修正这一条读数使矩阵成为规范树度量，需按原流程判整张矩阵重建或另选疑似端点对。</div>'}
      </div>`;
    $('runStatus').textContent = `单链路复原：${state.labels[p]}–${state.labels[q]} ${res.kind === 'too-large' ? '候选过多' : '区间为空，无法单独修正'}。`;
    return;
  }

  const { interval: iv, grid, endpoints } = res;
  const pinTxt = iv.pinned
    ? '<span class="tag tag-pin">四点判据钉死为单点</span>'
    : '<span class="tag tag-iv">区间</span>';
  const endRow = (side, name) => {
    const e = endpoints[side];
    if (!e) return `<div class="repair-row"><span>${name}：</span>无界</div>`;
    if (e.usable) return `<div class="repair-row"><span>${name}：</span><b class="ok2">${F.toDecimal(e.x, 6)}</b>（闭端点，可取，已通过完整重建）</div>`;
    return `<div class="repair-row"><span>${name}：</span><b>${F.toDecimal(e.x, 6)}</b>（开端点，不可取——${escapeHtml(e.reason)}）</div>`;
  };
  const deltaTxt = F.isZero(res.delta)
    ? '<b class="ok2">原值本身即在允许范围内，无需修正</b>'
    : `修正量 Δ = <b>${F.isNeg(res.delta) ? '−' : '+'}${F.toDecimal(F.isNeg(res.delta) ? F.neg(res.delta) : res.delta, 6)}</b>`;

  out.innerHTML =
    `<div class="repair-card good">
      <div class="repair-title">✔ 链路 ${lp}–${lq} 可以单独修正 ${pinTxt}</div>
      <div class="repair-grid">
        <div class="repair-row"><span>原读数 d(${lp},${lq})：</span><b>${F.toDecimal(res.original, 6)}</b> <span class="frac">${res.original[0]}/${res.original[1]}</span></div>
        <div class="repair-row"><span>允许区间（真实值）：</span><b>${intervalText(iv)}</b></div>
        <div class="repair-row small">精确端点：下界 ${exactFrac(iv.lo)}${iv.loOpen ? '（开）' : '（闭）'}，上界 ${exactFrac(iv.hi)}${iv.hiOpen ? '（开）' : '（闭）'}</div>
        ${endRow('lo', '下界端点')}
        ${endRow('hi', '上界端点')}
        <div class="repair-row"><span>三位小数候选范围：</span>[${F.toDecimal(grid.lo, 3)}，${F.toDecimal(grid.hi, 3)}]，共 <b>${grid.count.toString()}</b> 个可表示值</div>
        <div class="repair-row small muted">${grid.perGridPipeline
          ? `每个候选都重新通过三角不等式、四点判据、邻接法重建（含零权内部边收缩）与全部叶对逐对路径核算（共 ${grid.fullReconstructed.toString()} 次完整重建）。`
          : `每个候选均重算了随该读数变化的全部三角不等式与四点判据，并在仿射规范树上逐对核算路径；中点/端点/网格两端/最近修正等 ${grid.fullReconstructed.toString()} 个代表点另做完整重建。`}</div>
        <div class="repair-row fix-row"><span>距原值最近的可用修正：</span><b class="fix-val">${F.toDecimal(res.fix, 6)}</b>（${deltaTxt}）</div>
      </div>
      <div class="repair-actions">
        <button id="btnApplyFix" class="btn btn-primary btn-small" type="button">⤳ 一键写回 ${F.toDecimal(res.fix, 3)} 并进入重建结果</button>
      </div>
      <div class="repair-tree-head">
        <span>该修正还原的规范无根树（红色标出被修正叶对 ${lp}–${lq}）</span>
        <label class="check-label"><input type="checkbox" id="repChkWeights" checked /> 显示边权</label>
      </div>
      <div class="tree-wrap repair-tree-wrap">
        <svg id="repairSvg" xmlns="http://www.w3.org/2000/svg"><g id="repairViewport"></g></svg>
      </div>
    </div>`;
  $('runStatus').textContent = `单链路复原：${state.labels[p]}–${state.labels[q]} 允许区间 ${intervalText(iv)}，建议修正 ${F.toDecimal(res.fix, 3)}。`;
  drawRepairTree();
  $('btnApplyFix').addEventListener('click', applyFix);
  $('repChkWeights').addEventListener('change', drawRepairTree);
}

function drawRepairTree() {
  const res = state.repair;
  if (!res || !res.ok) return;
  const svg = $('repairSvg');
  const { tree, check } = res.fixRecon;
  const internals = tree.nodes.filter(v => !v.leaf).map(v => v.id);
  // 加权中心内部节点作为视图根
  let centerId = internals[0], bestMax = null;
  for (const r2 of internals) {
    const dist = new Map([[r2, F.ZERO]]);
    const qq = [r2];
    while (qq.length) {
      const x = qq.shift();
      for (const y of check.adj.get(x)) {
        if (!dist.has(y)) { dist.set(y, F.add(dist.get(x), check.weight.get(`${x}|${y}`))); qq.push(y); }
      }
    }
    let mx = F.ZERO;
    for (const [, d] of dist) if (F.gt(d, mx)) mx = d;
    if (bestMax === null || F.lt(mx, bestMax)) { bestMax = mx; centerId = r2; }
  }
  const view = renderTree(svg, tree, state.labels, {
    layout: 'radial', rootId: centerId,
    showWeights: $('repChkWeights').checked,
    viewportId: 'repairViewport',
    onLeafClick: () => {},
  });
  // 高亮被修正端点对之间的路径
  view.setHotPath(shortestPath(check.adj, res.p, res.q));
  state._repView = view;
  if (!state.repairPanzoom) state.repairPanzoom = attachPanZoom(svg, 'repairViewport');
}

function applyFix() {
  const res = state.repair;
  if (!res || !res.ok) return;
  const { p, q } = res;
  // 写回矩阵（两个对称格），值为三位小数字符串
  const intVal = res.fix[0] * state.badModel.scale / res.fix[1];
  const txt = scaledToText(intVal, state.badModel.decimals);
  state.cells[p][q] = txt;
  state.cells[q][p] = txt;
  const ti = document.querySelector(`#matrixTable td[data-i="${p}"][data-j="${q}"] input`);
  const tj = document.querySelector(`#matrixTable td[data-i="${q}"][data-j="${p}"] input`);
  if (ti) ti.value = txt;
  if (tj) tj.value = txt;
  // 撤下复原结论，进入既有重建结果
  invalidateRepair(true);
  $('repairEntry').hidden = true;
  state.badModel = null;
  runReconstruct();
}

// ---------------------------------------------------------------- 其它
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function syncResultSelections() { /* 标签编辑后重建表格即可，结果在下次重建刷新 */ }

function exportCsv() {
  const text = modelToText(state.labels, state.cells);
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'distance-matrix.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importText() {
  const parsed = parseMatrixText($('importText').value);
  if (!parsed.ok) {
    $('runStatus').textContent = '文本解析失败：' + parsed.error;
    return;
  }
  loadData(parsed.labels, parsed.cells);
}

function addEndpoint() {
  const n = state.labels.length;
  if (n >= 40) { $('runStatus').textContent = '端点数量上限为 40。'; return; }
  let name = `E${n + 1}`, k = n + 1;
  const existing = new Set(state.labels);
  while (existing.has(name)) name = `E${++k}`;
  state.labels.push(name);
  state.cells.forEach((row, i) => row.push(i === n ? '0' : ''));
  state.cells.push(state.labels.map((_, j) => (j === n ? '0' : '')));
  state.result = null;
  state.badModel = null;
  state._lastBadPair = null;
  invalidateRepair(true);
  $('repairEntry').hidden = true;
  renderGrid();
  clearHighlight();
}

function removeEndpoint() {
  const n = state.labels.length;
  if (n <= 4) { $('runStatus').textContent = '至少保留 4 个端点。'; return; }
  state.labels.pop();
  state.cells.pop();
  state.cells.forEach(r => r.pop());
  state.result = null;
  state.badModel = null;
  state._lastBadPair = null;
  invalidateRepair(true);
  $('repairEntry').hidden = true;
  renderGrid();
  clearHighlight();
}

// ---------------------------------------------------------------- 事件绑定
function bind() {
  $('btnRun').addEventListener('click', runReconstruct);
  $('btnAdd').addEventListener('click', addEndpoint);
  $('btnRemove').addEventListener('click', removeEndpoint);
  $('btnParseText').addEventListener('click', importText);
  $('btnFillText').addEventListener('click', () => {
    $('importText').value = modelToText(state.labels, state.cells);
  });
  $('btnExport').addEventListener('click', exportCsv);
  $('btnClear').addEventListener('click', () => { const b = blankMatrix(4); loadData(b.labels, b.cells); });
  $('fileInput').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const text = await file.text();
    $('importText').value = text;
    importText();
    ev.target.value = '';
  });

  $('btnSampleTree').addEventListener('click', () => { const s = sampleTree(); loadData(s.labels, s.cells); });
  $('btnSampleStar').addEventListener('click', () => { const s = sampleStar(); loadData(s.labels, s.cells); });
  $('btnSampleBadT').addEventListener('click', () => { const s = sampleTriangleBad(); loadData(s.labels, s.cells); });
  $('btnSampleBad4').addEventListener('click', () => { const s = sampleFourPointBad(); loadData(s.labels, s.cells); });

  $('selLayout').addEventListener('change', drawTree);
  $('selRoot').addEventListener('change', drawTree);
  $('chkWeights').addEventListener('change', drawTree);
  $('btnPath').addEventListener('click', computePath);
  $('selFrom').addEventListener('change', computePath);
  $('selTo').addEventListener('change', computePath);
  $('btnRepair').addEventListener('click', runRepair);
  // 切换疑似端点对仅刷新待分析目标，不立即撤下已展示结论（结论上明确标注端点对）
  $('repP').addEventListener('change', () => { if ($('repP').value === $('repQ').value) $('repQ').value = ($('repP').value + 1) % state.labels.length; });
  $('repQ').addEventListener('change', () => { if ($('repP').value === $('repQ').value) $('repP').value = ($('repQ').value + 1) % state.labels.length; });

  window.addEventListener('resize', () => { if (state.result) drawTree(); });
}

bind();
const initial = sampleTree();
loadData(initial.labels, initial.cells);
