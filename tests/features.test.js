import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PALETTE, addMonths, assignLanes, blockSegments, blocksOn, deferTask, defaultState, fromDay, inkOn, isImportant, layoutWeek, makeBlock,
  makeSub, makeTask, merge, monthWeeks, normalize, plannedMinutes, sameDocument, statusOf, tasksForDay, toDay, toggleFocusDay,
} from '../js/core.js';
import {
  detectShortcut, diaryToMarkdown, inlineSegments, olNumbers, parseMarkdown, plainPreview, serializeMarkdown,
} from '../js/markdown.js';

const TODAY = '2026-11-02';

test('upgrading version 1 data keeps every task and only softens the old colors', () => {
  const v1 = {
    version: 1,
    projects: [{ id: 'p1', name: '實習', color: '#0071E3', updatedAt: 5 }, { id: 'x', name: '自訂', color: '#123456', updatedAt: 6 }],
    tasks: [{
      id: 't1', title: '雅思', projectId: 'p1', start: '2026-11-01', end: '2026-11-05', progress: 40, priority: 2, notes: '備註',
      link: 'https://example.com', subtasks: [{ id: 's1', title: '聽力', start: '2026-11-01', end: '2026-11-02', done: true, notes: 'n' }],
      order: 7, createdAt: 8, updatedAt: 9,
    }],
    settings: { baseMonday: '2026-10-19', baseWeek: 7, updatedAt: 3 },
    deleted: { gone: 11 },
  };
  const s = normalize(JSON.parse(JSON.stringify(v1)));
  const { color, focusDays, ...task } = s.tasks[0];
  assert.deepEqual(task, v1.tasks[0], 'every saved task field survives');
  assert.equal(color, '');
  assert.deepEqual(focusDays, []);
  assert.deepEqual(s.deleted, v1.deleted);
  assert.equal(s.settings.baseWeek, 7);
  assert.equal(s.projects[0].updatedAt, 5, 'recoloring is not an edit, so it cannot win a sync');
  assert.equal(s.projects[0].color, '#BCDDF2');
  assert.equal(s.projects[1].color, '#123456', 'colors outside the old palette are kept');
  assert.deepEqual(s.blocks, []);
  assert.deepEqual(s.diary, []);
});

test('a color picked in version 2 is never converted again, even one from the old palette', () => {
  const s = normalize({ version: 2, projects: [{ id: 'a', name: 'x', color: '#0071E3' }], tasks: [] });
  assert.equal(s.projects[0].color, '#0071E3');
  assert.equal(normalize(JSON.parse(JSON.stringify(s))).projects[0].color, '#0071E3');
});

test('ink stays readable on any background color', () => {
  for (const c of PALETTE) assert.equal(inkOn(c), '#3A2E25', c);
  assert.equal(inkOn('#101010'), '#FFFFFF');
});

test('time blocks never change the task they point at', () => {
  const t = makeTask({ start: '2026-11-02', end: '2026-11-06', progress: 20 });
  const before = JSON.stringify(t);
  const s = { ...defaultState(), tasks: [t], blocks: [makeBlock({ date: '2026-11-02', start: 600, end: 720, taskId: t.id })] };
  const n = normalize(JSON.parse(JSON.stringify(s)));
  assert.equal(n.blocks.length, 1);
  assert.equal(JSON.stringify(s.tasks[0]), before);
  assert.equal(statusOf(n.tasks[0], TODAY), 'doing');
  assert.equal(plannedMinutes(blocksOn(n, '2026-11-02')), 120);
  assert.equal(blocksOn(n, '2026-11-03').length, 0);
});

test('normalize snaps blocks to the 10-minute grid and rejects nonsense', () => {
  const s = normalize({ version: 2, blocks: [
    { id: 'a', date: '2026-11-02', start: 603, end: 2000 },
    { id: 'b', date: '2026-11-02', start: 700, end: 600 },
    { id: 'c', date: 'nope', start: 0, end: 10 },
    null,
  ] });
  assert.equal(s.blocks.length, 2);
  assert.deepEqual([s.blocks[0].start, s.blocks[0].end], [600, 1440]);
  assert.deepEqual([s.blocks[1].start, s.blocks[1].end], [700, 710]);
});

