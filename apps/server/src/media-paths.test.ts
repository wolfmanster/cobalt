import { describe, expect, it } from 'vitest';
import { buildAuthorFolder, buildMediaFilename, buildPostFolder, formatPublishedDate } from './media-paths.js';

describe('media path naming', () => {
  it('formats the publication date and appends the tweet ID', () => {
    expect(formatPublishedDate('2026-08-18T16:02:03.000Z')).toBe('2026-08-19');
    expect(buildPostFolder({ publishedAt: '2026-08-19T01:02:03.000Z', text: 'hello world' }, '1234567890'))
      .toBe('2026-08-19_hello world_1234567890');
  });

  it('uses the China Standard Time date around UTC midnight', () => {
    expect(formatPublishedDate('2026-08-19T15:59:59.000Z')).toBe('2026-08-19');
    expect(formatPublishedDate('2026-08-19T16:00:00.000Z')).toBe('2026-08-20');
  });

  it('sanitizes Windows path characters while preserving the tweet ID suffix', () => {
    const folder = buildPostFolder(
      { publishedAt: '2026-08-19T01:02:03.000Z', text: 'a/b:c?'.repeat(60)
      },
      '1234567890',
    );

    expect(folder).toMatch(/^2026-08-19_a_b_c_.*_1234567890$/);
    expect(folder).not.toMatch(/[<>:"/\\|?*]/);
  });

  it('builds the author folder from display name and username', () => {
    expect(buildAuthorFolder({ authorName: 'A/B', username: 'animal_kyawa_' }, 'fallback'))
      .toBe('A_B@animal_kyawa_');
  });

  it.each([
    [{ kind: 'image', filename: 'source.jpg' }, '1-pic.jpg'],
    [{ kind: 'video', filename: 'source.mp4' }, '2-vdo.mp4'],
    [{ kind: 'gif', filename: 'source.gif' }, '3-pic.gif'],
  ] as const)('names media by tweet order and type', (media, expected) => {
    expect(buildMediaFilename({
      ...media,
      downloadedBytes: 0,
      id: 'media',
      sourceUrl: 'https://example.com/media',
    }, Number(expected[0]) - 1)).toBe(expected);
  });
});
