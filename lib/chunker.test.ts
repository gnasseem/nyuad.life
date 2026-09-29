import { describe, expect, it } from 'vitest';
import { CHUNK_LIMIT, chunkPost } from './chunker.ts';

const options = { model: 'test', dimensions: 8 };

describe('chunkPost', () => {
  it('renders a short post with its comments as one chunk', () => {
    const chunks = chunkPost(
      {
        id: '42',
        url: 'https://example.com/42',
        author: 'Maya',
        date: '2024-11-02',
        text: 'Is this course worth taking?',
        comments: [{ author: 'Omar', date: '', text: 'Yes, the lectures are clear.' }],
      },
      options,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.id).toBe('42#1');
    expect(chunks[0]!.text.startsWith('Post by Maya on 2024-11-02. 1 comments.')).toBe(true);
    expect(chunks[0]!.text).toContain('Comment by Omar: Yes, the lectures are clear.');
    expect(chunks[0]!.hash).toHaveLength(24);
  });

  it('repeats the post context in every chunk of a long thread', () => {
    const body = Array.from({ length: 45 }, (_, i) => `Sentence ${i} explains a different part of the course experience.`).join(' ');
    const chunks = chunkPost(
      {
        id: 'long',
        url: '',
        author: 'Student',
        date: '2025-01-10',
        text: body,
        comments: Array.from({ length: 8 }, (_, i) => ({ author: `Person ${i}`, date: '', text: body.slice(0, 260) })),
      },
      options,
    );
    expect(chunks.length).toBeGreaterThan(2);
    chunks.forEach((chunk, index) => {
      expect(chunk.id).toBe(`long#${index + 1}`);
      expect(chunk.text.startsWith(`Post by Student on 2025-01-10. 8 comments.\n${body.slice(0, 240)}`)).toBe(true);
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_LIMIT + 50);
    });
  });

  it('skips posts without body or comments', () => {
    expect(chunkPost({ id: 'empty', url: '', author: '', date: '', text: '   ', comments: [] }, options)).toEqual([]);
  });

  it('changes the hash when the embedding model changes', () => {
    const post = { id: '1', url: '', author: 'A', date: '', text: 'hello', comments: [] };
    expect(chunkPost(post, options)[0]!.hash).not.toBe(chunkPost(post, { model: 'other', dimensions: 8 })[0]!.hash);
  });
});
