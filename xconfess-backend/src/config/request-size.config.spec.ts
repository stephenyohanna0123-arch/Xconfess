import {
  DEFAULT_MAX_NESTING_DEPTH,
  DEFAULT_REQUEST_MAX_BYTES,
  MAX_CONFIGURABLE_REQUEST_BYTES,
  parseRequestSizeOverrides,
} from './request-size.config';

describe('request size configuration (issue #181)', () => {
  it('returns no overrides when nothing is configured', () => {
    expect(parseRequestSizeOverrides(undefined)).toEqual({});
    expect(parseRequestSizeOverrides('')).toEqual({});
  });

  it('parses a valid override map', () => {
    const overrides = parseRequestSizeOverrides(
      JSON.stringify({ 'confessions:write': 32768, default: 65536 }),
    );

    expect(overrides).toEqual({ 'confessions:write': 32768, default: 65536 });
  });

  it('ignores malformed JSON', () => {
    expect(parseRequestSizeOverrides('{not json')).toEqual({});
  });

  it('ignores non-object payloads', () => {
    expect(parseRequestSizeOverrides('[1,2,3]')).toEqual({});
    expect(parseRequestSizeOverrides('"nope"')).toEqual({});
  });

  it('ignores invalid or non-positive byte values', () => {
    const overrides = parseRequestSizeOverrides(
      JSON.stringify({ a: 0, b: -10, c: 'many', d: 1024 }),
    );

    expect(overrides).toEqual({ d: 1024 });
  });

  it('clamps a configured budget to the hard ceiling', () => {
    const overrides = parseRequestSizeOverrides(
      JSON.stringify({ default: MAX_CONFIGURABLE_REQUEST_BYTES * 10 }),
    );

    expect(overrides.default).toBe(MAX_CONFIGURABLE_REQUEST_BYTES);
  });

  it('exposes sane defaults', () => {
    expect(DEFAULT_REQUEST_MAX_BYTES).toBe(100 * 1024);
    expect(DEFAULT_MAX_NESTING_DEPTH).toBe(8);
  });
});
