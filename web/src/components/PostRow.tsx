import type { PostSummary } from '../api';
import { formatDate, plural } from '../format';
import { navigate } from '../router';

/** One archive thread in a list; opens the thread page. */
export function PostRow({ post }: { post: PostSummary }) {
  return (
    <button type="button" className="post-row" onClick={() => navigate({ name: 'post', id: post.id })}>
      <span className="meta">
        <b>{post.author || 'Unknown'}</b>
        <span>{formatDate(post.date)}</span>
        {post.courses.slice(0, 3).map((code) => (
          <span key={code} className="tag mono">
            {code}
          </span>
        ))}
      </span>
      <span className="body">{post.preview}</span>
      <span className="meta">{plural(post.commentCount, 'comment')}</span>
    </button>
  );
}
