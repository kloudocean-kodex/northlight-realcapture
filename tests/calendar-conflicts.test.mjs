import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existingBookingCalendarConflicts,
  normalizeBusyIntervals,
  protectedTaskInterval
} from '../functions/_lib/calendar-conflicts.js';

const task = {
  id: 'task-1',
  status: 'confirmed',
  scheduled_start: '2026-08-24T00:00:00.000Z',
  scheduled_end: '2026-08-24T01:00:00.000Z',
  metadata: { buffer_before_min: 15, buffer_after_min: 20 }
};

test('existing booking checks include its protected buffers', () => {
  assert.deepEqual(protectedTaskInterval(task), {
    taskId: 'task-1',
    start: '2026-08-23T23:45:00.000Z',
    end: '2026-08-24T01:20:00.000Z'
  });
  assert.equal(existingBookingCalendarConflicts([task], [{
    start: '2026-08-23T23:50:00.000Z', end: '2026-08-24T00:00:00.000Z'
  }]).length, 1);
  assert.equal(existingBookingCalendarConflicts([task], [{
    start: '2026-08-24T01:20:00.000Z', end: '2026-08-24T01:30:00.000Z'
  }]).length, 0);
});

test('overlapping and adjacent Calendar intervals merge without exposing event content', () => {
  const merged = normalizeBusyIntervals([
    { start: '2026-08-24T00:00:00Z', end: '2026-08-24T00:30:00Z', summary: 'Private appointment' },
    { start: '2026-08-24T00:20:00Z', end: '2026-08-24T00:40:00Z', description: 'secret' },
    { start: '2026-08-24T00:40:00Z', end: '2026-08-24T01:00:00Z', location: 'home' },
    { start: 'invalid', end: '2026-08-24T02:00:00Z' }
  ]);
  assert.deepEqual(merged, [{ start: '2026-08-24T00:00:00.000Z', end: '2026-08-24T01:00:00.000Z' }]);
  assert.doesNotMatch(JSON.stringify(merged), /Private|secret|home/);
});

test('cancelled, delivered, declined, archived, deleted and malformed tasks are ignored', () => {
  const rows = ['cancelled', 'delivered', 'declined', 'editing'].map((status, index) => ({ ...task, id: `task-${index}`, status }));
  rows.push({ ...task, id: 'archived', archived_at: '2026-08-20T00:00:00Z' });
  rows.push({ ...task, id: 'deleted', deleted_at: '2026-08-20T00:00:00Z' });
  rows.push({ ...task, id: 'broken', scheduled_end: task.scheduled_start });
  assert.deepEqual(existingBookingCalendarConflicts(rows, [{ start: task.scheduled_start, end: task.scheduled_end }]), []);
});

test('one privacy-safe conflict per task is returned deterministically', () => {
  const conflicts = existingBookingCalendarConflicts([
    task,
    { ...task, id: 'task-2', scheduled_start: '2026-08-24T02:00:00Z', scheduled_end: '2026-08-24T03:00:00Z' }
  ], [
    { start: '2026-08-24T00:10:00Z', end: '2026-08-24T00:20:00Z' },
    { start: '2026-08-24T00:30:00Z', end: '2026-08-24T00:40:00Z' },
    { start: '2026-08-24T02:30:00Z', end: '2026-08-24T02:45:00Z' }
  ]);
  assert.deepEqual(conflicts.map(row => row.taskId), ['task-1', 'task-2']);
  assert.equal(Object.keys(conflicts[0]).some(key => /title|summary|description|location/i.test(key)), false);
});
