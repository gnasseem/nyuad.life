/** `npm run dev`: the API on http://localhost:8787 (and the built web app from dist/ when present). */
import { loadDotEnv } from '../lib/env.ts';
import { createApiServer } from '../lib/devserver.ts';

loadDotEnv();
const port = Number(process.env.PORT) || 8787;
createApiServer().listen(port, () => {
  console.log(`API on http://localhost:${port} (GEMINI_API_KEY ${process.env.GEMINI_API_KEY ? 'set' : 'missing'}; board: ${process.env.SUPABASE_URL ? 'Supabase' : 'in memory'})`);
});
