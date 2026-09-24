const crypto = require('node:crypto');

// PINs are stored as salted scrypt hashes: "scrypt$N$r$p$<salt b64>$<hash b64>".
// The cost parameters are stored with each hash so they can be raised later
// without invalidating existing users.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

const PIN_MIN_LENGTH = 4;
const PIN_MAX_LENGTH = 64;

// PINs that were published as defaults in earlier versions of this project
// (README and source history). They are public knowledge, so accounts still
// using them are forced to pick a new PIN and they can never be set again.
const DISCLOSED_DEFAULT_PINS = new Set(['00102026', '1234', '1111']);

function hashPin(pin) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const hash = crypto.scryptSync(String(pin), salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifyPin(pin, stored) {
  if (typeof pin !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  let actual;
  try {
    actual = crypto.scryptSync(pin, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// A hash of random bytes nobody knows, used to burn CPU on unknown usernames so
// login timing does not reveal which usernames exist.
const DUMMY_HASH = hashPin(crypto.randomBytes(16).toString('hex'));
function burnVerify(pin) {
  verifyPin(typeof pin === 'string' ? pin : '', DUMMY_HASH);
}

function isDisclosedDefaultPin(pin) {
  return DISCLOSED_DEFAULT_PINS.has(String(pin));
}

// Returns an Arabic error message, or null when the PIN is acceptable.
function pinPolicyError(pin) {
  if (typeof pin !== 'string') return 'الرقم السري غير صالح';
  if (pin.length < PIN_MIN_LENGTH) return `الرقم السري لازم يكون ${PIN_MIN_LENGTH} أحرف/أرقام على الأقل`;
  if (pin.length > PIN_MAX_LENGTH) return `الرقم السري لازم يكون أقل من ${PIN_MAX_LENGTH} حرف`;
  if (pin.trim() !== pin) return 'الرقم السري لا يجب أن يبدأ أو ينتهي بمسافة';
  if (isDisclosedDefaultPin(pin)) return 'هذا الرقم السري كان افتراضيًا ومعروفًا للعامة، اختر رقمًا آخر';
  return null;
}

module.exports = { hashPin, verifyPin, burnVerify, isDisclosedDefaultPin, pinPolicyError };
