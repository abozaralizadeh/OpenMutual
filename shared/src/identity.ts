import { createHash } from 'node:crypto';

export interface IdentityResult {
  passed: boolean;
  /** Same person, same value. Used so one person can't hold two memberships. */
  personHash: string;
  reason?: string;
}

/**
 * Identity and sanctions check. The real thing is a paid provider. Today only the
 * local fake exists, and it does no real check at all.
 */
export interface IdentityProvider {
  name: string;
  check(person: { fullName: string; country: string }): Promise<IdentityResult>;
}

export function fakeIdentityProvider(): IdentityProvider {
  return {
    name: 'fake-identity',
    async check({ fullName, country }) {
      const normalised = `${fullName.trim().toLowerCase().replace(/\s+/g, ' ')}|${country.trim().toLowerCase()}`;
      const personHash = createHash('sha256').update(normalised).digest('hex');
      if (normalised.includes('blocked')) return { passed: false, personHash, reason: 'The test check turned this name down.' };
      return { passed: true, personHash };
    },
  };
}
