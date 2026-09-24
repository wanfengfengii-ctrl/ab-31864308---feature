// UI 冒烟测试：用最小 DOM 桩驱动真实 app.js，验证漂移复原的完整交互链路。
// 运行：node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------- 最小 DOM 桩
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.textContent = '';
    this.hidden = false;
    this.value = '';
    this.readOnly = false;
    this._innerHTML = '';
    const cls = new Set();
    this.classList = {
      add: (...cs) => cs.forEach(c => cls.add(c)),
      remove: (...cs) => cs.forEach(c => cls.delete(c)),
      contains: (c) => cls.has(c),
      toggle: (c, force) => {
        const want = force === undefined ? !cls.has(c) : force;
        if (want) cls.add(c); else cls.delete(c);
        return want;
      },
    };
    this._cls = cls;
  }
  get id() { return this.attributes.id || ''; }
  set id(v) { this.attributes.id = v; doc._register(v, this); }
  get className() { return [...this._cls].join(' '); }
  set className(v) {
    this._cls.clear();
    String(v).split(/\s+/).filter(Boolean).forEach(c => this._cls.add(c));
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._innerHTML = String(v);
    this._text = '';
    // 轻量标签栈解析：按标签嵌套重建占位元素树并登记 id；文本归入当前元素
    const VOID = new Set(['br', 'input', 'img', 'hr', 'meta', 'link']);
    const stack = [this];
    const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/g;
    let m;
    while ((m = re.exec(this._innerHTML))) {
      if (m[4] !== undefined) {
        const top = stack[stack.length - 1];
        top._text = (top._text || '') + m[4];
        if (top !== this) top._innerHTML += m[4]; // 占位元素的文本内容
        continue;
      }
      const [, closing, tag, attrs] = m;
      const t = tag.toLowerCase();
      if (closing) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].tagName.toLowerCase() === t) { stack.length = i; break; }
        }
        continue;
      }
      const el = new El(t);
      const idm = /\bid="([^"]+)"/.exec(attrs);
      if (idm) { el.attributes.id = idm[1]; doc._register(idm[1], el); }
      stack[stack.length - 1].appendChild(el);
      if (!VOID.has(t) && !attrs.trimEnd().endsWith('/')) stack.push(el);
    }
  }
  get textContent() { return this._text || ''; }
  set textContent(v) { this._text = String(v); this._innerHTML = String(v); this.children = []; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach(c => this.appendChild(c)); }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  dispatch(t, ev = {}) { ev.target ||= this; for (const f of this.listeners[t] || []) f(ev); }
  click() { this.dispatch('click'); }
  focus() {}
  select() {}
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'id') doc._register(v, this);
    if (k === 'class') this.className = v;
  }
  getAttribute(k) { return this.attributes[k] ?? null; }
  querySelector(sel) { return doc._query(sel, this)[0] || null; }
  querySelectorAll(sel) { return doc._query(sel, this); }
}

