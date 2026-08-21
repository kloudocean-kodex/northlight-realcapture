import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AvailabilityValidationError,
  normalizeAvailabilityProfile,
  normalizeDaysOff,
  normalizeSpecialDays,
  normalizeWorkingHours,
  validTimeZone
} from '../functions/_lib/availability-profile.js';

const valid = {
  workingHours: {
    mon: ['08:00', '17:30'],
    tue: ['08:00', '17:30'],
    wed: ['08:00', '17:30'],
    thu: ['08:00', '17:30'],
    fri: ['08:00', '16:00'],
    sat: null,
    sun: false
  },
  daysOff: ['2026-12-25', { date: '2026-11-03' }],
  specialDays: [
    { date: '2026-12-24', hours: ['07:30', '12:00'] },
    { date: '2027-01-01', closed: true, hours: ['00:00', '23:59'] }
  ],
  timeZone: 'Australia/Melbourne'
};

test('availability is canonical, sorted, privacy-minimal and scheduling-compatible', () => {
  const result = normalizeAvailabilityProfile(valid);
  assert.deepEqual(result.workingHours, {
    mon: ['08:00', '17:30'], tue: ['08:00', '17:30'], wed: ['08:00', '17:30'],
    thu: ['08:00', '17:30'], fri: ['08:00', '16:00']
  });
  assert.deepEqual(result.daysOff, ['2026-11-03', '2026-12-25']);
  assert.deepEqual(result.specialDays, [
    { date: '2026-12-24', closed: false, hours: ['07:30', '12:00'] },
    { date: '2027-01-01', closed: true }
  ]);
  assert.equal(result.timeZone, 'Australia/Melbourne');
  assert.equal(JSON.stringify(result).includes('reason'), false);
});

test('unsupported days, malformed clocks, overnight hours and all-closed weeks fail closed', () => {
  for (const [input, code] of [
    [{ mon: ['8:00', '17:00'] }, 'INVALID_TIME'],
    [{ mon: ['17:00', '08:00'] }, 'OVERNIGHT_HOURS_UNSUPPORTED'],
    [{ monday: ['08:00', '17:00'] }, 'INVALID_WORKING_DAY'],
    [{ mon: null, tue: false }, 'NO_WORKING_DAYS']
  ]) {
    assert.throws(() => normalizeWorkingHours(input), error => error instanceof AvailabilityValidationError && error.code === code);
  }
});

test('invalid, duplicate and oversized exception dates fail closed', () => {
  assert.throws(() => normalizeDaysOff(['2026-02-29']), error => error.code === 'INVALID_DATE');
  assert.throws(() => normalizeDaysOff(['2028-02-29', '2028-02-29']), error => error.code === 'DUPLICATE_DATE');
  assert.throws(() => normalizeDaysOff(Array.from({ length: 367 }, (_, index) => `2030-01-${String(index + 1).padStart(2, '0')}`)), error => error.code === 'TOO_MANY_EXCEPTIONS');
  assert.throws(() => normalizeSpecialDays([{ date: '2026-10-10' }]), error => error.code === 'INVALID_HOURS');
});

test('a date cannot be both a day off and a special-day override', () => {
  assert.throws(() => normalizeAvailabilityProfile({
    workingHours: { mon: ['08:00', '17:00'] },
    daysOff: ['2026-12-25'],
    specialDays: [{ date: '2026-12-25', hours: ['09:00', '12:00'] }],
    timeZone: 'Australia/Melbourne'
  }), error => error.code === 'CONFLICTING_EXCEPTION');
});

test('IANA time zones are accepted and invented zones are rejected', () => {
  assert.equal(validTimeZone('Australia/Perth'), true);
  assert.equal(validTimeZone('UTC'), true);
  assert.equal(validTimeZone('Mars/Olympus_Mons'), false);
  assert.throws(() => normalizeAvailabilityProfile({ ...valid, timeZone: 'Mars/Olympus_Mons' }), error => error.code === 'INVALID_TIMEZONE');
});
