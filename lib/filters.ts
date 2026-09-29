/**
 * Keeps the archive to what a student can learn from. Feed ads, Falcon-dirham trades and bare listings are dropped,
 * and so are the "bump", tag-a-friend and emoji comments under real threads. The same rules run before indexing and
 * again when an older index is loaded, so a stale data/index is cleaned on the way in.
 */
import type { SourceComment, SourcePost } from './types.ts';

export type DropReason = 'empty' | 'ad' | 'falcons' | 'listing';

const FALCON = /\bfalcons?\b/i;
/** The bird, the airline lounge, the travel agency: not the campus currency. */
const FALCON_NOT_CURRENCY = /\bfalcons?\s+(?:team|club|society|group|bird|show|hospital|lounge)|\bfalconry|\bfalconer/i;
const TRADE = /\b(?:sell|selling|sold|buy|buying|exchange|exchanging|trade|trading|swap|rates?|offers?|dirhams?|aed|usd|cash|pm|dm)\b|\d{3,}|\d+(?:\.\d+)?k\b/i;

const LISTING_START =
  /^\s*(?:\[[^\]]*\]\s*)?(?:selling|for sale|wts\b|wtb\b|giving away|give away|looking to (?:sell|buy)|anyone (?:selling|buying)|anybody selling|does anyone (?:sell|want to buy))/i;
const LISTING_ANY = /\b(?:wts|wtb)\b|\b(?:pm|dm)\s+(?:me\s+)?(?:with|w\/?|for)\s+(?:your\s+)?(?:offers?|price|rates?)|\b(?:pm|dm)\s+(?:me\s+)?if\s+interested/i;
const SPONSORED = /\b(?:t&cs apply|book now|register now|limited offer|sponsored|use code|try free|sign up today)\b/i;

/** Why a post is left out of the archive, or null when it stays. */
export function classifyPost(post: SourcePost): DropReason | null {
  if (!post.id) return 'empty';
  const text = post.text.trim();
  if (!text && post.comments.length === 0) return 'empty';
  // Posts Facebook injects into the feed carry neither a permalink nor a date.
  if (!post.url && !post.date) return 'ad';
  if (SPONSORED.test(text) && post.comments.length <= 1) return 'ad';
  if (FALCON.test(text) && !FALCON_NOT_CURRENCY.test(text)) {
    const genuineQuestion = text.includes('?') && !TRADE.test(text);
    if (!genuineQuestion) return 'falcons';
  }
  if (LISTING_START.test(text) || LISTING_ANY.test(text)) return 'listing';
  return null;
}

