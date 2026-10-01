import type { PostSummary } from '../api';
import { formatDate, plural } from '../format';
import { IconChat } from '../icons';
import { highlight } from '../markdown';
import { navigate } from '../router';

/** One archive thread in a list; opens the thread page. With search terms, shows the matching passage with them marked. */
export function PostRow({ post, terms }: { post: PostSummary; terms?: string[] }) {
  // One running line of text, so the two-line clamp never ends on a blank line and shows a lone "…".
  const passage = (terms && post.snippet ? post.snippet : post.preview).replace(/\s*\n\s*/g, ' ');
  return (
    <button type="button" className="post-row" onClick={() => navigate({ name: 'post', id: post.id })}>
      <span className="meta">
        <b>{post.author || 'Unknown'}</b>
        <span>{formatDate(post.date)}</span>
        {post.courses.slice(0, 3).map((code) => (
          <span key={code} className="code">
            {code}
          </span>
        ))}
      </span>
      <span className="body">{terms ? highlight(passage, terms) : passage}</span>
      {post.commentCount > 0 && (
        <span className="pr-foot">
          <IconChat /> {plural(post.commentCount, 'comment')}
        </span>
      )}
    </button>
  );
}
