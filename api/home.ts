import { route, sendJson } from '../lib/http.ts';
import { loadArchive, summarizePost } from '../lib/store.ts';
import { starterQuestions } from '../lib/suggestions.ts';
import { dayNumber } from '../lib/text.ts';
import { TOPIC_LABELS } from '../lib/topics.ts';

export default route(['GET'], async (_req, res) => {
  const archive = await loadArchive();
  const today = Date.now() / 86_400_000;
  const recent = archive.posts.filter((post) => {
    const age = today - dayNumber(post.date);
    return !Number.isNaN(age) && age <= 120;
  });
  const engagement = (post: (typeof archive.posts)[number]) => Math.max(post.commentCount ?? 0, post.comments.length) + (post.reactions ?? 0) / 3;
  const trending = [...(recent.length >= 8 ? recent : archive.posts.slice(0, 200))]
    .sort((a, b) => engagement(b) - engagement(a))
    .slice(0, 8)
    .map((post) => summarizePost(post));
  const topics = [...archive.byTopic.entries()]
    .filter(([id]) => id !== 'general')
    .map(([id, positions]) => ({ id, label: TOPIC_LABELS[id] ?? id, count: positions.length }))
    .sort((a, b) => b.count - a.count);
  const courses = [...archive.byCourse.entries()]
    .map(([code, positions]) => ({ code, count: positions.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
  sendJson(
    res,
    200,
    {
      stats: {
        posts: archive.posts.length,
        comments: archive.meta.comments,
        chunks: archive.chunks.length,
        newestPost: archive.meta.newestPost,
        oldestPost: archive.meta.oldestPost,
        builtAt: archive.meta.builtAt,
        semantic: archive.vectors.count > 0,
      },
      suggestions: starterQuestions(),
      trending,
      latest: archive.posts.slice(0, 8).map((post) => summarizePost(post)),
      topics,
      courses,
    },
    300,
  );
});