const BUMP = /^(?:self)?(?:(?:b+[uo]+m+[pb]+)+(?:s|y|ing|ed|ie+|e+)?|p+u+m+b+|b+u+m+o+|b+m+p+|b+o+m+p+|مطب+)$/;
const FILLER = new Set(['self', 'and', 'following', 'follow', 'for', 'a', 'friend', 'please', 'pls', 'plz', 'this', 'post', 'thread', 'up', 'me', 'too', 'also', 'again', 'still', 'the', 'big', 'massive', 'double', 'triple', 'bald', 'innit', 'lol', 'haha', 'my', 'of']);
const GENERIC = new Set([
  'pm', 'dm', 'pm me', 'dm me', 'pmed', 'pmd', 'dmed', 'dmd', 'pmed you', 'dmed you', 'check pm', 'check dm', 'check pms', 'check dms',
  'check your pm', 'check your dm', 'sent', 'sent you a message', 'sent you a dm', 'messaged', 'messaged you', 'interested', 'yes', 'no', 'ok',
  'okay', 'thanks', 'thank you', 'thx', 'ty', 'done', 'sold', 'resolved', 'same', 'nice', 'super', 'weird', 'lol', 'haha', 'omg', 'wow', 'me',
  'following', 'follow', 'up', 'hi', 'hey', 'hello', 'oh', 'yay',
]);
const CONTACTED = /^(?:i\s+)?(?:have\s+|already\s+)?(?:pm|dm)(?:ed|d|'d|’d)?(?:\s+(?:you|u|him|her|them))?(?:\s+already)?$/;

function plainWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** "bump", "bumppp", "self bump", "bump and following", "up", "following", and a bump with a name or two. */
export function isBump(text: string): boolean {
  const words = plainWords(text);
  if (words.length === 0) return false;
  let bumps = 0;
  let other = 0;
  for (const word of words) {
    const squeezed = word.replace(/(.)\1+/g, '$1');
    if (BUMP.test(word) || BUMP.test(squeezed)) bumps++;
    else if (!FILLER.has(word)) other++;
  }
  if (bumps > 0) return other <= 2;
  return words.every((word) => FILLER.has(word));
}

/**
 * Names of everyone who posted or commented, lower-cased. Facebook renders "tag a friend" comments as a bare name,
 * and the tagged person is usually somewhere else in the archive too.
 */
export function collectNames(posts: SourcePost[]): Set<string> {
  const names = new Set<string>();
  for (const post of posts) {
    if (post.author) names.add(normaliseName(post.author));
    for (const comment of post.comments) if (comment.author) names.add(normaliseName(comment.author));
  }
  names.delete('');
  return names;
}

function normaliseName(value: string): string {
  return plainWords(value).join(' ');
}

function isTag(text: string, names: Set<string>): boolean {
  // Tags start with a capitalised name; whatever follows is at most a "bump" or a "please".
  if (!/^[\p{Lu}]/u.test(text.trim())) return false;
  let rest = ` ${normaliseName(text)} `;
  if (names.has(rest.trim())) return true;
  if (names.size === 0) return false;
  let stripped = false;
  for (const name of names) {
    if (name.length < 5 || !rest.includes(` ${name} `)) continue;
    rest = rest.replace(` ${name} `, ' ');
    stripped = true;
  }
  if (!stripped) return false;
  const remainder = rest.trim();
  if (!remainder) return true;
  return remainder.split(' ').every((word) => FILLER.has(word) || GENERIC.has(word) || BUMP.test(word.replace(/(.)\1+/g, '$1')));
}

/** True for a comment that adds nothing a reader or the model can use. */
export function isNoiseComment(comment: Pick<SourceComment, 'text'>, names: Set<string> = new Set()): boolean {
  const text = comment.text.trim();
  if (!text) return true;
  if (!/[\p{L}\p{N}]/u.test(text)) return true;
  const words = plainWords(text);
  if (words.join('').length < 2) return true;
  const plain = words.join(' ');
  if (GENERIC.has(plain) || CONTACTED.test(plain)) return true;
  if (isBump(text)) return true;
  if (words.length <= 6 && isTag(text, names)) return true;
  return false;
}

/** A copy of the post without noise comments; commentCount follows what is left. */
export function cleanPost<T extends SourcePost>(post: T, names: Set<string> = new Set()): T {
  const comments = post.comments.filter((comment) => !isNoiseComment(comment, names));
  if (comments.length === post.comments.length && post.commentCount === comments.length) return post;
  return { ...post, comments, commentCount: comments.length };
}

export interface CleanResult<T extends SourcePost> {
  posts: T[];
  /** Positions in the input that were kept, in order. */
  kept: number[];
  dropped: Record<DropReason, number>;
  commentsDropped: number;
}

/** Applies both filters to a whole archive in one pass. */
export function cleanPosts<T extends SourcePost>(posts: T[]): CleanResult<T> {
  const names = collectNames(posts);
  const dropped: Record<DropReason, number> = { empty: 0, ad: 0, falcons: 0, listing: 0 };
  const kept: number[] = [];
  const out: T[] = [];
  let commentsDropped = 0;
  posts.forEach((post, index) => {
    const reason = classifyPost(post);
    if (reason) {
      dropped[reason]++;
      return;
    }
    const cleaned = cleanPost(post, names);
    commentsDropped += post.comments.length - cleaned.comments.length;
    kept.push(index);
    out.push(cleaned);
  });
  return { posts: out, kept, dropped, commentsDropped };
}
