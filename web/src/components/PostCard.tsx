import type { PostSummary } from '../api';
import { compact, formatDate, topicLabel } from '../format';
import { IconComment } from '../icons';
import { highlight } from '../markdown';
import { navigate } from '../router';

interface Props {
  post: PostSummary;
  terms?: string[];
  showSnippet?: boolean;
}

export function PostCard({ post, terms = [], showSnippet = true }: Props) {
  const body = showSnippet && post.snippet ? post.snippet : post.preview;
  const topics = post.topics.filter((topic) => topic !== 'general').slice(0, 2);
  return (
    <button type="button" className="post-card" onClick={() => navigate({ name: 'post', id: post.id })}>
      <div className="who">
        <b>{post.author || 'Unknown'}</b>
        <span>{formatDate(post.date)}</span>
        {topics.map((topic) => (
          <span key={topic} className="tag">
            {topicLabel(topic)}
          </span>
        ))}
      </div>
      <div className="body">{terms.length ? highlight(body, terms) : body}</div>
      <div className="foot">
        <span>
          <IconComment />
          {compact(post.commentCount)}
        </span>
        {post.courses.slice(0, 3).map((code) => (
          <span key={code} className="tag course">
            {code}
          </span>
        ))}
      </div>
    </button>
  );
}