test('block segments follow the hour rows of the table', () => {
  assert.deepEqual(blockSegments(610, 730), [
    { row: 10, from: 10, to: 60, first: true, last: false },
    { row: 11, from: 0, to: 60, first: false, last: false },
    { row: 12, from: 0, to: 10, first: false, last: true },
  ]);
  assert.deepEqual(blockSegments(1430, 1440), [{ row: 23, from: 50, to: 60, first: true, last: true }]);
});

test('overlapping blocks share lanes and count once toward planned time', () => {
  const b = (id, start, end) => ({ id, start, end });
  const list = [b('a', 600, 720), b('b', 660, 690), b('c', 720, 780)];
  const lanes = assignLanes(list);
  assert.equal(lanes.get('a').lanes, 2);
  assert.notEqual(lanes.get('a').lane, lanes.get('b').lane);
  assert.equal(lanes.get('c').lanes, 1);
  assert.equal(plannedMinutes(list), 180);
});

test('the day tray offers tasks active that day, important first, plus overdue on today', () => {
  const s = defaultState();
  const a = makeTask({ title: 'a', start: '2026-11-01', end: '2026-11-05' });
  const b = makeTask({ title: 'b', start: '2026-11-02', end: '2026-11-02', focusDays: ['2026-11-02'] });
  const late = makeTask({ title: 'late', start: '2026-10-01', end: '2026-10-05' });
  const done = makeTask({ title: 'done', start: '2026-11-02', end: '2026-11-02', progress: 100 });
  const future = makeTask({ title: 'future', start: '2026-11-20', end: '2026-11-21' });
  s.tasks = [a, b, late, done, future];
  assert.deepEqual(tasksForDay(s, TODAY, TODAY).map((t) => t.title), ['b', 'late', 'a']);
  assert.deepEqual(tasksForDay(s, '2026-11-03', TODAY).map((t) => t.title), ['a'], 'overdue only shows on today');
});

test('importance: high priority every day, a focus day only on that day', () => {
  const t = makeTask({ start: '2026-11-01', end: '2026-11-05' });
  assert.equal(isImportant(t, TODAY), false);
  toggleFocusDay(t, TODAY);
  assert.equal(isImportant(t, TODAY), true);
  assert.equal(isImportant(t, '2026-11-03'), false);
  toggleFocusDay(t, TODAY);
  assert.deepEqual(t.focusDays, []);
  t.priority = 3;
  assert.equal(isImportant(t, '2026-11-03'), true);
});

test('month grid and week layout', () => {
  const weeks = monthWeeks('2026-11');
  assert.equal(fromDay(weeks[0]), '2026-10-26');
  assert.equal(fromDay(weeks[weeks.length - 1]), '2026-11-30');
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  const monday = toDay('2026-11-02');
  const plain = makeTask({ title: 'plain', start: '2026-11-02', end: '2026-11-08', order: 1 });
  const key = makeTask({ title: 'key', start: '2026-11-04', end: '2026-11-04', priority: 3, order: 2 });
  const other = makeTask({ title: 'other', start: '2026-10-01', end: '2026-10-02', order: 3 });
  const bars = layoutWeek([plain, key, other], monday);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].task.title, 'key', 'important tasks take the top lane');
  assert.equal(bars[0].lane, 0);
  assert.equal(bars[1].lane, 1);
  const clipped = layoutWeek([makeTask({ start: '2026-10-30', end: '2026-11-20' })], monday)[0];
  assert.deepEqual([clipped.from, clipped.to], [0, 6]);
});

