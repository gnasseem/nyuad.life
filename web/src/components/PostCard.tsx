import type { PostSummary } from '../api';
import { compact, formatDate, topicLabel } from '../format';
import { IconComment, IconHeart } from '../icons';
import { highlight } from '../markdown';
import { navigate } from '../router';

interface Props {
  post: PostSummary;
  terms?: string[];
  showSnippet?: boolean;
}

export function PostCard({ post, terms = [], showSnippet = true }: Props) {
  const body = showSnippet && post.snippet ? post.snippet : post.preview;
  return (
    <button type="button" className="post-card" onClick={() => navigate({ name: 'post', id: post.id })}>
      <div className="meta">
        <b>{post.author || 'Unknown'}</b>
        <span>{formatDate(post.date)}</span>
        {post.topics.filter((topic) => topic !== 'general').slice(0, 2).map((topic) => (
          <span key={topic} className="tag">{topicLabel(topic)}</span>
        ))}
      </div>
      <div className="body">{terms.length ? highlight(body, terms) : body}</div>
      <div className="foot meta">
        <span className="row" style={{ gap: 4 }}><IconComment width={14} height={14} /> {compact(post.commentCount)}</span>
        {post.reactions > 0 && <span className="row" style={{ gap: 4 }}><IconHeart width={14} height={14} /> {compact(post.reactions)}</span>}
        {post.courses.slice(0, 3).map((code) => (
          <span key={code} className="tag course">{code}</span>
        ))}
      </div>
    </button>
  );
}
