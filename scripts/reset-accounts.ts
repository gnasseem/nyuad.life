import assert from 'node:assert/strict';
import { accountKey } from '../lib/auth.ts';
import { ownerOf } from '../lib/identity.ts';

assert.equal(process.env.VERCEL_ENV, 'production');
assert.equal(process.env.SUPABASE_URL, 'https://fgtxvrojnunpslkmfnmy.supabase.co');
const cutoff = new Date().toISOString();
const headers = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!, authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
assert(headers.apikey && headers.apikey !== '[SENSITIVE]');
async function db(path: string, method = 'GET'): Promise<any> {
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { method, headers, signal: AbortSignal.timeout(20_000) });
  assert(response.ok, `${method} ${path.split('?')[0]} failed: ${response.status}`);
  return method === 'GET' ? response.json() : null;
}
const profiles: { net_id: string; owner_key: string | null }[] = [];
for (let offset = 0; ; offset += 1000) {
  const page = await db(`board_profiles?select=net_id,owner_key&created_at=lte.${cutoff}&order=net_id&limit=1000&offset=${offset}`);
  profiles.push(...page);
  if (page.length < 1000) break;
}
const keys: string[] = [];
const owners = new Set(profiles.map(profile => profile.owner_key).filter(Boolean));
for (let offset = 0; ; offset += 1000) {
  const page: { asker_key: string }[] = await db(`board_questions?select=asker_key&order=id&limit=1000&offset=${offset}`);
  keys.push(...page.filter(question => owners.has(ownerOf(question.asker_key))).map(question => question.asker_key));
  if (page.length < 1000) break;
}
for (const key of new Set([...keys, ...profiles.map(profile => accountKey(profile.net_id))])) {
  await db(`board_questions?asker_key=eq.${encodeURIComponent(key)}`, 'DELETE');
}
for (const profile of profiles) {
  for (const [table, field] of [['board_answers', 'helper_net_id'], ['board_events', 'net_id'], ['board_announcements', 'poster_net_id'], ['board_offers', 'poster_net_id'], ['board_listings', 'poster_net_id'], ['board_bans', 'net_id'], ['board_profiles', 'net_id']]) {
    await db(`${table}?${field}=eq.${profile.net_id}`, 'DELETE');
  }
}
await db(`auth_email_codes?sent_at=lte.${cutoff}`, 'DELETE');
const remaining = await db(`board_profiles?select=net_id&created_at=lte.${cutoff}&limit=1`);
assert.equal(remaining.length, 0);
assert.equal((await db(`auth_email_codes?select=net_id&sent_at=lte.${cutoff}&limit=1`)).length, 0);
console.log(`[account-reset] Deleted ${profiles.length} accounts and their posts; remaining existing accounts and codes: 0.`);

const response = await fetch('https://api.resend.com/domains', { headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}` }, signal: AbortSignal.timeout(12_000) });
if (response.ok) {
  const domains = await response.json() as { data: { id: string; name: string; status: string }[] };
  const domain = domains.data.find(domain => domain.name === 'nyuad.life');
  if (domain) {
    const details = await fetch(`https://api.resend.com/domains/${domain.id}`, { headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
    const data = await details.json() as { records?: unknown };
    console.log('[email-domain]', JSON.stringify({ ...domain, records: data.records }));
  } else console.log('[email-domain] nyuad.life is not registered in Resend.');
} else console.log(`[email-domain] Domain management access unavailable: HTTP ${response.status}.`);
