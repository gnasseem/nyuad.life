import { ApiError, queryString, rateLimit, route, sendJson } from '../lib/http.ts';
import { requireMember } from '../lib/identity.ts';
import { loadArchive, postById, summarizePost } from '../lib/store.ts';
import { dotRows } from '../lib/vectors.ts';

export default route(['GET'], async (req, res) => {
  // Related posts cost a scan of every vector, so this is limited like search.
  rateLimit(req, 60, 40, 'post');
  await requireMember(req);
  const id = queryString(req, 'id').trim();
  if (!id) throw new ApiError(400, 'Missing id.', 'missing_id');
  const archive = await loadArchive();
  const post = postById(archive, id);
  if (!post) throw new ApiError(404, 'No post with that id in the archive.', 'not_found');
  const position = archive.postPosition.get(id)!;

  let related: number[] = [];
  const row = archive.postChunk[position]!;
  if (archive.vectors.count > 0 && row >= 0) {
    const scores: Array<{ position: number; score: number }> = [];
    const seen = new Set<number>([position]);
    for (let other = 0; other < archive.chunks.length; other++) {
      const otherPost = archive.chunkPost[other]!;
      if (seen.has(otherPost)) continue;
      const score = dotRows(archive.vectors, row, other);
      if (score > 0.35) {
        seen.add(otherPost);
        scores.push({ position: otherPost, score });
      }
    }
    related = scores
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((entry) => entry.position);
  } else {
    const keys = [...post.courses.map((code) => archive.byCourse.get(code) ?? []), ...post.topics.map((topic) => archive.byTopic.get(topic) ?? [])];
    const seen = new Set<number>([position]);
    for (const list of keys) {
      for (const candidate of list) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        related.push(candidate);
        if (related.length >= 6) break;
      }
      if (related.length >= 6) break;
    }
  }

  sendJson(
    res,
    200,
    {
      post: { ...summarizePost(post), comments: post.comments },
      related: related.map((index) => summarizePost(archive.posts[index]!)),
    },
    300,
    'private',
  );
});
