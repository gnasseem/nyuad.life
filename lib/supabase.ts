/** Where the board's database is, from SUPABASE_URL and the service key. No imports, so any module can use it. */
export interface SupabaseConfig {
  url: string;
  serviceKey: string;
}

export function supabaseConfig(env: NodeJS.ProcessEnv = process.env): SupabaseConfig | null {
  const url = normalizeSupabaseUrl(env.SUPABASE_URL ?? '');
  const serviceKey = (env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_KEY ?? '').trim().replace(/^["']|["']$/g, '');
  return url && serviceKey ? { url, serviceKey } : null;
}

/**
 * Turns whatever was pasted into SUPABASE_URL into the REST origin: the project URL as given, the dashboard URL of
 * the project, a URL with /rest/v1 already on the end, or a bare project ref all become https://<ref>.supabase.co.
 */
export function normalizeSupabaseUrl(raw: string): string {
  let value = raw.trim().replace(/^["']|["']$/g, '');
  if (!value) return '';
  const dashboard = /supabase\.com\/dashboard\/project\/([a-z0-9]{20})/i.exec(value);
  if (dashboard) return `https://${dashboard[1]!.toLowerCase()}.supabase.co`;
  if (/^[a-z0-9]{20}$/i.test(value)) return `https://${value.toLowerCase()}.supabase.co`;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  return value.replace(/\/+$/, '').replace(/\/rest\/v1$/i, '').replace(/\/+$/, '');
}
