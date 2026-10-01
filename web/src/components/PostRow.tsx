import type { PostSummary } from '../api';
import { formatDate, plural } from '../format';
import { highlight } from '../markdown';
import { navigate } from '../router';

/** One archive thread in a list; opens the thread page. With search terms, shows the matching passage with them marked. */
export function PostRow({ post, terms }: { post: PostSummary; terms?: string[] }) {
  const passage = terms && post.snippet ? post.snippet : post.preview;
  return (
    <button type="button" className="post-row" onClick={() => navigate({ name: 'post', id: post.id })}>
      <span className="meta">
        <b>{post.author || 'Unknown'}</b>
        <span>{formatDate(post.date)}</span>
        {post.courses.slice(0, 3).map((code) => (
          <span key={code} className="tag course">
            {code}
          </span>
        ))}
      </span>
      <span className="body">{terms ? highlight(passage, terms) : passage}</span>
      <span className="meta">{post.commentCount ? plural(post.commentCount, 'comment') : 'No comments'}</span>
    </button>
  );
}
