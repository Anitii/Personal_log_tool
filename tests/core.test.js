import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addDays, clampSubsToParent, defaultState, fitParentToSubs, fmtRange, fromDay, makeSub, makeTask, merge, mondayOf, normalize,
  percent, setDone, shiftTask, statusOf, subStatusOf, toCSV, toDay, weekNumber, weekdayIdx,
} from '../js/core.js';

const TODAY = '2026-11-02';

test('status matches the spreadsheet formula on the real rows', () => {
  const rows = [
    ['金融類CV', '2026-11-06', '2026-11-08', 0, 'todo'],
    ['資料結構HW', '2026-11-02', '2026-11-06', 0, 'doing'],
    ['金機考前複習', '2026-11-02', '2026-11-03', 0, 'doing'],
    ['雅思', '2026-11-01', '2026-11-05', 0, 'doing'],
  ];
  for (const [title, start, end, progress, expected] of rows) {
    assert.equal(statusOf(makeTask({ title, start, end, progress }), TODAY), expected, title);
  }
});

test('status edge cases', () => {
  const task = (start, end, progress = 0) => makeTask({ start, end, progress });
  assert.equal(statusOf(task(null, null), TODAY), 'nodate');
  assert.equal(statusOf(task('2026-11-02', null), TODAY), 'nodate');
  assert.equal(statusOf(task('2026-11-05', '2026-11-01'), TODAY), 'bad');
  assert.equal(statusOf(task('2026-10-01', '2026-11-01'), TODAY), 'late');
  assert.equal(statusOf(task('2026-10-01', '2026-11-02'), TODAY), 'doing', 'ending today is not overdue');
  assert.equal(statusOf(task('2026-11-03', '2026-11-04'), TODAY), 'todo');
  assert.equal(statusOf(task('2026-10-01', '2026-11-01', 100), TODAY), 'done', 'finished beats overdue');
});

test('date arithmetic crosses month, year and leap day', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(fromDay(toDay('2026-11-02')), '2026-11-02');
  assert.equal(weekdayIdx(toDay('2026-11-02')), 0, 'Monday');
  assert.equal(weekdayIdx(toDay('2026-11-08')), 6, 'Sunday');
  assert.equal(fromDay(mondayOf(toDay('2026-11-08'))), '2026-11-02');
});

test('week numbers match the template (10/19 = week 7, first column 9/28 = week 4)', () => {
  const settings = { baseMonday: '2026-10-19', baseWeek: 7 };
  assert.equal(weekNumber(toDay('2026-09-28'), settings), 4);
  assert.equal(weekNumber(toDay('2026-10-19'), settings), 7);
  assert.equal(weekNumber(toDay('2026-10-26'), settings), 8);
  assert.equal(weekNumber(toDay('2026-11-01'), settings), 8);
  assert.equal(weekNumber(toDay('2026-11-02'), settings), 9);
});

test('progress rolls up from subtasks', () => {
  const t = makeTask({ start: '2026-11-01', end: '2026-11-10', progress: 40 });
  assert.equal(percent(t), 40);
  t.subtasks = [makeSub({ done: true }), makeSub(), makeSub(), makeSub()];
  assert.equal(percent(t), 25, 'manual value is ignored once subtasks exist');
  assert.equal(statusOf(t, TODAY), 'doing');
  setDone(t, true);
  assert.equal(percent(t), 100);
  assert.equal(statusOf(t, TODAY), 'done');
  setDone(t, false);
  assert.equal(percent(t), 0);
});

test('subtask status', () => {
  assert.equal(subStatusOf(makeSub({ start: '2026-10-01', end: '2026-10-02' }), TODAY), 'late');
  assert.equal(subStatusOf(makeSub({ start: '2026-10-01', end: '2026-10-02', done: true }), TODAY), 'done');
});

test('parent widens for subtasks; shrinking parent clamps them; moving keeps durations', () => {
  const t = makeTask({ start: '2026-11-05', end: '2026-11-06', subtasks: [makeSub({ start: '2026-11-01', end: '2026-11-09' })] });
  fitParentToSubs(t);
  assert.deepEqual([t.start, t.end], ['2026-11-01', '2026-11-09']);

  t.start = '2026-11-03';
  t.end = '2026-11-04';
  clampSubsToParent(t);
  assert.deepEqual([t.subtasks[0].start, t.subtasks[0].end], ['2026-11-03', '2026-11-04']);

  shiftTask(t, 28);
  assert.deepEqual([t.start, t.end], ['2026-12-01', '2026-12-02']);
  assert.deepEqual([t.subtasks[0].start, t.subtasks[0].end], ['2026-12-01', '2026-12-02']);
});

