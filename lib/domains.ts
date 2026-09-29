/**
 * Questions the archive should not try to answer, and where to send people instead. Falcon-dirham trades belong on
 * Falcon Market; listings, rides and lost-and-found are live requests for the group itself, not questions with a
 * durable answer.
 */

export type OffTopicDomain = 'falcons' | 'listing' | 'ride' | 'lost-found' | 'live';

export interface Redirect {
  domain: OffTopicDomain;
  title: string;
  message: string;
  link: { url: string; label: string };
}

export const FALCON_MARKET_URL = 'https://www.falconmarket.me';
export const DEFAULT_GROUP_URL = 'https://www.facebook.com/groups/nyuad.room.of.requirement';

export function groupUrl(env: NodeJS.ProcessEnv = process.env): string {
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
  const group = groupUrl(env);
  if (FALCON.test(text) && !FALCON_NOT_CURRENCY.test(text) && FALCON_TRADE.test(text)) {
    return {
      domain: 'falcons',
      title: 'Falcons are traded on Falcon Market',
      message: 'Buying, selling and exchanging Falcon dirhams happens on Falcon Market. Trade posts are left out of this archive.',
      link: { url: FALCON_MARKET_URL, label: 'Open Falcon Market' },
    };
  }
  if (LISTING.some((pattern) => pattern.test(text))) {
    return {
      domain: 'listing',
      title: 'Listings go in the group',
      message: 'This site keeps advice and experiences, not things for sale. Post the listing in the Room of Requirement group so people can message you.',
      link: { url: group, label: 'Open the group' },
    };
  }
  if (RIDE.some((pattern) => pattern.test(text))) {
    return {
      domain: 'ride',
      title: 'Rides need a live audience',
      message: 'A carpool or shared taxi only works with people who are around right now, so post it in the group instead of searching old threads.',
      link: { url: group, label: 'Open the group' },
    };
  }
  if (LOST_FOUND.some((pattern) => pattern.test(text))) {
    return {
      domain: 'lost-found',
      title: 'Lost and found is a live request',
      message: 'Old threads will not know where your things are. Post in the group with where and when you last had them.',
      link: { url: group, label: 'Open the group' },
    };
  }
  if (LIVE.some((pattern) => pattern.test(text)) && LIVE_NEED.test(text)) {
    return {
      domain: 'live',
      title: 'Ask the group for this one',
      message: 'This needs someone who can help right now, so it belongs in the group rather than in a search of past threads.',
      link: { url: group, label: 'Open the group' },
    };
  }
  return null;
}
