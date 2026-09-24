// Input validation shared by the main process and the database layer.
// Every value that arrives over IPC is untrusted and must pass through here.

class ValidationError extends Error {}

function fail(message) {
  throw new ValidationError(message);
}

// Accepts numbers and numeric strings (form inputs); rejects '', NaN, Infinity, objects, etc.
function toFiniteNumber(value, label) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label}: قيمة رقمية غير صالحة`);
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '' && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(value.trim())) {
    return Number(value.trim());
  }
  return fail(`${label}: قيمة رقمية غير صالحة`);
}

function nonNegativeNumber(value, label) {
  const n = toFiniteNumber(value, label);
  if (n < 0) fail(`${label}: لا يمكن أن تكون قيمة سالبة`);
  return n;
}

function positiveNumber(value, label) {
  const n = toFiniteNumber(value, label);
  if (n <= 0) fail(`${label}: لازم تكون أكبر من صفر`);
  return n;
}

function numberInRange(value, label, min, max) {
  const n = toFiniteNumber(value, label);
  if (n < min || n > max) fail(`${label}: لازم تكون بين ${min} و ${max}`);
  return n;
}

function positiveId(value, label = 'المعرف') {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n <= 0) fail(`${label}: غير صالح`);
  return n;
}

function optionalId(value, label) {
  if (value === null || value === undefined || value === '' || value === 0) return null;
  return positiveId(value, label);
}

function requiredText(value, label, maxLength = 200) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} مطلوب`);
  const text = value.trim();
  if (text.length > maxLength) fail(`${label}: طويل جدًا`);
  return text;
}

function optionalText(value, label, maxLength = 200) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') fail(`${label}: غير صالح`);
  const text = value.trim();
  if (text.length > maxLength) fail(`${label}: طويل جدًا`);
  return text === '' ? null : text;
}

function oneOf(value, label, allowed) {
  if (!allowed.includes(value)) fail(`${label}: قيمة غير مسموحة`);
  return value;
}

// Images are rendered with innerHTML, so only well-formed base64 image data URLs are accepted.
// The strict base64 alphabet guarantees the value cannot break out of an HTML attribute.
const IMAGE_DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/i;
const MAX_IMAGE_DATA_URL_LENGTH = 8 * 1024 * 1024;

function optionalImageDataUrl(value, label) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_IMAGE_DATA_URL_LENGTH || !IMAGE_DATA_URL_RE.test(value)) {
    fail(`${label}: لازم تكون ملف صورة صالح`);
  }
  return value;
}

function dateString(value, label = 'التاريخ') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label}: غير صالح`);
  return value;
}

module.exports = {
  ValidationError,
  toFiniteNumber,
  nonNegativeNumber,
  positiveNumber,
  numberInRange,
  positiveId,
  optionalId,
  requiredText,
  optionalText,
  oneOf,
  optionalImageDataUrl,
  dateString,
};
