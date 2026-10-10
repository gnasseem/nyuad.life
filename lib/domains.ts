/**
 * Questions the archive should not try to answer, and where to send people instead. Falcon and Campus Dirham trades,
 * listings and rides are live requests with their own pages in the market; a lost item, and anything else that needs
 * someone right now, goes to the group.
 */

type OffTopicDomain = 'falcons' | 'campus' | 'listing' | 'ride' | 'lost-found' | 'live';

export interface Redirect {
  domain: OffTopicDomain;
  title: string;
  message: string;
  link: { url: string; label: string };
}

/** In-app pages are paths, so the web app routes them without a page load. */
export const FALCONS_PATH = '/market/falcons';
export const CAMPUS_PATH = '/market/campus';
export const MARKET_PATH = '/market';
export const RIDES_PATH = '/market/rides';
export const DEFAULT_GROUP_URL = 'https://www.facebook.com/groups/nyuad.room.of.requirement';

function groupUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.ROR_GROUP_URL ?? '').trim() || DEFAULT_GROUP_URL;
}

const FALCON = /\bfalcons?\b/i;
const FALCON_NOT_CURRENCY = /\bfalcons?\s+(?:team|club|society|group|bird|show|hospital|lounge)|\bfalconry|\bfalconer/i;
const CAMPUS = /\bcampus\s*(?:dirhams?|dhs?)\b/i;
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
  if (CAMPUS.test(text) && FALCON_TRADE.test(text.replace(CAMPUS, ''))) {
    return { domain: 'campus', title: 'Trade Campus Dirhams in the market', message: 'Post what you have or want and people contact you directly.', link: { url: CAMPUS_PATH, label: 'Open Campus Dirhams' } };
  }
  if (FALCON.test(text) && !FALCON_NOT_CURRENCY.test(text) && FALCON_TRADE.test(text)) {
    return { domain: 'falcons', title: 'Trade Falcons in the market', message: 'Post what you have or want and people contact you directly.', link: { url: FALCONS_PATH, label: 'Open Falcons' } };
  }
  if (LISTING.some((pattern) => pattern.test(text))) {
    return { domain: 'listing', title: 'Post it in the market', message: 'Things for sale, wanted or free are listed there, with a way to reach you.', link: { url: MARKET_PATH, label: 'Open the market' } };
  }
  if (RIDE.some((pattern) => pattern.test(text))) {
    return { domain: 'ride', title: 'Find a ride in the market', message: 'Rides are listed by day, with seats and a way to reach the driver.', link: { url: RIDES_PATH, label: 'Open rides' } };
  }
  if (LOST_FOUND.some((pattern) => pattern.test(text))) {
    return { domain: 'lost-found', title: 'Post it in the group', message: 'Say what it is and where you last had it: people on campus read the group all day.', link: group };
  }
  if (LIVE.some((pattern) => pattern.test(text)) && LIVE_NEED.test(text)) {
    return { domain: 'live', title: 'Ask the group', message: 'This needs someone who can help right now.', link: group };
  }
  return null;
}
