// app.js — 工作台主控制器（纯浏览器，无任何网络业务调用）
import * as F from './fraction.js';
import { buildModel, validateMetric, reconstruct, shortestPath } from './metric.js';
import { parseMatrixText, modelToText } from './matrixio.js';
import { sampleTree, sampleStar, sampleTriangleBad, sampleFourPointBad, sampleDrift } from './samples.js';
import { renderTree, attachPanZoom } from './treeview.js';
import { restoreInterval, verifyCorrected, planIntervalChecks } from './drift.js';
import { scaledToText } from './matrixio.js';

const $ = (id) => document.getElementById(id);

const state = {
  labels: [],
  cells: [],            // string[][]
  result: null,         // { tree, check, model }
  view: null,
  panzoom: null,
  path: null,           // 当前核算路径的节点 id 序列
  drift: null,          // { p, q, res, check0 } 单链路漂移复原结论
  driftPanzoom: null,
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
    inp.addEventListener('input', () => { state.labels[j] = inp.value; invalidateDrift(); });
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
      invalidateDrift();
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
      inp.addEventListener('input', () => { state.cells[i][j] = inp.value; invalidateDrift(); });
      inp.addEventListener('change', () => {
        // 便利编辑：勾选“自动镜像对称”时同步对称位置；取消勾选可手工构造不对称矩阵
        if (i !== j && $('chkMirror').checked && state.cells[j][i] !== inp.value) {
          state.cells[j][i] = inp.value;
          const other = table.querySelector(`td[data-i="${j}"][data-j="${i}"] input`);
          if (other) other.value = inp.value;
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
  invalidateDrift();
  renderGrid();
  clearHighlight();
  $('resultBody').hidden = true;
  $('emptyResult').hidden = false;
  $('topoTools').hidden = true;
  $('validationBox').hidden = true;
  $('runStatus').textContent = '已载入数据，尚未重建。';
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
    offerDrift(prefillFromModel(model));
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
      `<span class="detail">已按端点编号字典序定位到最早反例，涉及单元格已高亮。</span>${detail}`);
    $('runStatus').textContent = '该矩阵不是树度量。';
    $('resultBody').hidden = true;
    $('emptyResult').hidden = false;
    $('topoTools').hidden = true;
    offerDrift(prefillFromVerdict(verdict));
    return;
  }

  // 3) 邻接法重建 + 规范校验（逐对叶路径核对）
  const r = reconstruct(model, state.labels);
  if (!r.ok) {
    setValidation('err', `<span class="kind">规范校验失败</span>${escapeHtml(r.error)}`);
    $('runStatus').textContent = '重建结果不满足规范树要求。';
    offerDrift(null);
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
  hideDrift();
  $('runStatus').textContent = '重建完成：树度量成立，规范树校验通过。';
  $('emptyResult').hidden = true;
  $('resultBody').hidden = false;
  $('topoTools').hidden = false;
  showResult();
}

// ---------------------------------------------------------------- 单链路漂移复原
// 完整矩阵未通过校验时，允许把某一对端点的读数视为唯一失真量求解允许区间；
// 输入、端点标签或任一矩阵格修改时撤下旧复原结论。
function hideDrift() {
  state.drift = null;
  $('panelDrift').hidden = true;
  $('driftResult').innerHTML = '';
}

function invalidateDrift() {
  if (!state.drift && $('panelDrift').hidden) return;
  hideDrift();
}

// 校验失败时打开漂移面板（每次失败都重置为全新待计算状态）
function offerDrift(prefill) {
  const n = state.labels.length;
  hideDrift();
  if (n < 2) return;
  const ps = $('selDriftP'), qs = $('selDriftQ');
  ps.innerHTML = '';
  qs.innerHTML = '';
  state.labels.forEach((l, i) => {
    ps.appendChild(new Option(l, i));
    qs.appendChild(new Option(l, i));
  });
  let [a, b] = prefill || [0, 1];
  if (!Number.isInteger(a) || !Number.isInteger(b) || a === b || a < 0 || b < 0 || a >= n || b >= n) {
    a = 0; b = Math.min(1, n - 1);
  }
  ps.value = a;
  qs.value = b;
  $('panelDrift').hidden = false;
}

function prefillFromModel(model) {
  const cells = model.cells || (model.cell ? [model.cell] : null);
  if (cells && cells.length) {
    const [i, j] = cells[0];
    if (i !== j) return [i, j];
  }
  return null;
}

function prefillFromVerdict(verdict) {
  if (verdict.kind === 'triangle' && verdict.left != null) {
    // 三角反例中“过长”的读数 d(left,right) 最像漂移点
    return [verdict.left, verdict.right];
  }
  if (verdict.kind === 'fourpoint' && verdict.sums) {
    // 四点反例中唯一最大值所在和式的第一对端点
    const m = F.maxF(F.maxF(verdict.sums[0], verdict.sums[1]), verdict.sums[2]);
    const idx = verdict.sums.findIndex(s => F.eq(s, m));
    const pairs = [[verdict.a, verdict.b], [verdict.a, verdict.c], [verdict.a, verdict.d]];
    if (idx >= 0) return pairs[idx];
  }
  return null;
}

function computeDrift() {
  const p = Number($('selDriftP').value);
  const q = Number($('selDriftQ').value);
  clearHighlight();
  if (p === q) {
    state.drift = null;
    $('driftResult').innerHTML =
      `<div class="validation warn"><span class="kind">提示</span>请选择两个不同的端点。</div>`;
    return;
  }
  const labelList = state.labels.map(l => String(l).trim());
  if (labelList.some(l => !l) || new Set(labelList).size !== labelList.length) {
    state.drift = null;
    $('driftResult').innerHTML =
      `<div class="validation warn"><span class="kind">提示</span>端点编号须非空且唯一，才能进行漂移复原。</div>`;
    return;
  }
  const res = restoreInterval(state.labels, state.cells, p, q);
  state.drift = { p, q, res, check0: null, coverage: null };
  renderDriftResult();
}

function renderDriftResult() {
  const box = $('driftResult');
  const d = state.drift;
  box.innerHTML = '';
  if (!d) return;
  const { p, q, res } = d;
  const LP = escapeHtml(state.labels[p]);
  const LQ = escapeHtml(state.labels[q]);

  if (!res.ok) {
    box.innerHTML = `<div class="validation err"><span class="kind">无法复原</span>${escapeHtml(res.error)}</div>`;
    return;
  }

  if (res.empty) {
    if (res.cells) highlightCells(res.cells);
    box.innerHTML =
      `<div class="validation err"><span class="kind">空区间</span>` +
      `将 d(${LP}, ${LQ}) 视为唯一失真读数时，<b>不存在</b>仍能形成规范无根树的取值——` +
      `<b>该链路无法单独解释本次异常</b>。` +
      `<span class="detail">${escapeHtml(res.message)}</span>` +
      `<span class="detail">建议改选其它疑似端点对重算，或回到矩阵核查更多读数。</span></div>`;
    return;
  }

  // —— 非空区间：原值 / 允许区间 / 最近修正 / 修正还原的树 ——
  const origTxt = res.original.asymmetric
    ? `${escapeHtml(res.original.textPQ)} / ${escapeHtml(res.original.textQP)} <span class="note">（两格读数不一致）</span>`
    : `<span class="num">${escapeHtml(res.original.textPQ || '（空）')}</span>` +
      (res.original.value ? '' : ' <span class="note">（无法解析为十进制数）</span>');

  const intervalTxt = res.degenerate
    ? `<span class="num">${F.toFixed(res.lo, 3)}</span>（区间退化为单点：四点判据的等式约束把 x 唯一确定）`
    : `<span class="num">[${F.toFixed(res.lo, 3)}, ${F.toFixed(res.hi, 3)}]</span>`;
  const scaledTxt = res.degenerate
    ? `缩放 ×1000 后整数解集 { ${res.kMin} }，即 ${res.lo[0]}/${res.lo[1]}`
    : `缩放 ×1000 后整数区间 [${res.kMin}, ${res.kMax}]，即 ` +
      `<span class="frac">[${res.lo[0]}/${res.lo[1]}, ${res.hi[0]}/${res.hi[1]}]</span>，` +
      `共 ${res.gridCount} 个三位小数取值`;

  const b = res.bounds;
  const boundsTxt =
    `三角不等式：<span class="frac">${F.toDecimal(b.L)} &lt; x &lt; ${F.toDecimal(b.U)}</span>` +
    (b.equalityCount
      ? `；四点判据：${b.equalityCount} 个四元组共同给出等式 x = ${F.toDecimal(res.lo)}`
      : `；四点判据：${b.halfCount} 个四元组给出上界 x ≤ ${F.toDecimal(b.halfMin)}（取交后上界收紧为 ${F.toFixed(res.hi, 3)}）`);

  const deltaTxt = res.delta
    ? `（Δ = ${F.toDecimal(F.gt(res.delta, F.ZERO) ? res.delta : F.neg(res.delta), 3)}，` +
      `${F.isZero(res.delta) ? '原值即可用' : F.isNeg(res.delta) ? '向下修正' : '向上修正'}，距原值最近）`
    : '（原值不可用，取区间下端）';

  // 修正值写回后的完整流水线复核（必然通过；失败则防御性展示）
  const tVerify = performance.now();
  const check0 = verifyCorrected(state.labels, state.cells, p, q, res.correctionText);
  d.verifyMs = Math.max(performance.now() - tVerify, 0.1);
  d.check0 = check0.ok ? check0 : null;

  box.innerHTML =
    `<div class="drift-grid">
      <div>
        <table class="drift-table">
          <tr><th>疑似链路</th><td>d(${LP}, ${LQ}) <span class="note">（视为唯一可能失真的读数）</span></td></tr>
          <tr><th>原读数</th><td>${origTxt}</td></tr>
          <tr><th>允许区间</th><td>${intervalTxt}<br><span class="note">${scaledTxt}</span></td></tr>
          <tr><th>约束来源</th><td>${boundsTxt}</td></tr>
          <tr><th>最近可用修正</th><td><span class="num">${res.correctionText}</span> <span class="note">${deltaTxt}</span></td></tr>
          <tr><th>取值复核</th><td id="driftCover">复核中…</td></tr>
        </table>
        <div class="interval-bar" id="driftBar"></div>
        <div class="interval-legend">
          <span><span class="sw sw-ok"></span>允许区间</span>
          <span><span class="sw sw-x0"></span>原读数</span>
          <span><span class="sw sw-corr"></span>最近修正</span>
        </div>
        <div class="drift-actions">
          <button id="btnApplyDrift" class="btn btn-primary" type="button"
            ${check0.ok ? '' : 'disabled'}>✔ 写回 d(${LP}, ${LQ}) = ${res.correctionText} 并重建</button>
          <span class="muted">写回后进入既有重建结果；原矩阵其它读数不变。</span>
        </div>
        ${check0.ok ? '' : `<div class="validation err" style="margin-top:10px"><span class="kind">异常</span>修正值未能通过既有流水线复核：${escapeHtml(check0.error)}</div>`}
      </div>
      <div>
        <div class="stats-line" id="driftStats"></div>
        <div class="drift-tree">
          <svg id="driftTreeSvg" xmlns="http://www.w3.org/2000/svg">
            <g id="driftTreeViewport"></g>
          </svg>
          <div class="svg-tip muted">以最近修正 ${res.correctionText} 还原的规范无根树 · 滚轮缩放 · 拖拽平移</div>
        </div>
      </div>
    </div>`;

  drawIntervalBar(res);
  $('btnApplyDrift').addEventListener('click', applyDriftCorrection);
  runDriftCoverage(d);

  if (check0.ok) {
    const { tree, check } = check0;
    const internals = tree.nodes.filter(v => !v.leaf);
    $('driftStats').innerHTML =
      `<span>修正后树度量成立</span>` +
      `<span>内部节点：<b>${internals.length}</b></span>` +
      `<span>边：<b>${tree.edges.length}</b></span>` +
      `<span>逐对路径核算：<b>${check.pathLengths.length} 对全部一致</b></span>`;
    renderTree($('driftTreeSvg'), tree, state.labels, {
      layout: 'radial',
      rootId: weightedCenter(tree, check),
      showWeights: true,
      onLeafClick: null,
      viewport: '#driftTreeViewport',
    });
    // 漂移树 SVG 随结果整体重建，平移缩放需挂到新元素上
    state.driftPanzoom = attachPanZoom($('driftTreeSvg'), '#driftTreeViewport');
  }
}

// 区间内三位小数取值的分片复核：按单次流水线实测耗时决定复核点数，
// 小间隔全量逐项复核；大间隔复核端点、最近修正与均匀抽样代表，期间保持界面响应。
function runDriftCoverage(d) {
  const { p, q, res } = d;
  const cell = $('driftCover');
  if (!cell) return;
  const budget = 1500; // ms：复核总耗时预算
  const maxChecks = Math.max(8, Math.min(300, Math.round(budget / d.verifyMs)));
  const plan = planIntervalChecks(res, maxChecks);
  let i = 0, failed = null;
  const step = () => {
    if (state.drift !== d) return; // 旧结论已被撤下
    const t0 = performance.now();
    while (i < plan.ks.length && performance.now() - t0 < 40) {
      const text = scaledToText(plan.ks[i], 3);
      const r = verifyCorrected(state.labels, state.cells, p, q, text);
      if (!r.ok) { failed = { text, error: r.error }; break; }
      i++;
    }
    if (failed) {
      cell.innerHTML = `复核在取值 <b>${failed.text}</b> 处失败（${escapeHtml(failed.error)}）——区间计算结果异常，请勿采用。`;
      return;
    }
    if (i < plan.ks.length) {
      cell.textContent = `复核中… ${i}/${plan.ks.length}`;
      setTimeout(step, 0);
      return;
    }
    cell.innerHTML = plan.exhaustive
      ? `区间内 <b>${plan.ks.length}</b> 个三位小数取值已<b>逐项全量复核</b>：三角不等式、四点判据、邻接重建、逐对路径核算全部通过。`
      : `区间共 ${plan.total} 个取值，已对两端点、最近修正及均匀抽样共 <b>${plan.ks.length}</b> 个取值逐项复核，` +
        `三角不等式、四点判据、邻接重建、逐对路径核算全部通过；` +
        `其余取值由同一组精确线性约束覆盖（可行集为连续区间，端点含边界）。`;
  };
  setTimeout(step, 0);
}

// 区间示意条：允许区间（绿）、原读数（红）、最近修正（黄）
function drawIntervalBar(res) {
  const bar = $('driftBar');
  if (!bar) return;
  const lo = F.toNumber(res.lo), hi = F.toNumber(res.hi);
  const corr = F.toNumber(res.correction);
  const x0 = res.original.value ? F.toNumber(res.original.value) : null;
  let dmin = lo, dmax = hi;
  if (x0 !== null) { dmin = Math.min(dmin, x0); dmax = Math.max(dmax, x0); }
  const pad = Math.max((dmax - dmin) * 0.06, (hi - lo) * 0.02, 1e-6);
  dmin -= pad; dmax += pad;
  const pct = (v) => `${((v - dmin) / (dmax - dmin)) * 100}%`;
  const seg = document.createElement('div');
  seg.className = 'seg';
  seg.style.left = pct(lo);
  seg.style.width = `${((hi - lo) / (dmax - dmin)) * 100}%`;
  bar.appendChild(seg);
  if (x0 !== null) {
    const m = document.createElement('div');
    m.className = 'mark-x0';
    m.style.left = pct(x0);
    m.title = `原读数 ${res.original.textPQ}`;
    bar.appendChild(m);
  }
  const c = document.createElement('div');
  c.className = 'mark-corr';
  c.style.left = pct(corr);
  c.title = `最近修正 ${res.correctionText}`;
  bar.appendChild(c);
}

// 一键写回：把最近修正同步进矩阵（含对称格），随后进入既有重建流程
function applyDriftCorrection() {
  const d = state.drift;
  if (!d || !d.res || d.res.empty) return;
  const { p, q } = d;
  const text = d.res.correctionText;
  state.cells[p][q] = text;
  state.cells[q][p] = text;
  for (const [i, j] of [[p, q], [q, p]]) {
    const el = document.querySelector(`#matrixTable td[data-i="${i}"][data-j="${j}"] input`);
    if (el) el.value = text;
  }
  $('runStatus').textContent =
    `已写回漂移修正 d(${state.labels[p]}, ${state.labels[q]}) = ${text}，正在重建…`;
  runReconstruct();
  if (state.result) highlightCells([[p, q], [q, p]], false);
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
  invalidateDrift();
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
  invalidateDrift();
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
  $('btnSampleDrift').addEventListener('click', () => { const s = sampleDrift(); loadData(s.labels, s.cells); });

  $('btnDrift').addEventListener('click', computeDrift);
  // 更换疑似端点对：撤下旧复原结论，保留面板待重算
  $('selDriftP').addEventListener('change', () => { state.drift = null; $('driftResult').innerHTML = ''; });
  $('selDriftQ').addEventListener('change', () => { state.drift = null; $('driftResult').innerHTML = ''; });

  $('selLayout').addEventListener('change', drawTree);
  $('selRoot').addEventListener('change', drawTree);
  $('chkWeights').addEventListener('change', drawTree);
  $('btnPath').addEventListener('click', computePath);
  $('selFrom').addEventListener('change', computePath);
  $('selTo').addEventListener('change', computePath);

  window.addEventListener('resize', () => { if (state.result) drawTree(); });
}

bind();
const initial = sampleTree();
loadData(initial.labels, initial.cells);
