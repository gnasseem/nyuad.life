import { useEffect, useState } from 'react';
import { api, type PostDetail, type PostSummary } from '../api';
import { PostCard } from '../components/PostCard';
import { useApp } from '../context';
import { formatDate, plural, topicLabel } from '../format';
import { IconAsk, IconBack, IconExternal } from '../icons';
import { navigate } from '../router';

interface Props {
  id: string;
}

export function PostPage({ id }: Props) {
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
        setError(err instanceof Error ? err.message : 'Could not load this thread.');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const askAbout = () => {
    if (!post) return;
    const lead = post.text.split(/(?<=[.?!])\s/)[0]?.slice(0, 140) ?? '';
    setAskPrefill({ question: `What did students say about this: "${lead}"`, autoSend: false });
    navigate({ name: 'ask' });
  };

  return (
    <div className="page">
      <button type="button" className="btn ghost sm back" onClick={() => (window.history.length > 1 ? window.history.back() : navigate({ name: 'guide' }))}>
        <IconBack /> Back
      </button>
      {error && <div className="alert">{error}</div>}
      {!post && !error && (
        <div className="card" style={{ display: 'grid', gap: 10 }} aria-busy="true">
          <div className="skeleton" style={{ width: '40%' }} />
          <div className="skeleton" style={{ height: 60 }} />
          <div className="skeleton" style={{ height: 40 }} />
        </div>
      )}
      {post && (
        <>
          <article className="card">
            <div className="meta" style={{ marginBottom: 12 }}>
              <b>{post.author || 'Unknown'}</b>
              <span>{formatDate(post.date)}</span>
              {post.reactions > 0 && <span>{plural(post.reactions, 'reaction')}</span>}
            </div>
            <div className="post-full">{post.text}</div>
            {(post.courses.length > 0 || post.topics.some((topic) => topic !== 'general')) && (
              <div className="chips" style={{ marginTop: 16 }}>
                {post.courses.map((code) => (
                  <button key={code} type="button" className="chip mono" onClick={() => navigate({ name: 'guide', section: 'courses', id: code })}>
                    {code}
                  </button>
                ))}
                {post.topics
                  .filter((topic) => topic !== 'general')
                  .map((topic) => (
                    <span key={topic} className="chip">
                      {topicLabel(topic)}
                    </span>
                  ))}
              </div>
            )}
            <div className="row wrap" style={{ marginTop: 18 }}>
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

          <h2 className="section-title">{plural(post.comments.length, 'comment')}</h2>
          {post.comments.length === 0 ? (
            <p className="muted">No comments worth reading were saved for this thread.</p>
          ) : (
            <div className="comments">
              {post.comments.map((comment, index) => (
                <div key={index} className="comment">
                  <div className="who">
                    <b>{comment.author || 'Someone'}</b>
                    <span>{formatDate(comment.date)}</span>
                  </div>
                  <div className="what">{comment.text}</div>
                </div>
              ))}
            </div>
          )}

          {related.length > 0 && (
            <>
              <h2 className="section-title">Related threads</h2>
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
