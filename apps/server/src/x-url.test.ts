import { describe, expect, it } from 'vitest';
import { extractUrls, parseXPostUrl } from './x-url.js';

describe('parseXPostUrl', () => {
  it('normalizes a public post link', () => {
    expect(parseXPostUrl('https://x.com/OpenAI/status/1234567890123456789?s=20')).toEqual({
      tweetId: '1234567890123456789',
      canonicalUrl: 'https://x.com/OpenAI/status/1234567890123456789',
    });
  });

  it.each([
    'https://x.com/OpenAI',
    'https://x.com/search?q=video',
    'https://example.com/OpenAI/status/1234567890123456789',
    'http://x.com/OpenAI/status/1234567890123456789',
  ])('rejects unsupported input: %s', (url) => expect(() => parseXPostUrl(url)).toThrow());
});

it('extracts URLs from pasted text and CSV', () => {
  expect(extractUrls('url\nhttps://x.com/a/status/1234567890, https://twitter.com/b/status/1234567891')).toHaveLength(2);
});
