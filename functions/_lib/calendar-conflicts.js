const REVIEWABLE_STATUSES = new Set(['assigned', 'confirmed', 'reschedule_requested']);
const MAX_BUFFER_MINUTES = 24 * 60;

function instant(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function buffer(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(MAX_BUFFER_MINUTES, Math.trunc(number))) : 0;
}

export function protectedTaskInterval(task = {}) {
  if (!task.id || task.deleted_at || task.archived_at || !REVIEWABLE_STATUSES.has(String(task.status || ''))) return null;
  const start = instant(task.scheduled_start);
  const end = instant(task.scheduled_end);
  if (start === null || end === null || end <= start) return null;
  return {
    taskId: String(task.id),
    start: new Date(start - buffer(task.metadata?.buffer_before_min) * 60000).toISOString(),
    end: new Date(end + buffer(task.metadata?.buffer_after_min) * 60000).toISOString()
  };
}

export function normalizeBusyIntervals(intervals = []) {
  const rows = [];
  for (const interval of intervals || []) {
    const start = instant(interval?.start);
    const end = instant(interval?.end);
    if (start === null || end === null || end <= start) continue;
    rows.push({ start, end });
  }
  rows.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const row of rows) {
    const prior = merged.at(-1);
    if (prior && row.start <= prior.end) prior.end = Math.max(prior.end, row.end);
    else merged.push({ ...row });
  }
  return merged.map(row => ({ start: new Date(row.start).toISOString(), end: new Date(row.end).toISOString() }));
}

export function existingBookingCalendarConflicts(tasks = [], busyIntervals = []) {
  const busy = normalizeBusyIntervals(busyIntervals).map(interval => ({
    ...interval,
    startMs: new Date(interval.start).getTime(),
    endMs: new Date(interval.end).getTime()
  }));
  const conflicts = [];
  for (const task of tasks || []) {
    const protectedInterval = protectedTaskInterval(task);
    if (!protectedInterval) continue;
    const start = new Date(protectedInterval.start).getTime();
    const end = new Date(protectedInterval.end).getTime();
    for (const interval of busy) {
      if (interval.startMs >= end) break;
      if (interval.endMs <= start) continue;
      conflicts.push({
        taskId: protectedInterval.taskId,
        taskStart: protectedInterval.start,
        taskEnd: protectedInterval.end,
        busyStart: interval.start,
        busyEnd: interval.end
      });
      break;
    }
  }
  return conflicts;
}