test('merge carries blocks and diary with newest-wins and deletions', () => {
  const a = defaultState();
  const b = defaultState();
  a.diary = [{ id: 'diary-2026-11-02', date: '2026-11-02', body: 'old', updatedAt: 1 }];
  b.diary = [{ id: 'diary-2026-11-02', date: '2026-11-02', body: 'new', updatedAt: 2 }];
  a.blocks = [makeBlock({ id: 'x', date: TODAY, updatedAt: 5 })];
  b.deleted = { x: 9 };
  const m = merge(a, b);
  assert.equal(m.diary[0].body, 'new');
  assert.equal(m.blocks.length, 0);
  assert.equal(merge(defaultState(), a).diary.length, 1, 'a device without a diary cannot erase one');
});

test('a tab on the old version cannot erase the diary or time table', () => {
  const current = defaultState();
  current.tasks = [makeTask({ id: 't', updatedAt: 1 })];
  current.diary = [{ id: 'diary-2026-11-02', date: '2026-11-02', body: '今天', updatedAt: 5 }];
  current.blocks = [makeBlock({ id: 'b', date: TODAY, updatedAt: 5 })];
  const fromOldTab = JSON.parse(JSON.stringify(current));
  fromOldTab.version = 1;
  delete fromOldTab.diary;
  delete fromOldTab.blocks;
  const incoming = normalize(fromOldTab);
  const merged = merge(current, incoming);
  assert.equal(merged.diary[0].body, '今天');
  assert.equal(merged.blocks.length, 1);
  assert.equal(sameDocument(merged, incoming), false, 'the other tab is behind, so this one saves again');
  assert.equal(sameDocument(merged, normalize(JSON.parse(JSON.stringify(merged)))), true, 'two up-to-date tabs do not echo saves forever');
});

test('deferring an overdue task moves its deadline and keeps its start', () => {
  const t = makeTask({ start: '2026-10-01', end: '2026-10-05', subtasks: [
    makeSub({ start: '2026-10-01', end: '2026-10-02' }),
    makeSub({ start: '2026-10-01', end: '2026-10-02', done: true }),
  ] });
  deferTask(t, TODAY);
  assert.deepEqual([t.start, t.end], ['2026-10-01', TODAY]);
  assert.equal(t.subtasks[0].end, TODAY);
  assert.equal(t.subtasks[1].end, '2026-10-02');
  assert.equal(statusOf(t, TODAY), 'doing');
});

/* ---------- Markdown ---------- */

const types = (s) => parseMarkdown(s).map((b) => b.type);

test('markdown parses every block type', () => {
  assert.deepEqual(
    types('# a\n\n## b\n\n### c\n\n- d\n1. e\n- [x] f\n- [ ] g\n\n> h\n\n---\n\n```js\ncode\nmore\n```\n\ntext'),
    ['h1', 'h2', 'h3', 'ul', 'ol', 'todo', 'todo', 'quote', 'divider', 'code', 'p'],
  );
  const code = parseMarkdown('```js\na\n\nb\n```')[0];
  assert.deepEqual([code.text, code.lang], ['a\n\nb', 'js']);
  assert.equal(parseMarkdown('- [x] f')[0].checked, true);
  assert.equal(parseMarkdown('    - deep')[0].indent, 2);
});

test('markdown round trip is stable, including empty lines', () => {
  const docs = [
    '', 'a', 'a\n\nb', 'a\n\n\n\nb', 'a\n\n', '\n\na', '# t\n\n- a\n- b\n  - c\n\nend',
    '1. a\n2. b\n\ntext\n\n1. c', '> q\n> r\n\n---\n\n```\nx\n\ny\n```\n\n', '- [ ] a\n- [x] b',
  ];
  for (const doc of docs) {
    const once = serializeMarkdown(parseMarkdown(doc));
    assert.equal(serializeMarkdown(parseMarkdown(once)), once, JSON.stringify(doc));
    assert.deepEqual(parseMarkdown(once), parseMarkdown(serializeMarkdown(parseMarkdown(once))));
  }
  assert.equal(serializeMarkdown(parseMarkdown('a\n\n\n\nb')), 'a\n\n\n\nb', 'an empty paragraph survives');
  assert.equal(parseMarkdown('a\n\n\n\nb').length, 3);
});

