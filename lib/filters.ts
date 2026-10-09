/**
 * Keeps the archive to what a student can learn from. Feed ads, Falcon and Campus Dirham trades and bare listings are dropped,
 * and so are the "bump", tag-a-friend and emoji comments under real threads. The same rules run before indexing and
 * again when an older index is loaded, so a stale data/index is cleaned on the way in.
 */
import type { SourceComment, SourcePost } from './types.ts';

type DropReason = 'empty' | 'ad' | 'falcons' | 'listing' | 'noise' | 'duplicate' | 'unanswered';

/**
 * Bump whenever a rule below changes what is kept. An index built with the current version is loaded as it is; an
 * older one is cleaned again on load, which costs about a second on every cold start until it is rebuilt.
 */
export const FILTERS_VERSION = 4;

const FALCON = /\bfalcons?\b/i;
/** Campus Dirhams: meal-plan money, traded like Falcons ("selling 360 campus dirhams at 50%"). */
const CAMPUS = /\bcampus\s*(?:dirhams?|dhs?)\b/i;
/** The currencies' own names, taken out before looking for trade words, since "dirhams" is one. */
const CURRENCY_NAMES = /\b(?:falcons?|campus)\s*(?:dirhams?|dhs?)\b/gi;
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
  if ((FALCON.test(text) && !FALCON_NOT_CURRENCY.test(text)) || CAMPUS.test(text)) {
    const genuineQuestion = text.includes('?') && !TRADE.test(text.replace(CURRENCY_NAMES, ''));
    if (!genuineQuestion) return 'falcons';
  }
  if (LISTING_START.test(text) || LISTING_ANY.test(text)) return 'listing';
  if (/\b(?:lost my|found (?:a|an|some)|ride (?:to|from)|anyone (?:driving|going) to|cleaners? (?:needed|wanted)|looking for (?:a )?(?:cleaner|maid))\b/i.test(text) && !/\b(?:how|where|policy|rules|usually|service|recommend)\b/i.test(text)) return 'listing';
  if (isNoiseComment({ text }) && post.comments.every((comment) => isNoiseComment(comment))) return 'noise';
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

/** Names are a few words long; longer runs are never looked up. */
const MAX_NAME_WORDS = 5;

function isTag(text: string, names: Set<string>): boolean {
  // Tags start with a capitalised name; whatever follows is at most a "bump" or a "please".
  if (!/^[\p{Lu}]/u.test(text.trim())) return false;
  const words = normaliseName(text).split(' ').filter(Boolean);
  if (names.has(words.join(' '))) return true;
  if (names.size === 0) return false;
  // Strip every run of words that is someone's name, longest first. Looking up the comment's own runs keeps this
  // linear in its length; walking the whole name list for every comment took seconds on a cold start.
  const rest: string[] = [];
  let stripped = false;
  for (let i = 0; i < words.length; ) {
    let matched = 0;
    for (let length = Math.min(MAX_NAME_WORDS, words.length - i); length > 0; length--) {
      const candidate = words.slice(i, i + length).join(' ');
      if (candidate.length >= 5 && names.has(candidate)) {
        matched = length;
        break;
      }
    }
    if (matched) {
      stripped = true;
      i += matched;
    } else rest.push(words[i++]!);
  }
  if (!stripped) return false;
  return rest.every((word) => FILLER.has(word) || GENERIC.has(word) || BUMP.test(word.replace(/(.)\1+/g, '$1')));
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

/** Keep Facebook and scrape counts when removing low-information comments. */
export function cleanPost<T extends SourcePost>(post: T, names: Set<string> = new Set()): T {
  const comments = post.comments.filter((comment) => !isNoiseComment(comment, names));
  const facebookCommentCount = post.facebookCommentCount ?? Math.max(post.commentCount ?? 0, post.comments.length);
  const scrapedCommentCount = post.scrapedCommentCount ?? post.comments.length;
  if (comments.length === post.comments.length && post.commentCount === comments.length && post.facebookCommentCount === facebookCommentCount && post.scrapedCommentCount === scrapedCommentCount) return post;
  return { ...post, comments, commentCount: comments.length, facebookCommentCount, scrapedCommentCount };
}

interface CleanResult<T extends SourcePost> {
  posts: T[];
  /** Positions in the input that were kept, in order. */
  kept: number[];
  dropped: Record<DropReason, number>;
  commentsDropped: number;
}

/** Applies both filters to a whole archive in one pass. */
export function cleanPosts<T extends SourcePost>(posts: T[]): CleanResult<T> {
  const names = collectNames(posts);
  const dropped: Record<DropReason, number> = { empty: 0, ad: 0, falcons: 0, listing: 0, noise: 0, duplicate: 0, unanswered: 0 };
  const kept: number[] = [];
  const out: T[] = [];
  let commentsDropped = 0;
  const fingerprints = new Set<string>();
  posts.forEach((post, index) => {
    const reason = classifyPost(post);
    if (reason) {
      dropped[reason]++;
      return;
    }
    const cleaned = cleanPost(post, names);
    // A short unanswered request adds no evidence. Keep detailed posts and first-hand experience even without replies.
    const body = cleaned.text.trim().replace(/^(?:hi|hey|hello)[\s,!.-]+/i, '');
    const request = /^(?:anyone\b|does anyone\b|can (?:anyone|someone)\b|has anyone\b|is there\b|where (?:can|do|is|are)\b|who (?:can|is|are)\b|what(?:'s| is| are)\b|how (?:do|can)\b|any (?:recommendations|tips)\b)/i;
    const experience = /\b(?:I took|I tried|my experience|here is|here are|I found|I recommend|I paid|I've tried|I have used)\b/i;
    if (!cleaned.comments.length && body.length <= 240 && request.test(body) && !experience.test(body)) {
      dropped.unanswered++;
      commentsDropped += post.comments.length;
      return;
    }
    const fingerprint = [cleaned.text, ...cleaned.comments.map((comment) => comment.text)].map((text) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()).join('\n');
    if (fingerprint.length >= 30 && fingerprints.has(fingerprint)) {
      dropped.duplicate++;
      return;
    }
    fingerprints.add(fingerprint);
    commentsDropped += post.comments.length - cleaned.comments.length;
    kept.push(index);
    out.push(cleaned);
  });
  return { posts: out, kept, dropped, commentsDropped };
}
