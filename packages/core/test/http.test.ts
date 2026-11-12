import { describe, expect, test } from 'bun:test';
import { rateLimitAddress } from '../src/http';

describe('rateLimitAddress', () => {
  test('keys IPv6 clients by their /64 and keeps IPv4 addresses', () => {
    expect(rateLimitAddress('2001:0db8:0000:0001:aaaa::1')).toBe('2001:db8:0:1::/64');
    expect(rateLimitAddress('2001:db8:0:1:ffff:ffff:ffff:ffff')).toBe('2001:db8:0:1::/64');
    expect(rateLimitAddress('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitAddress('198.51.100.7')).toBe('198.51.100.7');
    expect(rateLimitAddress('::ffff:198.51.100.7')).toBe('::ffff:198.51.100.7');
    expect(rateLimitAddress(null)).toBe('unknown');
  });
});
