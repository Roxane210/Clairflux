import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2.js';

const ARGON2ID_VERSION = 0x13;
const MIN_ARGON2_MEMORY_KIB = 1024;
const MAX_ARGON2_MEMORY_KIB = 262_144;
const MIN_ARGON2_TIME = 1;
const MAX_ARGON2_TIME = 16;
const MIN_ARGON2_PARALLELISM = 1;
const MAX_ARGON2_PARALLELISM = 16;
const MIN_DERIVED_BYTES = 16;
const MAX_DERIVED_BYTES = 64;

const MIN_SCRYPT_LOG2_N = 10;
const MAX_SCRYPT_LOG2_N = 20;
const MIN_SCRYPT_R = 1;
const MAX_SCRYPT_R = 32;
const MIN_SCRYPT_P = 1;
const MAX_SCRYPT_P = 16;
const SCRYPT_MAXMEM_BYTES = 128 * 1024 * 1024;

const BASE64_PHC_REGEX = /^[A-Za-z0-9+/]+=*$/;
const HEX_REGEX = /^[a-f0-9]+$/i;

function decodePhcBase64(encoded: string): Buffer | null {
  if (encoded.length === 0 || !BASE64_PHC_REGEX.test(encoded)) {
    return null;
  }
  const paddedLength = encoded.length % 4 === 0 ? encoded.length : encoded.length + (4 - (encoded.length % 4));
  const padded = encoded.padEnd(paddedLength, '=');
  const decoded = Buffer.from(padded, 'base64');
  if (decoded.length === 0) {
    return null;
  }
  const canonicalUnpadded = decoded.toString('base64').replace(/=+$/, '');
  const inputUnpadded = encoded.replace(/=+$/, '');
  if (canonicalUnpadded !== inputUnpadded) {
    return null;
  }
  return decoded;
}

function encodePhcBase64Unpadded(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/=+$/, '');
}

function parseParamPairs(rawParams: string): ReadonlyMap<string, number> | null {
  if (rawParams.length === 0) {
    return null;
  }
  const map = new Map<string, number>();
  for (const part of rawParams.split(',')) {
    const eqIndex = part.indexOf('=');
    if (eqIndex <= 0 || eqIndex === part.length - 1) {
      return null;
    }
    const key = part.slice(0, eqIndex);
    const valStr = part.slice(eqIndex + 1);
    if (!/^\d+$/.test(valStr)) {
      return null;
    }
    const val = Number(valStr);
    if (!Number.isSafeInteger(val)) {
      return null;
    }
    map.set(key, val);
  }
  return map;
}

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function verifyArgon2idPhc(candidateSecret: string, storedHash: string): boolean {
  const segments = storedHash.split('$');
  // Expected: ['', 'argon2id', 'v=19', 'm=...,t=...,p=...', '<salt>', '<hash>']
  // Also tolerate optional version segment if absent: ['', 'argon2id', 'm=...,t=...,p=...', '<salt>', '<hash>']
  let paramsSegment: string;
  let saltSegment: string;
  let hashSegment: string;

  if (segments.length === 6 && segments[1] === 'argon2id') {
    if (segments[2] !== 'v=19') {
      return false;
    }
    paramsSegment = segments[3] ?? '';
    saltSegment = segments[4] ?? '';
    hashSegment = segments[5] ?? '';
  } else if (segments.length === 5 && segments[1] === 'argon2id') {
    paramsSegment = segments[2] ?? '';
    saltSegment = segments[3] ?? '';
    hashSegment = segments[4] ?? '';
  } else {
    return false;
  }

  const params = parseParamPairs(paramsSegment);
  if (params === null) {
    return false;
  }

  const m = params.get('m');
  const t = params.get('t');
  const p = params.get('p');
  if (
    m === undefined ||
    t === undefined ||
    p === undefined ||
    m < MIN_ARGON2_MEMORY_KIB ||
    m > MAX_ARGON2_MEMORY_KIB ||
    t < MIN_ARGON2_TIME ||
    t > MAX_ARGON2_TIME ||
    p < MIN_ARGON2_PARALLELISM ||
    p > MAX_ARGON2_PARALLELISM
  ) {
    return false;
  }

  const salt = decodePhcBase64(saltSegment);
  const expectedHash = decodePhcBase64(hashSegment);
  if (
    salt === null ||
    expectedHash === null ||
    salt.length < 8 ||
    expectedHash.length < MIN_DERIVED_BYTES ||
    expectedHash.length > MAX_DERIVED_BYTES
  ) {
    return false;
  }

  try {
    const derived = argon2id(candidateSecret, salt, {
      t,
      m,
      p,
      dkLen: expectedHash.length,
      version: ARGON2ID_VERSION,
    });
    return constantTimeEquals(derived, expectedHash);
  } catch {
    return false;
  }
}