test('fmtRange', () => {
  assert.equal(fmtRange('2026-11-02', '2026-11-06'), '11/2–11/6');
  assert.equal(fmtRange('2026-11-02', '2026-11-02'), '11/2');
  assert.equal(fmtRange(null, null), '未排日期');
});

test('normalize rejects malformed and unsafe input', () => {
  const s = normalize({
    projects: [{ id: 'a', name: 'x', color: 'red;background:url(evil)' }, { name: 'no id' }],
    tasks: [
      { id: 't1', title: 42, start: 'nope', end: '2026-11-02', progress: 900, priority: 99, link: 'javascript:alert(1)', subtasks: [{ id: 's', done: 'yes' }, null] },
      null,
      { title: 'no id' },
    ],
  });
  assert.equal(s.projects.length, 1);
  assert.match(s.projects[0].color, /^#[0-9A-F]{6}$/i);
  assert.equal(s.tasks.length, 1);
  const t = s.tasks[0];
  assert.equal(t.title, '');
  assert.equal(t.start, null);
  assert.equal(t.progress, 100);
  assert.equal(t.priority, 3);
  assert.equal(t.link, '');
  assert.equal(t.subtasks.length, 1);
  assert.equal(t.subtasks[0].done, false);
  assert.ok(normalize(null).projects.length > 0);
  assert.ok(normalize('junk').projects.length > 0);
});

function stateWith(tasks, deleted = {}) {
  return { ...defaultState(), tasks, deleted };
}

test('merge keeps the newer edit from either side', () => {
  const a = stateWith([makeTask({ id: '1', title: 'old', updatedAt: 100 }), makeTask({ id: '2', title: 'only a', updatedAt: 100 })]);
  const b = stateWith([makeTask({ id: '1', title: 'new', updatedAt: 200 }), makeTask({ id: '3', title: 'only b', updatedAt: 100 })]);
  const m = merge(a, b);
  assert.deepEqual(m.tasks.map((t) => t.title).sort(), ['new', 'only a', 'only b']);
  assert.deepEqual(merge(b, a).tasks.map((t) => t.title).sort(), ['new', 'only a', 'only b'], 'order of arguments is irrelevant');
});

test('merge: a deletion on one device is not undone by the other device', () => {
  const a = stateWith([], { 1: 200 });
  const b = stateWith([makeTask({ id: '1', title: 'stale', updatedAt: 100 })]);
  assert.equal(merge(a, b).tasks.length, 0);
  assert.equal(merge(b, a).tasks.length, 0);
});

test('merge: an edit newer than the deletion restores the item', () => {
  const a = stateWith([], { 1: 200 });
  const b = stateWith([makeTask({ id: '1', title: 'restored', updatedAt: 300 })]);
  const m = merge(a, b);
  assert.equal(m.tasks.length, 1);
  assert.equal(m.deleted[1], undefined);
});

test('merge is stable once converged', () => {
  const a = stateWith([makeTask({ id: '1', updatedAt: 100 })], { x: 5 });
  const b = stateWith([makeTask({ id: '2', updatedAt: 100 })], { y: 6 });
  const once = merge(a, b);
  const twice = merge(once, merge(b, a));
  assert.equal(twice.tasks.length, 2);
  assert.deepEqual(twice.deleted, { x: 5, y: 6 });
});

test('a brand-new device cannot overwrite renamed projects or week settings', () => {
  const used = defaultState();
  used.projects[0] = { ...used.projects[0], name: '工作', updatedAt: 1000 };
  used.settings = { baseMonday: '2027-02-22', baseWeek: 1, updatedAt: 1000 };
  const fresh = normalize(defaultState());
  for (const m of [merge(fresh, used), merge(used, fresh)]) {
    assert.equal(m.projects.find((p) => p.id === 'p1').name, '工作');
    assert.equal(m.settings.baseWeek, 1);
  }
});

test('CSV has a BOM, quotes values and lists subtasks', () => {
  const s = defaultState();
  s.tasks = [makeTask({ title: 'A "q", b', projectId: 'p2', start: '2026-11-02', end: '2026-11-03', subtasks: [makeSub({ title: 'child', start: '2026-11-02', end: '2026-11-02', done: true })] })];
  const csv = toCSV(s, TODAY);
  assert.equal(csv[0], '﻿');
  assert.ok(csv.includes('"A ""q"", b"'));
  assert.ok(csv.includes('"學校"'));
  assert.ok(csv.includes('"child"'));
  assert.equal(csv.trim().split('\r\n').length, 3);
});
