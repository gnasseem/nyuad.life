import { route, sendJson } from '../lib/http.ts';
import { starterQuestions } from '../lib/suggestions.ts';

export default route(['GET'], async (_req, res) => {
  sendJson(res, 200, { suggestions: starterQuestions() }, 300);
});