test('hand-written lines become separate blocks, and text is never lost', () => {
  const out = serializeMarkdown(parseMarkdown('line one\nline two\n* star\n3) three'));
  for (const piece of ['line one', 'line two', '- star', '1. three']) assert.ok(out.includes(piece), piece);
});

test('ordered lists renumber within a run', () => {
  const blocks = parseMarkdown('1. a\n1. b\n  1. c\n1. d\n\ntext\n\n1. e');
  assert.deepEqual(olNumbers(blocks).filter(Boolean), [1, 2, 1, 3, 1]);
});

test('inline formatting maps rendered text back to its source position', () => {
  const text = 'a **bold** *it* ~~s~~ `c` [l](https://x.y) z';
  const segs = inlineSegments(text);
  assert.deepEqual(segs.filter((s) => s.type !== 'text').map((s) => s.type), ['bold', 'italic', 'strike', 'code', 'link']);
  for (const s of segs) assert.equal(text.slice(s.rawStart, s.rawStart + s.text.length), s.text);
  assert.equal(segs.find((s) => s.type === 'link').href, 'https://x.y');
  assert.deepEqual(inlineSegments('[x](javascript:alert(1))').map((s) => s.type), ['text'], 'only http links become links');
});

test('shortcuts, including the full-width space from Chinese input', () => {
  assert.equal(detectShortcut('# ').type, 'h1');
  assert.equal(detectShortcut('## x').rest, 'x');
  assert.equal(detectShortcut('#　').type, 'h1');
  assert.equal(detectShortcut('- ').type, 'ul');
  assert.equal(detectShortcut('1. ').type, 'ol');
  assert.equal(detectShortcut('[] ').type, 'todo');
  assert.equal(detectShortcut('[x] ').checked, true);
  assert.equal(detectShortcut('> ').type, 'quote');
  assert.equal(detectShortcut('---').type, 'divider');
  assert.equal(detectShortcut('```').type, 'code');
  assert.equal(detectShortcut('#hashtag'), null);
  assert.equal(detectShortcut('一般文字'), null);
});

test('diary export picks the chosen days and nests headings under each day', () => {
  const entries = [
    { date: '2026-11-03', body: '# 標題\n\n內容 B' },
    { date: '2026-11-02', body: '內容 A' },
    { date: '2026-11-04', body: '   ' },
    { date: '2026-12-01', body: '範圍外' },
    { date: '2026-11-05', body: '略過我' },
  ];
  const md = diaryToMarkdown(entries, { from: '2026-11-01', to: '2026-11-30', skip: new Set(['2026-11-05']) });
  assert.ok(md.startsWith('# 日記 2026-11-01 – 2026-11-30'));
  assert.ok(md.indexOf('## 2026-11-02 星期一') < md.indexOf('## 2026-11-03 星期二'), 'oldest first');
  assert.ok(md.includes('### 標題'), 'a diary heading moves below the day heading');
  assert.ok(!md.includes('範圍外'));
  assert.ok(!md.includes('略過我'));
  assert.ok(!md.includes('2026-11-04'), 'blank days are left out');
  const withTable = diaryToMarkdown(entries, { from: '2026-11-02', to: '2026-11-02', blocksFor: () => [{ start: 600, end: 720, title: 'A', done: true }] });
  assert.ok(withTable.includes('- [x] 10:00–12:00 A'));
  assert.ok(withTable.startsWith('# 日記 2026-11-02\n'));
});

test('code blocks keep their headings when exporting', () => {
  const md = diaryToMarkdown([{ date: '2026-11-02', body: '```\n# not a heading\n```' }], { from: '2026-11-02', to: '2026-11-02' });
  assert.ok(md.includes('\n# not a heading\n'));
});

test('plain preview skips markup and empty lines', () => {
  assert.equal(plainPreview('\n\n---\n\n# **重點** 今天'), '重點 今天');
  assert.equal(plainPreview(''), '');
});