function verifyScryptPhc(candidateSecret: string, storedHash: string): boolean {
  const segments = storedHash.split('$');
  if (segments.length !== 5 || segments[1] !== 'scrypt') {
    return false;
  }

  const params = parseParamPairs(segments[2] ?? '');
  if (params === null) {
    return false;
  }

  const ln = params.get('ln');
  const r = params.get('r');
  const p = params.get('p');
  if (
    ln === undefined ||
    r === undefined ||
    p === undefined ||
    ln < MIN_SCRYPT_LOG2_N ||
    ln > MAX_SCRYPT_LOG2_N ||
    r < MIN_SCRYPT_R ||
    r > MAX_SCRYPT_R ||
    p < MIN_SCRYPT_P ||
    p > MAX_SCRYPT_P
  ) {
    return false;
  }

  const salt = decodePhcBase64(segments[3] ?? '');
  const expectedHash = decodePhcBase64(segments[4] ?? '');
  if (
    salt === null ||
    expectedHash === null ||
    salt.length < 8 ||
    expectedHash.length < MIN_DERIVED_BYTES ||
    expectedHash.length > MAX_DERIVED_BYTES
  ) {
    return false;
  }

  const costN = 2 ** ln;
  const requiredMem = 128 * costN * r;
  if (requiredMem > SCRYPT_MAXMEM_BYTES) {
    return false;
  }

  try {
    const derived = scryptSync(candidateSecret, salt, expectedHash.length, {
      N: costN,
      r,
      p,
      maxmem: SCRYPT_MAXMEM_BYTES,
    });
    return constantTimeEquals(derived, expectedHash);
  } catch {
    return false;
  }
}

function verifyScryptColon(candidateSecret: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const saltHex = parts[1] ?? '';
  const hashHex = parts[2] ?? '';
  if (
    saltHex.length < 16 ||
    saltHex.length % 2 !== 0 ||
    !HEX_REGEX.test(saltHex) ||
    hashHex.length < MIN_DERIVED_BYTES * 2 ||
    hashHex.length > MAX_DERIVED_BYTES * 2 ||
    hashHex.length % 2 !== 0 ||
    !HEX_REGEX.test(hashHex)
  ) {
    return false;
  }

  const salt = Buffer.from(saltHex, 'hex');
  const expectedHash = Buffer.from(hashHex, 'hex');

  try {
    const derived = scryptSync(candidateSecret, salt, expectedHash.length, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: SCRYPT_MAXMEM_BYTES,
    });
    return constantTimeEquals(derived, expectedHash);
  } catch {
    return false;
  }
}

function verifySha256(candidateSecret: string, storedHash: string): boolean {
  const hexDigest = storedHash.startsWith('sha256:')
    ? storedHash.slice('sha256:'.length)
    : storedHash;

  if (hexDigest.length !== 64 || !HEX_REGEX.test(hexDigest)) {
    return false;
  }

  const expected = Buffer.from(hexDigest, 'hex');
  const candidate = createHash('sha256').update(candidateSecret, 'utf8').digest();
  return constantTimeEquals(candidate, expected);
}

/**
 * Verifies the user's personal secret against `CLAIRFLUX_ACCESS_SECRET_HASH`
 * in constant time without native C++ addons.
 */
export function verifyAccessSecret(candidateSecret: string, storedHash: string): boolean {
  if (candidateSecret.length === 0) {
    return false;
  }

  const normalizedHash = storedHash.trim();
  if (normalizedHash.length === 0) {
    return false;
  }

  if (normalizedHash.startsWith('$argon2id$')) {
    return verifyArgon2idPhc(candidateSecret, normalizedHash);
  }
  if (normalizedHash.startsWith('$scrypt$')) {
    return verifyScryptPhc(candidateSecret, normalizedHash);
  }
  if (normalizedHash.startsWith('scrypt:')) {
    return verifyScryptColon(candidateSecret, normalizedHash);
  }
  if (normalizedHash.startsWith('sha256:') || (normalizedHash.length === 64 && HEX_REGEX.test(normalizedHash))) {
    return verifySha256(candidateSecret, normalizedHash);
  }

  return false;
}

export interface Argon2idHashParams {
  readonly m?: number;
  readonly t?: number;
  readonly p?: number;
  readonly dkLen?: number;
  readonly salt?: Uint8Array;
}

/**
 * Generates an Argon2id PHC string compatible with `verifyAccessSecret`.
 */
export function hashAccessSecretArgon2id(
  secret: string,
  params: Argon2idHashParams = {},
): string {
  const m = params.m ?? 65536;
  const t = params.t ?? 3;
  const p = params.p ?? 4;
  const dkLen = params.dkLen ?? 32;
  const salt = params.salt ?? randomBytes(16);

  const derived = argon2id(secret, salt, {
    m,
    t,
    p,
    dkLen,
    version: ARGON2ID_VERSION,
  });

  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${encodePhcBase64Unpadded(salt)}$${encodePhcBase64Unpadded(derived)}`;
}
