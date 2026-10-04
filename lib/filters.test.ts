import { describe, expect, it } from 'vitest';
import { classifyPost, cleanPost, cleanPosts, collectNames, isBump, isNoiseComment } from './filters.ts';
import type { SourcePost } from './types.ts';

const post = (overrides: Partial<SourcePost>): SourcePost => ({ id: 'x', url: 'https://fb/x', author: 'Someone', date: '2026-05-01', text: '', comments: [], ...overrides });

describe('classifyPost', () => {
  it('drops feed ads, which carry neither a permalink nor a date', () => {
    expect(classifyPost(post({ url: '', date: '', author: 'Yas Island', text: 'Kids go free this season' }))).toBe('ad');
    expect(classifyPost(post({ text: 'Book now, T&Cs apply' }))).toBe('ad');
  });
  it('drops Falcon-dirham trades but keeps questions about the currency', () => {
    expect(classifyPost(post({ text: 'Selling 3000 falcons pm with offers' }))).toBe('falcons');
    expect(classifyPost(post({ text: 'Looking for 8.5k falcon. Please let me know your rates.' }))).toBe('falcons');
    expect(classifyPost(post({ text: 'Looking for Falcons - Urgent Need' }))).toBe('falcons');
    expect(classifyPost(post({ text: 'Can I use falcons at the gym or only at the dining halls?' }))).toBeNull();
    expect(classifyPost(post({ text: 'Does the Falcon Team at Nirvana have a phone number?' }))).toBeNull();
    // The currency's own name is not a trade word.
    expect(classifyPost(post({ text: 'Can I spend falcon dirhams at the bookstore?' }))).toBeNull();
  });
  it('drops Campus Dirham trades too, but keeps questions about them', () => {
    expect(classifyPost(post({ text: "I'm selling 360 campus dirhams at 50%. DM if you're interested." }))).toBe('falcons');
    expect(classifyPost(post({ text: 'hiii i’m looking to buy 300 campus dirhams, pls dm me if you’re selling' }))).toBe('falcons');
    expect(classifyPost(post({ text: 'when do campus dirhams expire? and when do falcons?' }))).toBeNull();
  });
  it('drops bare listings and keeps housing requests', () => {
    expect(classifyPost(post({ text: 'Selling 2 commencement tickets! PM w offers.' }))).toBe('listing');
    expect(classifyPost(post({ text: 'Anyone selling etihad miles?' }))).toBe('listing');
    expect(classifyPost(post({ text: 'Giving away a desk lamp, dm if interested' }))).toBe('listing');
    expect(classifyPost(post({ text: 'Anyone subletting their studio in Abu Dhabi from May until August?' }))).toBeNull();
    expect(classifyPost(post({ text: 'Where do people buy cheap furniture in Abu Dhabi?' }))).toBeNull();
  });
  it('keeps ordinary questions and drops empty posts', () => {
    expect(classifyPost(post({ text: 'Which professor should I take for calculus?' }))).toBeNull();
    expect(classifyPost(post({ text: '' }))).toBe('empty');
    expect(classifyPost(post({ id: '' }))).toBe('empty');
  });
});

describe('isBump', () => {
  it('recognises every spelling of bump', () => {
    for (const text of ['bump', 'Bumppp!', 'buump', 'bomp', 'bumo', 'pumb', 'self bump', 'selfbump', 'bump and following', 'bump bump bump', 'bump for a friend', 'bumpy', 'BUMP.', 'up', 'following']) {
      expect(isBump(text), text).toBe(true);
    }
  });
  it('leaves real comments alone', () => {
    for (const text of ['Bump is not what I meant, take Dania', 'The bumpy road to A5 is closed', 'Following up: she replied within a day', 'Up to 3000 AED a month']) {
      expect(isBump(text), text).toBe(false);
    }
  });
});

describe('isNoiseComment', () => {
  const names = new Set(['casey sample', 'riley example']);
  it('drops tags, contact-me notes and emoji', () => {
    for (const text of ['Casey Sample', 'Casey Sample Riley Example', 'Casey Sample bump', 'Riley Example please', 'pmed', "PM'd you", 'Check DM', 'interested', '🙏🙏', '.', 'same', 'Thanks!']) {
      expect(isNoiseComment({ text }, names), text).toBe(true);
    }
  });
  it('keeps short but real answers', () => {
    for (const text of ['Marina Mall', 'Data Structures', 'Dania, without a doubt', 'No, the shuttle stops at 11pm', 'Lulu Hypermarket has them for 40 AED', 'Casey Sample knows, she took it last spring']) {
      expect(isNoiseComment({ text }, names), text).toBe(false);
    }
  });
});

describe('cleanPost and cleanPosts', () => {
  const archive: SourcePost[] = [
    post({ id: '1', text: 'Best calculus professor?', commentCount: 4, comments: [{ author: 'Casey Sample', date: '', text: 'Dania' }, { author: 'Ben', date: '', text: 'bump' }, { author: 'Cy', date: '', text: 'Casey Sample' }, { author: 'Di', date: '', text: '🙏' }] }),
    post({ id: '2', text: 'Selling 500 falcons', comments: [{ author: 'E', date: '', text: 'pmed' }] }),
    post({ id: '3', url: '', date: '', text: 'Sponsored thing', comments: [] }),
  ];
  it('collects the names people are tagged by', () => {
    expect(collectNames(archive)).toEqual(new Set(['someone', 'casey sample', 'ben', 'cy', 'di', 'e']));
  });
  it('removes noise comments and fixes the count', () => {
    const cleaned = cleanPost(archive[0]!, collectNames(archive));
    expect(cleaned.comments.map((comment) => comment.text)).toEqual(['Dania']);
    expect(cleaned.commentCount).toBe(1);
    expect(archive[0]!.comments).toHaveLength(4);
  });
  it('reports what it dropped', () => {
    const result = cleanPosts(archive);
    expect(result.posts.map((entry) => entry.id)).toEqual(['1']);
    expect(result.kept).toEqual([0]);
    expect(result.dropped).toEqual({ empty: 0, ad: 1, falcons: 1, listing: 0 });
    expect(result.commentsDropped).toBe(3);
  });
});
