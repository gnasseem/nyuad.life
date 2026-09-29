import { useEffect, useMemo, useState } from 'react';
import { api, type PostSummary } from '../api';
import { PostCard } from '../components/PostCard';
import { useApp } from '../context';
import { formatDate } from '../format';
import { IconAsk, IconBack, IconSearch } from '../icons';
import { navigate } from '../router';

interface Props {
  code?: string;
  onNeedAccess(): void;
}

interface CourseEntry {
  code: string;
  department: string;
  count: number;
  latest: string;
}

export function CoursesPage({ code, onNeedAccess }: Props) {
  return code ? <CourseDetail code={code} onNeedAccess={onNeedAccess} /> : <CourseIndex onNeedAccess={onNeedAccess} />;
}

function CourseIndex({ onNeedAccess }: { onNeedAccess(): void }) {
  const [courses, setCourses] = useState<CourseEntry[]>([]);
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .courses()
      .then((result) => setCourses(result.courses))
      .catch((err) => {
        if (err?.status === 401) onNeedAccess();
        setError(err instanceof Error ? err.message : 'Could not load courses.');
      });
  }, [onNeedAccess]);

  const departments = useMemo(() => {
    const counts = new Map<string, number>();
    for (const course of courses) counts.set(course.department, (counts.get(course.department) ?? 0) + course.count);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }, [courses]);

  const shown = courses.filter((course) => (!dept || course.department === dept) && (!q || course.code.toLowerCase().includes(q.toLowerCase())));

  return (
    <div className="page wide">
      <div className="page-head">
        <h1 className="display">Courses</h1>
        <p>Every course code students have mentioned, with how many threads talk about it. Pick one to read the threads or ask about it.</p>
      </div>
      <label className="searchbar" style={{ maxWidth: 480 }}>
        <IconSearch />
        <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Filter by code, e.g. CS-UH or 1001" />
      </label>
      <div className="dept-row">
        <button type="button" className={`chip${dept ? '' : ' on'}`} onClick={() => setDept('')}>
          All
        </button>
        {departments.slice(0, 24).map((id) => (
          <button key={id} type="button" className={`chip${dept === id ? ' on' : ''}`} onClick={() => setDept(dept === id ? '' : id)}>
            {id}
          </button>
        ))}
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="course-grid">
        {shown.map((course) => (
          <button key={course.code} type="button" className="course-tile" onClick={() => navigate({ name: 'courses', code: course.code })}>
            <span className="code">{course.code}</span>
            <span className="count">
              {course.count} {course.count === 1 ? 'thread' : 'threads'} · {formatDate(course.latest)}
            </span>
          </button>
        ))}
      </div>
      {courses.length > 0 && shown.length === 0 && <div className="empty">No course matches that filter.</div>}
    </div>
  );
}

function CourseDetail({ code, onNeedAccess }: { code: string; onNeedAccess(): void }) {
  const { setAskPrefill } = useApp();
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .course(code)
      .then((result) => {
        setPosts(result.posts);
        setTotal(result.total);
      })
      .catch((err) => {
        if (err?.status === 401) onNeedAccess();
        setError(err instanceof Error ? err.message : 'Could not load this course.');
      })
      .finally(() => setLoading(false));
  }, [code, onNeedAccess]);

  const ask = () => {
    setAskPrefill({ question: `What do students say about ${code}? Cover the workload, grading, professors and whether it is worth taking.`, autoSend: true });
    navigate({ name: 'ask' });
  };

  return (
    <div className="page">
      <button type="button" className="btn ghost sm" onClick={() => navigate({ name: 'courses' })} style={{ marginBottom: 14 }}>
        <IconBack /> All courses
      </button>
      <div className="page-head">
        <h1 className="display mono" style={{ fontFamily: 'var(--font-display)' }}>
          {code}
        </h1>
        <p>
          {loading ? 'Loading…' : `${total} ${total === 1 ? 'thread mentions' : 'threads mention'} this course.`}
        </p>
        <div className="row" style={{ marginTop: 14 }}>
          <button type="button" className="btn primary" onClick={ask}>
            <IconAsk /> Ask what students think
          </button>
        </div>
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="post-list">
        {posts.map((post) => (
          <PostCard key={post.id} post={post} showSnippet={false} />
        ))}
      </div>
    </div>
  );
}
