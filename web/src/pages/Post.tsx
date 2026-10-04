import { useEffect, useState } from 'react';
import { api, type PostDetail, type PostSummary } from '../api';
import { PostRow } from '../components/PostRow';
import { useApp } from '../context';
import { formatDate, initials, topicLabel } from '../format';
import { IconBack, IconExternal } from '../icons';
import { navigate } from '../router';

interface Props {
  id: string;
}

/** One thread from the group: the post, its comments as stops down a line, and what to do next beside it. */
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
    setAskPrefill({ question: `What did students say about "${lead}"?`, autoSend: false });
    navigate({ name: 'ask' });
  };

  const topics = post?.topics.filter((topic) => topic !== 'general') ?? [];

  return (
    <div className="page">
      <button type="button" className="btn ghost sm back" onClick={() => (window.history.length > 1 ? window.history.back() : navigate({ name: 'threads' }))}>
        <IconBack /> Back
      </button>
      {error && <div className="alert error">{error}</div>}
      {!post && !error && (
        <div className="stack" aria-busy="true" style={{ maxWidth: 720 }}>
          <div className="skeleton" style={{ width: '40%' }} />
          <div className="skeleton" style={{ height: 80 }} />
          <div className="skeleton" style={{ height: 40 }} />
        </div>
      )}
      {post && (
        <div className="split">
          <div>
            <article>
              <div className="post-head">
                <span className="avatar">{initials(post.author || 'Unknown') || '?'}</span>
                <div>
                  <b>{post.author || 'Unknown'}</b>
                  <span>{formatDate(post.date)}</span>
                </div>
              </div>
              <div className="post-full">{post.text}</div>
            </article>

            <h2 className="section-title">Comments</h2>
            {post.comments.length === 0 ? (
              <p className="muted">No comments.</p>
            ) : (
              <div className="comments">
                <div className="stations">
                  {post.comments.map((comment, index) => (
                    <div key={index} className="comment">
                      <span className="who">
                        <b>{comment.author || 'Unknown'}</b>
                        <span>{formatDate(comment.date)}</span>
                      </span>
                      <div className="what">{comment.text}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <aside className="rail">
            <div className="rail-block">
              <div className="stack" style={{ gap: 8 }}>
                <button type="button" className="btn primary" onClick={askAbout}>
                  Ask about this
                </button>
                {post.url && (
                  <a className="btn" href={post.url} target="_blank" rel="noreferrer">
                    <IconExternal /> Facebook
                  </a>
                )}
              </div>
            </div>
            {(post.courses.length > 0 || topics.length > 0) && (
              <div className="rail-block">
                <h2>Tags</h2>
                <div className="chips">
                  {post.courses.map((code) => (
                    <button key={code} type="button" className="chip mono" onClick={() => navigate({ name: 'courses', code })}>
                      {code}
                    </button>
                  ))}
                  {topics.map((topic) => (
                    <button key={topic} type="button" className="chip" onClick={() => navigate({ name: 'threads' }, { search: `topic=${encodeURIComponent(topic)}` })}>
                      {topicLabel(topic)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {related.length > 0 && (
              <div className="rail-block">
                <h2>Related threads</h2>
                <div className="list">
                  {related.slice(0, 5).map((entry) => (
                    <PostRow key={entry.id} post={entry} />
                  ))}
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
