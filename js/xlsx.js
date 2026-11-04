// Minimal .xlsx reader, using only browser built-ins (DecompressionStream, DOMParser).
// Reads the 每週總覽 layout of the Excel template by header name, not by fixed column.
import { PALETTE, fromDay, makeTask, newId, toDay } from './core.js';
import { commit, state } from './store.js';

const EXCEL_EPOCH_OFFSET = 25569; // Excel serial of 1970-01-01

async function unzip(buffer) {
  const view = new DataView(buffer);
  let eocd = buffer.byteLength - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('不是有效的 .xlsx 檔案');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const files = new Map();

  for (let i = 0; i < count; i++) {
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (!/\.(xml|rels)$/.test(name)) continue;
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = new Uint8Array(buffer, dataStart, compressed);
    if (method === 0) {
      files.set(name, decoder.decode(data));
    } else {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      files.set(name, await new Response(stream).text());
    }
  }
  return files;
}

const parse = (xml) => new DOMParser().parseFromString(xml, 'application/xml');
const byName = (root, name) => [...root.getElementsByTagNameNS('*', name)];

function readSheet(xml, shared) {
  const rows = new Map();
  for (const row of byName(parse(xml), 'row')) {
    const r = new Map();
    for (const c of byName(row, 'c')) {
      const col = c.getAttribute('r').replace(/\d+/g, '');
      const t = c.getAttribute('t');
      const v = byName(c, 'v')[0]?.textContent;
      let value;
      if (t === 's') value = shared[Number(v)];
      else if (t === 'inlineStr') value = byName(c, 't').map((n) => n.textContent).join('');
      else if (t === 'str') value = v;
      else if (t === 'b') value = v === '1';
      else if (v !== undefined) value = Number(v);
      if (value !== undefined && value !== '') r.set(col, value);
    }
    rows.set(Number(row.getAttribute('r')), r);
  }
  return rows;
}

function toDateStr(value) {
  if (typeof value === 'number') return fromDay(Math.floor(value) - EXCEL_EPOCH_OFFSET);
  if (typeof value === 'string') {
    const m = value.trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return fromDay(toDay(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`));
  }
  return null;
}

function toPercent(value) {
  if (typeof value === 'string') value = parseFloat(value) / (value.includes('%') ? 100 : 1);
  if (!Number.isFinite(value)) return 0;
  const pct = value <= 1 ? value * 100 : value;
  return Math.min(100, Math.max(0, Math.round(pct)));
}

// Parses the workbook without changing app state.
export async function parseWorkbook(buffer) {
  const files = await unzip(buffer);
  const shared = files.has('xl/sharedStrings.xml')
    ? byName(parse(files.get('xl/sharedStrings.xml')), 'si').map((si) => byName(si, 't').map((n) => n.textContent).join(''))
    : [];

  const rels = new Map(
    byName(parse(files.get('xl/_rels/workbook.xml.rels') || '<r/>'), 'Relationship').map((r) => [r.getAttribute('Id'), r.getAttribute('Target')]),
  );
  const sheets = byName(parse(files.get('xl/workbook.xml')), 'sheet').map((s) => {
    const target = rels.get(s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || s.getAttribute('r:id')) || '';
    return { name: s.getAttribute('name'), path: target.startsWith('/') ? target.slice(1) : `xl/${target}` };
  });

  const result = { tasks: [], projects: [], baseMonday: null, baseWeek: null };

  for (const sheet of sheets) {
    const rows = readSheet(files.get(sheet.path) || '<r/>', shared);
    const headerEntry = [...rows].find(([, r]) => [...r.values()].includes('行動事項'));
    if (headerEntry) {
      const cols = {};
      for (const [col, val] of headerEntry[1]) if (typeof val === 'string') cols[val.replace(/（.*）/, '')] = col;
      for (const [n, r] of rows) {
        if (n <= headerEntry[0]) continue;
        const title = r.get(cols['行動事項']);
        if (typeof title !== 'string' || !title.trim()) continue;
        // The template's footnotes sit in the same column but have no 序 number.
        if (cols['序'] && typeof r.get(cols['序']) !== 'number') continue;
        const start = toDateStr(r.get(cols['開始日期']));
        const end = toDateStr(r.get(cols['結束日期']));
        result.tasks.push({
          title: title.trim(),
          project: String(r.get(cols['專案']) ?? '').trim(),
          start,
          end,
          progress: toPercent(r.get(cols['完成度'])),
          notes: String(r.get(cols['備註']) ?? ''),
        });
      }
      break; // the first task sheet is the source; 每日甘特圖 only mirrors it
    }
  }

  const settings = sheets.find((s) => s.name === '專案設定');
  if (settings) {
    const rows = readSheet(files.get(settings.path) || '<r/>', shared);
    for (const [n, r] of rows) {
      if (n > 1 && typeof r.get('A') === 'string' && r.get('A').trim()) result.projects.push(r.get('A').trim());
    }
    const row2 = rows.get(2);
    if (row2 && typeof row2.get('D') === 'number' && typeof row2.get('E') === 'number') {
      result.baseMonday = toDateStr(row2.get('D'));
      result.baseWeek = row2.get('E');
    }
  }
  return result;
}

// Tasks already present (same title and start date) are skipped, so importing twice is safe.
export function applyWorkbook(parsed) {
  const seen = new Set(state.tasks.map((t) => `${t.title}|${t.start}`));
  const fresh = parsed.tasks.filter((t) => {
    const key = `${t.title}|${t.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  commit(
    (s) => {
      const now = Date.now();
      const projectId = (name) => {
        if (!name) return '';
        let p = s.projects.find((x) => x.name === name);
        if (!p) {
          p = { id: newId(), name, color: PALETTE[s.projects.length % PALETTE.length], updatedAt: now };
          s.projects.push(p);
        }
        return p.id;
      };
      parsed.projects.forEach(projectId);
      fresh.forEach((t, i) => {
        s.tasks.push(makeTask({ title: t.title, projectId: projectId(t.project), start: t.start, end: t.end, progress: t.progress, notes: t.notes, order: now + i }));
      });
      if (parsed.baseMonday && parsed.baseWeek != null) {
        s.settings = { ...s.settings, baseMonday: parsed.baseMonday, baseWeek: parsed.baseWeek, updatedAt: now };
      }
    },
    { undo: fresh.length ? `已匯入 ${fresh.length} 項任務` : '沒有新任務，全部都已存在' },
  );
}
