/** Verified NYU identities and shared account ownership for API requests. */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { validateKey, validateNetId, type Profile } from './board.ts';
import { boardStore, type BoardStore } from './board-store.ts';
import { emailSession, requireEmailSession } from './auth.ts';
import { ApiError } from './http.ts';

export const NETID_TAKEN = 'Log in with your NYU email to access this account on any device.';
export const SIGNUP_REQUIRED = 'Log in with your NYU email to continue.';

/** Hashed account key retained for compatibility with existing post ownership. */
export function ownerOf(key: unknown): string {
  return createHash('sha256').update(`ror-owner:${validateKey(key)}`).digest('hex').slice(0, 40);
}

/** Checks verified account ownership and the posting ban. */
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

/** The NetID and key a request says it comes from, from the verified session; empty strings when logged out. */
export function claimedIdentity(req: IncomingMessage): { netId: string; key: string } {
  const session = emailSession(req);
  return session ?? { netId: '', key: '' };
}

/**
 * Requires a verified member unless read access is explicitly public. Database failures fail closed.
 */
export async function requireMember(req: IncomingMessage, store: BoardStore | null = boardStore()): Promise<Profile | null> {
  if (process.env.ROR_REQUIRE_SIGNUP === '0') return null;
  if (!store) throw new ApiError(503, 'Account verification is unavailable. Try again shortly.', 'identity_unavailable');
  const { netId, key } = requireEmailSession(req);
  if (!netId || !key) throw new ApiError(401, SIGNUP_REQUIRED, 'signup_required');
  try {
    return await requireProfile(store, netId, key);
  } catch (error) {
    if (error instanceof ApiError && (error.code === 'no_profile' || error.code === 'bad_net_id' || error.code === 'bad_key')) throw new ApiError(401, SIGNUP_REQUIRED, 'signup_required');
    if (error instanceof ApiError && error.status < 500) throw error;
    throw new ApiError(503, 'Could not verify your account. Try again shortly.', 'identity_unavailable');
  }
}