function parsePart(part) {
  const m = { tag: null, id: null, classes: [], attrs: [], nth: null };
  const re = /(^[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|:nth-child\((\d+)\)/g;
  let mm;
  while ((mm = re.exec(part))) {
    if (mm[1]) m.tag = mm[1].toLowerCase();
    else if (mm[2]) m.id = mm[2];
    else if (mm[3]) m.classes.push(mm[3]);
    else if (mm[4]) m.attrs.push([mm[4], mm[5] ?? null]);
    else if (mm[6]) m.nth = Number(mm[6]);
  }
  return m;
}

function matches(el, m) {
  if (m.tag && el.tagName.toLowerCase() !== m.tag) return false;
  if (m.id && el.id !== m.id) return false;
  for (const c of m.classes) if (!el.classList.contains(c)) return false;
  for (const [k, v] of m.attrs) {
    let actual;
    if (k.startsWith('data-')) {
      const camel = k.slice(5).replace(/-(\w)/g, (_, ch) => ch.toUpperCase());
      actual = el.dataset[camel];
    } else actual = el.attributes[k];
    if (v === null) { if (actual == null) return false; }
    else if (String(actual) !== v) return false;
  }
  if (m.nth !== null) {
    if (!el.parentNode) return false;
    if (el.parentNode.children.indexOf(el) + 1 !== m.nth) return false;
  }
  return true;
}

function descendants(root) {
  const out = [];
  const walk = (el) => { for (const c of el.children) { out.push(c); walk(c); } };
  walk(root);
  return out;
}

function selectAll(root, parts) {
  const [head, ...rest] = parts;
  const out = [];
  for (const d of descendants(root)) {
    if (matches(d, head)) {
      if (rest.length === 0) out.push(d);
      else out.push(...selectAll(d, rest));
    }
  }
  return out;
}

class Document {
  constructor() {
    this.root = new El('#root');
    this.registry = new Map();
    this.activeElement = null;
  }
  _register(id, el) { this.registry.set(id, el); }
  _attached(el) {
    let cur = el;
    while (cur) { if (cur === this.root) return true; cur = cur.parentNode; }
    return false;
  }
  getElementById(id) {
    const el = this.registry.get(id);
    return el && this._attached(el) ? el : null;
  }
  createElement(tag) { return new El(tag); }
  createElementNS(_ns, tag) { return new El(tag); }
  _query(selector, root) {
    const out = [];
    for (const alt of selector.split(',')) {
      const parts = alt.trim().split(/\s+/).map(parsePart);
      out.push(...selectAll(root || this.root, parts));
    }
    return [...new Set(out)];
  }
  querySelector(sel) { return this._query(sel, this.root)[0] || null; }
  querySelectorAll(sel) { return this._query(sel, this.root); }
}

const doc = new Document();
// 预登记 index.html 中 app.js 启动时用到的全部静态元素
const STATIC_IDS = [
  'btnRun', 'btnAdd', 'btnRemove', 'btnParseText', 'btnFillText', 'btnExport', 'btnClear',
  'fileInput', 'btnSampleTree', 'btnSampleStar', 'btnSampleBadT', 'btnSampleBad4', 'btnSampleDrift',
  'btnDrift', 'selDriftP', 'selDriftQ', 'selLayout', 'selRoot', 'chkWeights', 'chkMirror',
  'btnPath', 'selFrom', 'selTo', 'matrixTable', 'epCount', 'resultBody', 'emptyResult',
  'topoTools', 'validationBox', 'runStatus', 'importText', 'panelDrift', 'driftResult',
  'statsLine', 'pathSummary', 'gridWrap', 'treeWrap',
];
for (const id of STATIC_IDS) {
  const el = new El('div');
  el.attributes.id = id;
  doc.root.appendChild(el);
  doc._register(id, el);
}
// 静态嵌套结构：pathTable > tbody；treeSvg > g#treeViewport
const pathTable = new El('table');
pathTable.attributes.id = 'pathTable';
doc.root.appendChild(pathTable);
pathTable.appendChild(new El('tbody'));
doc._register('pathTable', pathTable);
const treeSvg = new El('svg');
treeSvg.attributes.id = 'treeSvg';
doc.root.appendChild(treeSvg);
const vp = new El('g');
vp.attributes.id = 'treeViewport';
treeSvg.appendChild(vp);
doc._register('treeSvg', treeSvg);
doc._register('treeViewport', vp);

globalThis.document = doc;
globalThis.window = { addEventListener() {} };
globalThis.Option = class {
  constructor(text, value) {
    const el = new El('option');
    el.textContent = text;
    el.value = String(value);
    return el;
  }
};

const $ = (id) => doc.getElementById(id);
const cellInput = (i, j) =>
  doc.querySelector(`#matrixTable td[data-i="${i}"][data-j="${j}"] input`);

// 启动应用（执行 bind + 载入树度量样例）
await import('../js/app.js');

// ---------------------------------------------------------------- 冒烟流程
test('UI 冒烟：校验失败 → 漂移复原 → 区间展示 → 一键写回进入既有重建', async () => {
  $('btnSampleDrift').click();           // 载入漂移污染样例 d(A,B)=9.000
  $('btnRun').click();                   // 启动重建 → 三角反例失败
  assert.match($('validationBox').className, /err/);
  assert.equal($('panelDrift').hidden, false, '失败后应出现漂移复原面板');
  // 预填疑似端点对 = 反例中的 (A,B)
  assert.equal(Number($('selDriftP').value), 0);
  assert.equal(Number($('selDriftQ').value), 1);

  $('btnDrift').click();                 // 计算允许区间
  const html = $('driftResult').innerHTML;
  assert.match(html, /允许区间/);
  assert.match(html, /0\.301/);
  assert.match(html, /4\.300/);
  assert.match(html, /最近可用修正/);
  assert.ok($('driftBar').children.length >= 2, '区间示意条已绘制');

  // 分片复核异步完成
  for (let i = 0; i < 400 && /复核中/.test($('driftCover').innerHTML); i++) {
    await new Promise(r => setTimeout(r, 5));
  }
  assert.match($('driftCover').innerHTML, /全部通过/);
  assert.match($('driftStats').innerHTML, /逐对路径核算/);

  // 一键写回 → 进入既有重建结果
  $('btnApplyDrift').click();
  assert.equal(cellInput(0, 1).value, '4.300', '修正值已写回矩阵格');
  assert.equal(cellInput(1, 0).value, '4.300', '对称格同步写回');
  assert.equal($('panelDrift').hidden, true, '写回重建成功后撤下漂移面板');
  assert.equal($('resultBody').hidden, false, '进入既有重建结果');
  assert.match($('validationBox').className, /ok/);
  assert.match($('statsLine').innerHTML, /内部节点/);
});

test('UI 冒烟：修改任一矩阵格立即撤下旧复原结论', () => {
  $('btnSampleDrift').click();
  $('btnRun').click();
  $('btnDrift').click();
  assert.equal($('panelDrift').hidden, false);
  assert.ok($('driftResult').innerHTML.length > 0);

  const cell = cellInput(2, 3);
  cell.value = '2.001';
  cell.dispatch('input');
  assert.equal($('panelDrift').hidden, true, '编辑矩阵格后漂移面板被撤下');
  assert.equal($('driftResult').innerHTML, '');
});

test('UI 冒烟：空区间时明确提示该链路无法单独解释异常', () => {
  // 固定三元组 {C,D,E} 自相矛盾，疑似链路 (A,B) 无力回天
  $('importText').value = [
    ',A,B,C,D,E',
    'A,0,3,2,2,2',
    'B,3,0,2,2,2',
    'C,2,2,0,1,5',
    'D,2,2,1,0,1',
    'E,2,2,5,1,0',
  ].join('\n');
  $('btnParseText').click();
  $('btnRun').click();
  assert.equal($('panelDrift').hidden, false);
  // 手动指定疑似链路为 (A,B)：其固定证据 {C,D,E} 已自相矛盾
  $('selDriftP').value = '0';
  $('selDriftQ').value = '1';
  $('btnDrift').click();
  assert.match($('driftResult').innerHTML, /空区间/);
  assert.match($('driftResult').innerHTML, /该链路无法单独解释/);
});

test('UI 冒烟：原矩阵合法时既有行为不变（不出现漂移面板）', () => {
  $('btnSampleTree').click();
  $('btnRun').click();
  assert.match($('validationBox').className, /ok/);
  assert.equal($('panelDrift').hidden, true, '矩阵合法时不出现漂移面板');
  assert.equal($('resultBody').hidden, false);
  // CSV 导出行为不变
  $('btnExport').click();
});
