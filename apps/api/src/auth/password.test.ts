import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashAccessSecretArgon2id, verifyAccessSecret } from './password.js';

describe('verifyAccessSecret & hashAccessSecretArgon2id', () => {
  it('vérifie un hash Argon2id généré par hashAccessSecretArgon2id et rejette un mauvais secret', () => {
    const hash = hashAccessSecretArgon2id('clairflux-secret-perso-2026', {
      m: 4096,
      t: 2,
      p: 1,
    });
    expect(hash.startsWith('$argon2id$v=19$m=4096,t=2,p=1$')).toBe(true);
    expect(verifyAccessSecret('clairflux-secret-perso-2026', hash)).toBe(true);
    expect(verifyAccessSecret('mauvais-secret', hash)).toBe(false);
    expect(verifyAccessSecret('', hash)).toBe(false);
  });

  it('est 100 % interopérable avec un vecteur PHC Argon2id de référence (OpenSSL/Node)', () => {
    const phc =
      '$argon2id$v=19$m=4096,t=2,p=2$MDEyMzQ1Njc4OWFiY2RlZg$uPBDy0oklagyKyxDYqWV6iZJ4w4h6efsXx1PeBlEOxs';

    expect(verifyAccessSecret('mon-mot-de-passe-nas', phc)).toBe(true);
    expect(verifyAccessSecret('autre-mot-de-passe', phc)).toBe(false);
  });

  it('rejette les paramètres Argon2id hors bornes anti-DoS ou malformés', () => {
    const saltB64 = Buffer.from('0123456789abcdef').toString('base64').replace(/=+$/, '');
    const hashB64 = Buffer.alloc(32, 1).toString('base64').replace(/=+$/, '');

    expect(
      verifyAccessSecret('secret', `$argon2id$v=19$m=9999999,t=3,p=1$${saltB64}$${hashB64}`),
    ).toBe(false);
    expect(
      verifyAccessSecret('secret', `$argon2id$v=18$m=4096,t=3,p=1$${saltB64}$${hashB64}`),
    ).toBe(false);
    expect(verifyAccessSecret('secret', 'plain-text-secret')).toBe(false);
    expect(verifyAccessSecret('secret', '')).toBe(false);
  });

  it('vérifie les formats scrypt (PHC et colon) et sha256', () => {
    const salt = randomBytes(16);
    const scryptDerived = scryptSync('secret-scrypt', salt, 32, { N: 16384, r: 8, p: 1 });
    const scryptPhc = `$scrypt$ln=14,r=8,p=1$${salt.toString('base64').replace(/=+$/, '')}$${scryptDerived.toString('base64').replace(/=+$/, '')}`;
    const scryptColon = `scrypt:${salt.toString('hex')}:${scryptDerived.toString('hex')}`;

    expect(verifyAccessSecret('secret-scrypt', scryptPhc)).toBe(true);
    expect(verifyAccessSecret('wrong', scryptPhc)).toBe(false);
    expect(verifyAccessSecret('secret-scrypt', scryptColon)).toBe(true);
    expect(verifyAccessSecret('wrong', scryptColon)).toBe(false);

    const shaHex = createHash('sha256').update('secret-sha', 'utf8').digest('hex');
    expect(verifyAccessSecret('secret-sha', `sha256:${shaHex}`)).toBe(true);
    expect(verifyAccessSecret('secret-sha', shaHex)).toBe(true);
    expect(verifyAccessSecret('wrong', `sha256:${shaHex}`)).toBe(false);
  });
});
