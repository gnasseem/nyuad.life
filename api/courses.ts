import { queryInt, queryString, route, sendJson } from '../lib/http.ts';
import { loadArchive, summarizePost } from '../lib/store.ts';
import { extractCourseCodes } from '../lib/text.ts';

export default route(['GET'], async (req, res) => {
  const archive = await loadArchive();
  const code = queryString(req, 'code').trim();
  if (code) {
    const normalised = extractCourseCodes(code)[0] ?? code.toUpperCase();
    const positions = archive.byCourse.get(normalised) ?? [];
    const page = queryInt(req, 'page', 1, 1, 100);
    const pageSize = queryInt(req, 'pageSize', 20, 1, 50);
    const start = (page - 1) * pageSize;
    sendJson(
      res,
      200,
      {
        code: normalised,
        total: positions.length,
        page,
        pageSize,
        posts: positions.slice(start, start + pageSize).map((index) => summarizePost(archive.posts[index]!)),
      },
      300,
    );
    return;
  }
  const q = queryString(req, 'q').trim().toUpperCase().replace(/\s+/g, ' ');
  const limit = queryInt(req, 'limit', 60, 1, 500);
  const courses = [...archive.byCourse.entries()]
    .map(([course, positions]) => ({
      code: course,
      department: course.split('-')[0]!,
      count: positions.length,
      latest: archive.posts[positions[0]!]?.date ?? '',
    }))
    .filter((entry) => !q || entry.code.includes(q) || entry.department === q)
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, limit);
  sendJson(res, 200, { total: archive.byCourse.size, courses }, 300);
});
