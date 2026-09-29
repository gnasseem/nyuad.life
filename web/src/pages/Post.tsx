import { useEffect, useState } from 'react';
import { api, type PostDetail, type PostSummary } from '../api';
import { PostCard } from '../components/PostCard';
import { useApp } from '../context';
import { compact, formatDate, topicLabel } from '../format';
import { IconAsk, IconBack, IconExternal } from '../icons';
import { navigate } from '../router';

interface Props {
  id: string;
  onNeedAccess(): void;
}

export function PostPage({ id, onNeedAccess }: Props) {
  const { setAskPrefill } = useApp();
  const [post, setPost] = useState<PostDetail | null>(null);
  const [related, setRelated] = useState<PostSummary[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setPost(null);
    setError('');
    api
      .post(id)
      .then((result) => {
        if (cancelled) return;
        setPost(result.post);
        setRelated(result.related);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err?.status === 401) onNeedAccess();
        setError(err instanceof Error ? err.message : 'Could not load this post.');
      });
    return () => {
      cancelled = true;
    };
  }, [id, onNeedAccess]);

  const askAbout = () => {
    if (!post) return;
    const lead = post.text.split(/(?<=[.?!])\s/)[0]?.slice(0, 140) ?? '';
    setAskPrefill({ question: `What did students say about this: "${lead}"`, autoSend: false });
    navigate({ name: 'ask' });
  };

  return (
    <div className="page">
      <button type="button" className="btn ghost sm" onClick={() => window.history.length > 1 ? window.history.back() : navigate({ name: 'browse' })} style={{ marginBottom: 14 }}>
        <IconBack /> Back
      </button>
      {error && <div className="alert">{error}</div>}
      {!post && !error && (
        <div className="card pad" style={{ display: 'grid', gap: 10 }}>
          <div className="skeleton" style={{ width: '40%' }} />
          <div className="skeleton" style={{ height: 60 }} />
          <div className="skeleton" style={{ height: 40 }} />
        </div>
      )}
      {post && (
        <>
          <article className="card pad">
            <div className="meta" style={{ marginBottom: 10 }}>
              <b>{post.author || 'Unknown'}</b>
              <span>{formatDate(post.date)}</span>
              <span>{compact(post.commentCount)} {post.commentCount === 1 ? 'comment' : 'comments'}</span>
              {post.reactions > 0 && <span>{compact(post.reactions)} {post.reactions === 1 ? 'reaction' : 'reactions'}</span>}
            </div>
            <div className="post-full">{post.text}</div>
            <div className="chips" style={{ marginTop: 14 }}>
              {post.courses.map((code) => (
                <button key={code} type="button" className="chip tiny" onClick={() => navigate({ name: 'courses', code })}>
                  {code}
                </button>
              ))}
              {post.topics.filter((topic) => topic !== 'general').map((topic) => (
                <button key={topic} type="button" className="chip tiny" onClick={() => navigate({ name: 'browse' }, { search: `topic=${topic}` })}>
                  {topicLabel(topic)}
                </button>
              ))}
            </div>
            <div className="row" style={{ marginTop: 16, flexWrap: 'wrap' }}>
              <button type="button" className="btn primary sm" onClick={askAbout}>
                <IconAsk /> Ask about this
              </button>
              {post.url && (
                <a className="btn sm" href={post.url} target="_blank" rel="noreferrer">
                  <IconExternal /> Open on Facebook
                </a>
              )}
            </div>
          </article>

          <h3 className="section-title">
            {post.comments.length} {post.comments.length === 1 ? 'comment' : 'comments'}
            {post.commentCount > post.comments.length ? ` (${post.commentCount - post.comments.length} not captured yet)` : ''}
          </h3>
          {post.comments.length === 0 ? (
            <p className="muted">No comments were saved for this post.</p>
          ) : (
            <div className="comments">
              {post.comments.map((comment, index) => (
                <div key={index} className="comment">
                  <div className="who">
                    <b>{comment.author || 'Someone'}</b>
                    <span className="faint">{formatDate(comment.date)}</span>
                  </div>
                  <div className="what">{comment.text}</div>
                </div>
              ))}
            </div>
          )}

          {related.length > 0 && (
            <>
              <h3 className="section-title">Related threads</h3>
              <div className="post-list">
                {related.map((entry) => (
                  <PostCard key={entry.id} post={entry} showSnippet={false} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
