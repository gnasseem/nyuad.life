import { ApiError, queryInt, queryString, route, sendJson } from '../lib/http.ts';
import { retrieve } from '../lib/rag.ts';
import { loadArchive, summarizePost } from '../lib/store.ts';
import { bestWindow, dayNumber, tokenize } from '../lib/text.ts';
import type { IndexedPost } from '../lib/types.ts';

type Sort = 'relevance' | 'newest' | 'oldest' | 'discussed';

export default route(['GET'], async (req, res) => {
  const archive = await loadArchive();
  const q = queryString(req, 'q').trim().slice(0, 300);
  const topic = queryString(req, 'topic').trim();
  const course = queryString(req, 'course').trim().toUpperCase();
  const author = queryString(req, 'author').trim().toLowerCase();
  const from = queryString(req, 'from').trim();
  const to = queryString(req, 'to').trim();
  const page = queryInt(req, 'page', 1, 1, 200);
  const pageSize = queryInt(req, 'pageSize', 20, 1, 50);
  const semantic = queryString(req, 'semantic') !== '0';
  const requested = queryString(req, 'sort') as Sort;
  const sort: Sort = ['relevance', 'newest', 'oldest', 'discussed'].includes(requested) ? requested : q ? 'relevance' : 'newest';

  const fromDay = from ? dayNumber(from.length === 7 ? `${from}-01` : from) : Number.NaN;
  const toDay = to ? dayNumber(to.length === 7 ? `${to}-31` : to) : Number.NaN;
  const filter = (post: IndexedPost): boolean => {
    if (topic && !post.topics.includes(topic)) return false;
    if (course && !post.courses.includes(course)) return false;
    if (author && !post.author.toLowerCase().includes(author)) return false;
    if (!Number.isNaN(fromDay) || !Number.isNaN(toDay)) {
      const day = dayNumber(post.date);
      if (Number.isNaN(day)) return false;
      if (!Number.isNaN(fromDay) && day < fromDay) return false;
      if (!Number.isNaN(toDay) && day > toDay) return false;
    }
    return true;
  };

  const engagement = (post: IndexedPost) => Math.max(post.commentCount ?? 0, post.comments.length) + (post.reactions ?? 0) / 3;
  let results: Array<{ post: IndexedPost; snippet: string; score: number }>;
  let dense = false;
  if (q) {
    if (q.length < 2) throw new ApiError(400, 'Search needs at least two characters.', 'query_too_short');
    const retrieval = await retrieve(archive, q, { k: 400, filter, useDense: semantic });
    dense = retrieval.dense;
    results = retrieval.hits.map((hit) => {
      const post = archive.posts[hit.post]!;
      const passage = archive.chunks[hit.chunk]!.text.split('\n').slice(1).join(' ');
      return { post, snippet: bestWindow(passage, retrieval.terms, 260), score: hit.score };
    });
    if (sort !== 'relevance') sortPosts(results, sort, engagement);
  } else {
    results = archive.posts.filter(filter).map((post) => ({ post, snippet: '', score: 0 }));
    sortPosts(results, sort === 'relevance' ? 'newest' : sort, engagement);
  }

  const total = results.length;
  const start = (page - 1) * pageSize;
  const terms = q ? tokenize(q) : [];
  sendJson(
    res,
    200,
    {
      total,
      page,
      pageSize,
      sort,
      dense,
      terms,
      results: results.slice(start, start + pageSize).map((entry) => ({ ...summarizePost(entry.post, entry.snippet), score: Number(entry.score.toFixed(4)) })),
    },
    q ? 0 : 120,
  );
});

function sortPosts(results: Array<{ post: IndexedPost }>, sort: Sort, engagement: (post: IndexedPost) => number): void {
  const day = (post: IndexedPost) => {
    const value = dayNumber(post.date);
    return Number.isNaN(value) ? -1 : value;
  };
  if (sort === 'newest') results.sort((a, b) => day(b.post) - day(a.post));
  else if (sort === 'oldest') results.sort((a, b) => (day(a.post) < 0 ? 1 : day(b.post) < 0 ? -1 : day(a.post) - day(b.post)));
  else if (sort === 'discussed') results.sort((a, b) => engagement(b.post) - engagement(a.post));
}
