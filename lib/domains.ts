/**
 * Questions the archive should not try to answer, and where to send people instead. Falcon trades belong on the
 * Falcons page; listings, rides and lost-and-found are live requests for the group, not questions with a durable answer.
 */

type OffTopicDomain = 'falcons' | 'listing' | 'ride' | 'lost-found' | 'live';

export interface Redirect {
  domain: OffTopicDomain;
  title: string;
  message: string;
  link: { url: string; label: string };
}

/** The in-app exchange; a path, so the web app routes it without a page load. */
export const FALCONS_PATH = '/falcons';
export const DEFAULT_GROUP_URL = 'https://www.facebook.com/groups/nyuad.room.of.requirement';

function groupUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.ROR_GROUP_URL ?? '').trim() || DEFAULT_GROUP_URL;
}

const FALCON = /\bfalcons?\b/i;
const FALCON_NOT_CURRENCY = /\bfalcons?\s+(?:team|club|society|group|bird|show|hospital|lounge)|\bfalconry|\bfalconer/i;
const FALCON_TRADE = /\b(?:sell|selling|buy|buying|exchange|exchanging|trade|trading|swap|rates?|offers?|cash|need|looking for|want|wanted|get rid of|convert)\b|\d/i;

const LISTING = [
  /^\s*(?:selling|for sale|wts\b|wtb\b|giving away|give away|looking to (?:sell|buy)|anyone (?:selling|buying|want to buy)|anybody selling|does anyone (?:sell|want to buy)|i(?:'m| am) selling)/i,
  /\b(?:wts|wtb)\b/i,
  /\b(?:i(?:'m| am)|we(?:'re| are))\s+(?:selling|giving away)\b/i,
  /\b(?:pm|dm)\s+(?:me\s+)?(?:with|w\/?|for)\s+(?:your\s+)?(?:offers?|price|rates?)/i,
];
const RIDE = [
  /\b(?:anyone|anybody|someone|who)\b.{0,40}\b(?:going|driving|heading|leaving)\s+to\b/i,
  /\b(?:share|split)\s+(?:a\s+)?(?:taxi|cab|careem|uber|ride)\b/i,
  /\b(?:carpool|car pool|need a ride|ride to|lift to)\b/i,
];
const LOST_FOUND = [
  /\b(?:i|we)\s+(?:have\s+)?(?:lost|left|misplaced|forgot)\s+(?:my|our|a|an)\b/i,
  /\b(?:found|has anyone seen|have you seen|anyone seen)\s+(?:a|an|my|this|someone's|these)\b/i,
  /\bmissing (?:my|our)\b/i,
];
const LIVE = [/\b(?:anyone|anybody|someone)\b.{0,60}\b(?:right now|rn|at the moment|asap|urgently|tonight|today)\b/i];
const LIVE_NEED = /\b(?:have|has|got|lend|borrow|spare|give|bring)\b/i;

/** Returns where to send an off-platform request, or null when the archive should answer it. */
export function detectRedirect(question: string, env: NodeJS.ProcessEnv = process.env): Redirect | null {
  const text = question.trim();
  if (!text) return null;
  const group = { url: groupUrl(env), label: 'Open the group' };
  if (FALCON.test(text) && !FALCON_NOT_CURRENCY.test(text) && FALCON_TRADE.test(text)) {
    return { domain: 'falcons', title: 'Trade Falcons on the Falcons page', message: 'Post what you have or want and people contact you directly.', link: { url: FALCONS_PATH, label: 'Open Falcons' } };
  }
  if (LISTING.some((pattern) => pattern.test(text))) {
    return { domain: 'listing', title: 'Listings go in the group', message: 'This site keeps advice and experience, not things for sale.', link: group };
  }
  if (RIDE.some((pattern) => pattern.test(text))) {
    return { domain: 'ride', title: 'Rides go in the group', message: 'A ride needs people who are around now, not old threads.', link: group };
  }
  if (LOST_FOUND.some((pattern) => pattern.test(text))) {
    return { domain: 'lost-found', title: 'Lost and found goes in the group', message: 'Post where and when you last had it.', link: group };
  }
  if (LIVE.some((pattern) => pattern.test(text)) && LIVE_NEED.test(text)) {
    return { domain: 'live', title: 'Ask the group', message: 'This needs someone who can help right now.', link: group };
  }
  return null;
}
