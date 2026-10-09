/** The official-page pipeline against a fake university site: extraction, the crawler script, the index, retrieval. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { breadcrumbsOf, coursesOf, linksOf, mainHtml, sectionsOf, textOf, titleOf } from './html.ts';
import { buildOfficialIndex, classifySection, loadOfficial, officialCards, readOfficialJsonl, resetOfficial, retrieveOfficial } from './official.ts';

const PAGE = (title: string, body: string, links: string[] = []) => `<!doctype html><html><head><title>${title} | NYU Abu Dhabi</title><script>var x=1</script></head><body>
<header><nav><ul><li><a href="/en/academics.html">Academics</a></li><li><a href="/en/news/today.html">News</a></li></ul></nav></header>
<div class="breadcrumb"><a href="/">Home</a> <span>›</span> <a href="/en/academics.html">Academics</a> <span>›</span> <span>${title}</span></div>
<main><h1>${title}</h1>${body}<p>${links.map((href) => `<a href="${href}">${href}</a>`).join(' ')}</p></main>
<footer><p>© NYU Abu Dhabi · <a href="/en/privacy.html">Privacy</a></p></footer></body></html>`;

it('keeps pool and gym hours in separate passages with their parent heading', () => {
  const sections = sectionsOf(PAGE('Sports', '<h2>Indoor facilities</h2><h3>Gym</h3><p>Cardio equipment and weights for campus workouts.</p><h4>Hours</h4><p>Monday-Friday 8am-10pm</p><h3>Indoor Pool</h3><p>A fifty-meter swimming pool with eight lanes.</p><h4>Hours</h4><p>Monday-Friday 8am-2pm and 3-9pm</p>'));
  const pool = sections.find((section) => section.title.includes('Indoor Pool'))!;
  expect(pool.title).toBe('Indoor facilities · Indoor Pool');
  expect(pool.text).toContain('8am-2pm and 3-9pm');
  expect(pool.text).not.toContain('8am-10pm');
});

const SITE: Record<string, string> = {
  '/en/academics.html': PAGE('Academics', '<p>NYU Abu Dhabi offers 27 majors across arts, humanities, science, social science and engineering. Students complete the Core Curriculum, a major and a capstone project. Advising begins in the first semester and continues every year.</p>', ['/en/academics/undergraduate/majors-and-minors.html', '/en/academics/global-education/study-away.html', 'https://bulletins.example.test/undergraduate/abu-dhabi/courses/']),
  '/en/academics/undergraduate/majors-and-minors.html': PAGE('Majors and Minors', '<p>The Computer Science major requires ten courses including Introduction to Computer Science, Data Structures, Algorithms and a two-semester capstone. Students declare a major by the end of the sophomore year. A minor takes four courses.</p><ul><li>Computer Science</li><li>Economics</li><li>Physics</li></ul>', ['/en/academics/undergraduate/majors-and-minors.html', '/en/academics.html']),
  '/en/academics/global-education/study-away.html': PAGE('Study Away', '<p>Students may study away for up to two semesters and two January terms at any NYU global site, including New York, Shanghai, London and Paris. Applications open in October for spring and in February for fall; a GPA of 3.0 is required. Housing at the site is arranged by the global programs office.</p>'),
  '/en/news/today.html': PAGE('News today', '<p>' + 'Press release text. '.repeat(30) + '</p>'),
};

const BULLETIN = `<!doctype html><html><head><title>Courses</title></head><body><main><h1>Courses</h1>
<div class="courseblock"><p class="courseblocktitle"><strong>CS-UH 1001  Introduction to Computer Science  (4 Credits)</strong></p><p class="courseblockdesc">An introduction to programming and problem solving in Python, for students with no prior experience. Weekly labs. Prerequisite: none.</p></div>
<div class="courseblock"><p class="courseblocktitle"><strong>CS-UH 1050  Data Structures  (4 Credits)</strong></p><p class="courseblockdesc">Lists, trees, graphs, hash tables and the analysis of algorithms that use them. Prerequisite: CS-UH 1001.</p></div>
<div class="courseblock"><p class="courseblocktitle"><strong>ECON-UH 1010  Principles of Microeconomics  (4 Credits)</strong></p><p class="courseblockdesc">Markets, prices, consumer and producer behaviour, and the role of government in the economy.</p></div>
</main></body></html>`;

let site: Server;
let bulletin: Server;
let siteHost = '';
let bulletinHost = '';
let workDir = '';

beforeAll(async () => {
  site = createServer((req, res) => {
    const body = SITE[req.url ?? ''];
    if (!body) {
      res.statusCode = 404;
      res.end('nope');
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(body);
  });
  bulletin = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url?.startsWith('/undergraduate/abu-dhabi/courses') ? BULLETIN : '<html><body><main><h1>Bulletin</h1><p><a href="/undergraduate/abu-dhabi/courses/">All courses</a> in the bulletin for Abu Dhabi, listed by subject with descriptions and credits.</p></main></body></html>');
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => bulletin.listen(0, '127.0.0.1', resolve));
  siteHost = `127.0.0.1:${(site.address() as { port: number }).port}`;
  bulletinHost = `127.0.0.1:${(bulletin.address() as { port: number }).port}`;
  workDir = mkdtempSync(path.join(tmpdir(), 'ror-official-'));
});

afterAll(async () => {
  await new Promise((resolve) => site.close(resolve));
  await new Promise((resolve) => bulletin.close(resolve));
  rmSync(workDir, { recursive: true, force: true });
});

describe('html extraction', () => {
  it('keeps the main content and drops navigation, scripts and footers', () => {
    const html = SITE['/en/academics/global-education/study-away.html']!;
    expect(titleOf(html)).toBe('Study Away');
    const text = textOf(mainHtml(html));
    expect(text).toContain('Applications open in October');
    expect(text).not.toContain('Privacy');
    expect(text).not.toContain('var x');
    expect(breadcrumbsOf(html)).toEqual(['Home', 'Academics', 'Study Away']);
    expect(linksOf(SITE['/en/academics.html']!, 'https://nyuad.example/en/academics.html')).toContain('https://nyuad.example/en/academics/undergraduate/majors-and-minors.html');
    expect(textOf('<ul><li>One</li><li>Two &amp; three</li></ul>')).toBe('- One\n- Two & three');
  });
  it('ignores unresolved portal template links', () => {
    expect(linksOf('<a href="/announcements/{{ id }}">Draft</a><a href="/%7B%7B">Empty</a><a href="mf163@nyu.edu">Contact</a><a href="/announcements/36544">Loaded</a>', 'https://students.nyuad.nyu.edu/')).toEqual(['https://students.nyuad.nyu.edu/announcements/36544']);
  });
  it('parses bulletin course blocks', () => {
    const courses = coursesOf(BULLETIN);
    expect(courses.map((course) => course.code)).toEqual(['CS-UH 1001', 'CS-UH 1050', 'ECON-UH 1010']);
    expect(courses[0]).toMatchObject({ title: 'Introduction to Computer Science', credits: 4 });
    expect(courses[1]!.description).toContain('Prerequisite: CS-UH 1001');
    expect(coursesOf('<main><p>CS-UH 2010 Algorithms (4 Credits)</p><p>Sorting and searching.</p><p>MATH-UH 1012: Calculus with Applications</p><p>Limits and derivatives.</p></main>').map((c) => c.code)).toEqual(['CS-UH 2010', 'MATH-UH 1012']);
  });
  it('classifies pages into guide sections', () => {
    expect(classifySection('https://nyuad.nyu.edu/en/academics/undergraduate/majors-and-minors.html', 'Majors and Minors')).toBe('majors');
    expect(classifySection('https://nyuad.nyu.edu/en/academics/undergraduate/majors/computer-science.html', 'Computer Science')).toBe('majors');
    expect(classifySection('https://nyuad.nyu.edu/en/academics/undergraduate/majors-and-minors/computer-science-major/courses.html', 'Courses')).toBe('majors');
    expect(classifySection('https://nyuad.nyu.edu/en/academics/undergraduate/majors-and-minors/african-studies-minor.html', 'African Studies Minor')).toBe('minors');
    expect(classifySection('https://bulletins.nyu.edu/undergraduate/abu-dhabi/programs/art-history-ba/', 'Art and Art History (BA)')).toBe('majors');
    expect(classifySection('https://bulletins.nyu.edu/undergraduate/abu-dhabi/programs/arabic-minor/', 'Arabic (Minor)')).toBe('minors');
    expect(classifySection('https://nyuad.nyu.edu/en/academics/divisions/science/faculty/jane-doe/publications.html', 'Publications')).toBe('faculty');
    expect(classifySection('https://nyuad.nyu.edu/en/academics/global-education/study-away.html')).toBe('study-away');
    expect(classifySection('https://nyuad.nyu.edu/en/campus-life/housing-and-dining.html')).toBe('housing');
    expect(classifySection('https://bulletins.nyu.edu/undergraduate/abu-dhabi/courses/')).toBe('courses');
    expect(classifySection('https://students.nyuad.nyu.edu/immigration/visa-renewal')).toBe('visa');
  });
});

describe('the crawler and the index', () => {
  it('crawls the fake site, splits the bulletin into courses, indexes and retrieves', async () => {
    const file = path.join(workDir, 'official.jsonl');
    const code = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/scrape-official.ts', '--out', file, '--host', siteHost, '--host', bulletinHost, '--seed', `http://${siteHost}/en/academics.html`, '--seed', `http://${bulletinHost}/undergraduate/abu-dhabi/`, '--delay', '0', '--max', '50'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      child.on('close', (status) => {
        if (status !== 0) console.error(output);
        resolve(status ?? 1);
      });
    });
    expect(code).toBe(0);
    const docs = readOfficialJsonl(file);
    const titles = docs.map((doc) => doc.title).sort();
    expect(titles).toContain('Study Away');
    expect(titles).toContain('CS-UH 1050 Data Structures');
    expect(titles).not.toContain('News today'); // /news/ is skipped
    expect(docs.find((doc) => doc.code === 'CS-UH 1001')?.credits).toBe(4);
    expect(docs.find((doc) => doc.title === 'Study Away')?.section).toBe('study-away');

    const outDir = path.join(workDir, 'official-index');
    const built = await buildOfficialIndex({ file, outDir, embedder: null });
    expect(built.docs).toBe(docs.length);
    process.env.ROR_OFFICIAL_FILE = file;
    process.env.ROR_OFFICIAL_INDEX_DIR = outDir;
    resetOfficial();
    const corpus = await loadOfficial();
    expect(corpus.source).toBe('index');
    expect(corpus.byCode.has('ECON-UH 1010')).toBe(true);
    const { hits, terms } = await retrieveOfficial(corpus, 'when do study away applications open', { k: 3, embedder: null });
    expect(corpus.docs[hits[0]!.doc]!.title).toBe('Study Away');
    const [card] = officialCards(corpus, hits.slice(0, 1), terms, 1);
    expect(card).toMatchObject({ n: 1, kind: 'official', author: 'NYU Abu Dhabi', topics: ['study-away'] });
    expect(card!.snippet.toLowerCase()).toContain('october');
    delete process.env.ROR_OFFICIAL_FILE;
    delete process.env.ROR_OFFICIAL_INDEX_DIR;
    resetOfficial();
  }, 60_000);
});
