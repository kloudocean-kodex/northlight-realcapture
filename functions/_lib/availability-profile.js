export const AVAILABILITY_DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

const DAY_SET = new Set(AVAILABILITY_DAYS);
const MAX_EXCEPTIONS = 366;

export class AvailabilityValidationError extends Error {
  constructor(code, message, field = null) {
    super(message);
    this.name = 'AvailabilityValidationError';
    this.code = code;
    this.field = field;
  }
}

function reject(code, message, field = null) {
  throw new AvailabilityValidationError(code, message, field);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clock(value, field) {
  const text = String(value || '').trim();
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(text);
  if (!match) reject('INVALID_TIME', 'Use a valid 24-hour time such as 08:30.', field);
  const [hour, minute] = text.split(':').map(Number);
  return { text, minutes: hour * 60 + minute };
}

function hours(value, field) {
  if (!Array.isArray(value) || value.length !== 2) {
    reject('INVALID_HOURS', 'Each working day needs one start time and one end time.', field);
  }
  const start = clock(value[0], `${field}.start`);
  const end = clock(value[1], `${field}.end`);
  if (end.minutes <= start.minutes) {
    reject('OVERNIGHT_HOURS_UNSUPPORTED', 'Working hours must end later on the same calendar day.', field);
  }
  return [start.text, end.text];
}

function date(value, field) {
  const text = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) reject('INVALID_DATE', 'Use a valid date in YYYY-MM-DD format.', field);
  const [year, month, day] = match.slice(1).map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    reject('INVALID_DATE', 'Choose a real calendar date.', field);
  }
  return text;
}

export function validTimeZone(value) {
  const timeZone = String(value || '').trim();
  if (!timeZone || timeZone.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function normalizeWorkingHours(value) {
  if (!plainObject(value)) reject('INVALID_WORKING_HOURS', 'Working hours must be provided for each working day.', 'workingHours');
  const unexpected = Object.keys(value).filter(key => !DAY_SET.has(key));
  if (unexpected.length) reject('INVALID_WORKING_DAY', `Unsupported working day: ${unexpected[0]}.`, `workingHours.${unexpected[0]}`);
  const normalized = {};
  for (const day of AVAILABILITY_DAYS) {
    if (value[day] === undefined || value[day] === null || value[day] === false) continue;
    normalized[day] = hours(value[day], `workingHours.${day}`);
  }
  if (!Object.keys(normalized).length) {
    reject('NO_WORKING_DAYS', 'Keep at least one regular working day, then use days off for temporary unavailability.', 'workingHours');
  }
  return normalized;
}

export function normalizeDaysOff(value) {
  if (!Array.isArray(value)) reject('INVALID_DAYS_OFF', 'Days off must be a list of dates.', 'daysOff');
  if (value.length > MAX_EXCEPTIONS) reject('TOO_MANY_EXCEPTIONS', `Keep no more than ${MAX_EXCEPTIONS} days off.`, 'daysOff');
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const raw = typeof value[index] === 'string' ? value[index] : value[index]?.date;
    const item = date(raw, `daysOff.${index}`);
    if (seen.has(item)) reject('DUPLICATE_DATE', `Day off ${item} is listed more than once.`, `daysOff.${index}`);
    seen.add(item);
  }
  return [...seen].sort();
}

export function normalizeSpecialDays(value) {
  if (!Array.isArray(value)) reject('INVALID_SPECIAL_DAYS', 'Special availability must be a list.', 'specialDays');
  if (value.length > MAX_EXCEPTIONS) reject('TOO_MANY_EXCEPTIONS', `Keep no more than ${MAX_EXCEPTIONS} special days.`, 'specialDays');
  const seen = new Set();
  const normalized = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!plainObject(item)) reject('INVALID_SPECIAL_DAY', 'Each special day needs a date and availability.', `specialDays.${index}`);
    const itemDate = date(item.date, `specialDays.${index}.date`);
    if (seen.has(itemDate)) reject('DUPLICATE_DATE', `Special day ${itemDate} is listed more than once.`, `specialDays.${index}.date`);
    seen.add(itemDate);
    if (item.closed === true) normalized.push({ date: itemDate, closed: true });
    else normalized.push({ date: itemDate, closed: false, hours: hours(item.hours || item.working_hours, `specialDays.${index}.hours`) });
  }
  return normalized.sort((left, right) => left.date.localeCompare(right.date));
}

export function normalizeAvailabilityProfile(value = {}) {
  if (!plainObject(value)) reject('INVALID_AVAILABILITY', 'Availability must be an object.');
  const timeZone = String(value.timeZone || value.timezone || '').trim();
  if (!validTimeZone(timeZone)) reject('INVALID_TIMEZONE', 'Choose a supported IANA time zone.', 'timeZone');
  const workingHours = normalizeWorkingHours(value.workingHours ?? value.working_hours);
  const daysOff = normalizeDaysOff(value.daysOff ?? value.days_off ?? []);
  const specialDays = normalizeSpecialDays(value.specialDays ?? value.special_days ?? []);
  const dayOffSet = new Set(daysOff);
  const collision = specialDays.find(item => dayOffSet.has(item.date));
  if (collision) {
    reject('CONFLICTING_EXCEPTION', `${collision.date} cannot be both a day off and a special working day.`, 'specialDays');
  }
  return { workingHours, daysOff, specialDays, timeZone };
}
