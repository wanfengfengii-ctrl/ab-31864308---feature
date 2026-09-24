// matrixio.js — 矩阵文本的解析、序列化与精确十进制解析

// 解析一个十进制 token：返回 { int: BigInt(不带小数点的值), digits: 小数位 }，失败返回 null
// 仅接受普通十进制写法（拒绝科学计数法、NaN、Infinity）
export function parseDecimalToken(token) {
  const t = token.trim();
  const m = /^(\d+)(?:\.(\d+))?$|^\.(\d+)$/.exec(t);
  if (!m) return null;
  let intPart = m[1] !== undefined ? m[1] : '0';
  const fracPart = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : '');
  return { int: BigInt(intPart + fracPart), digits: fracPart.length };
}

// 切分一行：含逗号/分号时按 CSV 风格切分（保留空字段），否则按空白切分
function splitLine(line) {
  if (/[,;]/.test(line)) {
    return line.split(/\s*[,;]\s*/).map(s => s.trim());
  }
  return line.trim().split(/\s+/).filter(s => s.length > 0);
}
const isNumericToken = t => parseDecimalToken(t) !== null;

// 解析矩阵文本。
// 支持：
//   1) 纯矩阵（n 行 × n 列），端点自动命名 E1..En
//   2) 带表头：首行  ,A,B,C...（角格可空或任意文本）；数据行可带/不带行标签列
//   3) 仅首列标签：A,0,1,...（无表头行）
export function parseMatrixText(text) {
  const rawLines = text.split(/\r?\n/)
    .map(l => l.replace(/#.*$/, '').trimEnd())
    .filter(l => l.trim().length > 0);
  if (rawLines.length === 0) return { ok: false, error: '内容为空' };

  const rows0 = rawLines.map(splitLine);
  let header = null;
  let rows = rows0;

  // 带表头：总行数 = 数据行 + 1；首行字段数 = 数据行数 + 1；首列角格非数字
  if (rows0.length >= 3 &&
      rows0[0].length === rows0.length &&
      !isNumericToken(rows0[0][0] === '' ? '' : rows0[0][0]) &&
      rows0[0].slice(1).every(t => !isNumericToken(t))) {
    header = rows0[0].slice(1);
    rows = rows0.slice(1);
  }

  if (rows.length < 2) return { ok: false, error: '至少需要 2 行数据（模型要求 4–40 个端点）' };
  const n = rows.length;

  const withLabelCol = rows.every(r => r.length === n + 1 && !isNumericToken(r[0]));
  const noLabelCol = rows.every(r => r.length === n);
  if (!withLabelCol && !noLabelCol) {
    return { ok: false, error: '行列数不一致：数据行应统一为 n 列，或 n+1 列（带标签列）' };
  }

  let labels;
  if (header) {
    labels = header;
    if (withLabelCol) {
      const rowLabels = rows.map(r => r[0]);
      if (rowLabels.some((l, i) => l !== labels[i])) {
        // 行标签与表头不一致时以行标签为准
        labels = rowLabels;
      }
    }
  } else {
    labels = withLabelCol ? rows.map(r => r[0]) : rows.map((_, i) => `E${i + 1}`);
  }
  const cells = rows.map(r => (withLabelCol ? r.slice(1) : r).map(s => s.trim()));

  if (cells.some(r => r.length !== n)) {
    return { ok: false, error: '矩阵必须为方阵' };
  }
  return { ok: true, labels, cells };
}

// 序列化为 CSV（带表头与标签列）
export function modelToText(labels, cells) {
  const n = labels.length;
  const esc = s => /[",\s;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const lines = [['', ...labels].map(esc).join(',')];
  for (let i = 0; i < n; i++) {
    lines.push([labels[i], ...cells[i]].map(esc).join(','));
  }
  return lines.join('\n');
}

// 将精确整数 + 小数位还原为十进制字符串（不带额外补零）
export function scaledToText(intVal, digits) {
  const neg = intVal < 0n;
  let s = (neg ? -intVal : intVal).toString();
  if (digits > 0) {
    while (s.length <= digits) s = '0' + s;
    s = s.slice(0, s.length - digits) + '.' + s.slice(s.length - digits);
  }
  return (neg ? '-' : '') + s;
}

// 三位小数补零（用于样例导出）
export function format3(num) {
  return num.toFixed(3);
}
