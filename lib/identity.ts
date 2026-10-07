/**
 * Who is asking. Everyone signs up once (name, NetID, major, year), and the browser that did keeps a random key; the
 * profile stores a hash of that key, so only that browser can act as the NetID. Requests carry both in headers
 * (x-ror-netid, x-ror-key). Routes that cost model calls or reveal contacts require a signed-up member.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { validateKey, validateNetId, type Profile } from './board.ts';
import { boardStore, type BoardStore } from './board-store.ts';
import { ApiError } from './http.ts';

export const NETID_TAKEN = 'This NetID is already set up in another browser. Use the browser you first signed up in.';
export const SIGNUP_REQUIRED = 'Sign up first: add your name, NetID, major and year in the form.';

/**
 * A NetID is bound to the browser that set it up: its key, hashed (the key itself also removes that browser's posts,
 * so it is never stored). Without this, anyone could answer, post or trade under any student's NetID.
 */
export function ownerOf(key: unknown): string {
  return createHash('sha256').update(`ror-owner:${validateKey(key)}`).digest('hex').slice(0, 40);
}

/** The profile behind a NetID, if this browser may act as it; a profile no browser has claimed yet becomes this one's. */
export async function requireProfile(store: BoardStore, netId: unknown, key: unknown): Promise<Profile> {
  const profile = await store.getProfile(validateNetId(netId));
  if (!profile) throw new ApiError(404, 'Add your details first.', 'no_profile');
  if (await store.isBanned(profile.netId)) throw new ApiError(403, 'This NetID can no longer post here.', 'banned');
  const owner = ownerOf(key);
  // Undefined: the database predates the owner column, so there is nothing to check against.
  if (profile.ownerKey === null) await store.claimProfile(profile.netId, owner);
  else if (profile.ownerKey !== undefined && profile.ownerKey !== owner) throw new ApiError(403, NETID_TAKEN, 'netid_taken');
  return profile;
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

/** The NetID and key a request says it comes from, from its headers; empty strings when it does not say. */
export function claimedIdentity(req: IncomingMessage): { netId: string; key: string } {
  return { netId: header(req, 'x-ror-netid').toLowerCase(), key: header(req, 'x-ror-key') };
}

/** NetID + key -> when this instance last confirmed them, so a member costs one database read per ten minutes. */
const confirmed = new Map<string, number>();
const CONFIRMED_MS = 10 * 60_000;

export function forgetMember(netId: string, key: string): void {
  confirmed.delete(`${netId}:${createHash('sha256').update(key).digest('hex').slice(0, 24)}`);
}

/**
 * Refuses a request that does not come from a signed-up member (ROR_REQUIRE_SIGNUP=0 turns this off). Without a
 * working board nothing can be checked, so the request goes through rather than taking the site down with the
 * database; the board's own routes say what is wrong.
 */
export async function requireMember(req: IncomingMessage, store: BoardStore | null = boardStore()): Promise<Profile | null> {
  if (process.env.ROR_REQUIRE_SIGNUP === '0' || !store) return null;
  const { netId, key } = claimedIdentity(req);
  if (!netId || !key) throw new ApiError(401, SIGNUP_REQUIRED, 'signup_required');
  const cacheKey = `${netId}:${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
  if ((confirmed.get(cacheKey) ?? 0) > Date.now()) return null;
  try {
    const profile = await requireProfile(store, netId, key);
    confirmed.set(cacheKey, Date.now() + CONFIRMED_MS);
    if (confirmed.size > 5000) for (const [entry, until] of confirmed) if (until < Date.now()) confirmed.delete(entry);
    return profile;
  } catch (error) {
    if (error instanceof ApiError && (error.code === 'no_profile' || error.code === 'bad_net_id' || error.code === 'bad_key')) throw new ApiError(401, SIGNUP_REQUIRED, 'signup_required');
    if (error instanceof ApiError && error.status < 500) throw error;
    console.warn('[identity] could not check a member, letting the request through:', (error as Error).message);
    return null;
  }
}

/** Test hook. */
export function resetMembers(): void {
  confirmed.clear();
}
