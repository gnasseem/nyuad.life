/**
 * Crawls the official NYUAD pages into data/official.jsonl: nyuad.nyu.edu (academics, campus life, admissions...),
 * the student portal and the NYU bulletin for Abu Dhabi, where every course has a code, a title and a description.
 *
 *   npm run scrape:official                     everything the seeds reach (about 20 minutes with the default delay)
 *   npm run scrape:official -- --max 300        stop after 300 pages (smoke test)
 *   npm run scrape:official -- --delay 200      milliseconds between requests (default 400)
 *   npm run scrape:official -- --seed URL       add a start page; repeatable
 *   npm run scrape:official -- --host HOST      only crawl this host (repeatable)
 *
 * The run is resumable: pages already in the file are refreshed, pages that fail keep their last good copy.
 * Then `npm run index:official` embeds the result into data/official-index.
 */
import { loadDotEnv } from '../lib/env.ts';
import { breadcrumbsOf, coursesOf, linksOf, mainHtml, textOf, titleOf } from '../lib/html.ts';
import { classifySection, officialFile, officialId, readOfficialJsonl, writeOfficialJsonl, type OfficialDoc } from '../lib/official.ts';

loadDotEnv();

const DEFAULT_SEEDS = [
  'https://nyuad.nyu.edu/en/academics.html',
  'https://nyuad.nyu.edu/en/academics/undergraduate.html',
  'https://nyuad.nyu.edu/en/academics/undergraduate/majors-and-minors.html',
  'https://nyuad.nyu.edu/en/academics/undergraduate/core-curriculum.html',
  'https://nyuad.nyu.edu/en/academics/undergraduate/academic-resources.html',
  'https://nyuad.nyu.edu/en/academics/global-education.html',
  'https://nyuad.nyu.edu/en/academics/global-education/study-away.html',
  'https://nyuad.nyu.edu/en/academics/undergraduate-research.html',
  'https://nyuad.nyu.edu/en/campus-life.html',
  'https://nyuad.nyu.edu/en/campus-life/housing-and-dining.html',
  'https://nyuad.nyu.edu/en/campus-life/health-and-wellness.html',
  'https://nyuad.nyu.edu/en/campus-life/student-life.html',
  'https://nyuad.nyu.edu/en/campus-life/career-development.html',
  'https://nyuad.nyu.edu/en/admissions.html',
  'https://nyuad.nyu.edu/en/admissions/undergraduate.html',
  'https://nyuad.nyu.edu/en/admissions/undergraduate/cost-and-financial-support.html',
  'https://students.nyuad.nyu.edu/',
  'https://bulletins.nyu.edu/undergraduate/abu-dhabi/',
];

/** Path prefixes worth crawling per host; anything else on the host is skipped. */
const ALLOWED: Record<string, RegExp[]> = {
  'nyuad.nyu.edu': [/^\/en\/(?:academics|campus-life|admissions|about\/(?:campus|visit|facts))/],
  'students.nyuad.nyu.edu': [/^\//],
  'bulletins.nyu.edu': [/^\/undergraduate\/abu-dhabi\//, /^\/courses\/[a-z]{2,7}_uh\//i],
};
const SKIP = /\/(?:news|events|media|press|faculty-directory|people|profiles|gallery|videos|podcast|newsletter|search|login|sitemap)(?:\/|\.|$)|\.(?:pdf|jpe?g|png|gif|svg|mp4|zip|docx?|pptx?|xlsx?)$|\?/i;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const values = (name: string) => args.flatMap((arg, i) => (arg === `--${name}` && args[i + 1] ? [args[i + 1]!] : []));
const value = (name: string) => values(name)[0];

const max = Number(value('max')) || 4000;
const delay = Number(value('delay')) || 400;
const hosts = new Set(values('host'));
const seeds = [...DEFAULT_SEEDS, ...values('seed')].filter((url) => hosts.size === 0 || hosts.has(new URL(url).host));
const file = value('out') ?? officialFile();

function allowed(url: URL): boolean {
  if (hosts.size > 0 && !hosts.has(url.host)) return false;
  const rules = ALLOWED[url.host] ?? (hosts.has(url.host) ? [/^\//] : undefined);
  if (!rules) return false;
  if (SKIP.test(url.pathname + url.search)) return false;
  return rules.some((rule) => rule.test(url.pathname));
}

async function fetchPage(url: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'nyuad.life crawler (+https://nyuad.life; student project; contact via the site)', accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(25_000) });
      if (response.status === 404 || response.status === 410) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!(response.headers.get('content-type') ?? '').includes('html')) return null;
      return await response.text();
    } catch (error) {
      if (attempt === 2) {
        console.warn(`[official] ${url}: ${(error as Error).message}`);
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  return null;
}

async function sitemapUrls(host: string): Promise<string[]> {
  const xml = await fetchPage(`https://${host}/sitemap.xml`).catch(() => null);
  if (!xml) return [];
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => match[1]!);
}

async function main(): Promise<void> {
  const existing = new Map(readOfficialJsonl(file).map((doc) => [doc.url, doc]));
  console.log(`[official] ${existing.size} pages on disk; crawling from ${seeds.length} seeds (max ${max}, ${delay} ms apart).`);
  const queue: string[] = [];
  const seen = new Set<string>();
  const enqueue = (raw: string) => {
    try {
      const url = new URL(raw);
      url.hash = '';
      // The sitemaps list http URLs for pages the site serves over https; fetching both stored every page twice.
      if (url.protocol === 'http:' && url.host in ALLOWED) url.protocol = 'https:';
      const key = url.toString().replace(/\/$/, '');
      if (seen.has(key) || !allowed(url)) return;
      seen.add(key);
      queue.push(url.toString());
    } catch {
      // ignore
    }
  };
  seeds.forEach(enqueue);
  for (const host of new Set(seeds.map((url) => new URL(url).host))) {
    const fromSitemap = await sitemapUrls(host);
    if (fromSitemap.length) console.log(`[official] ${host}: ${fromSitemap.length} URLs in the sitemap.`);
    fromSitemap.forEach(enqueue);
  }

  const docs = new Map(existing);
  const fetchedAt = new Date().toISOString();
  let fetched = 0;
  let kept = 0;
  const started = Date.now();
  let lastSave = Date.now();
  const save = () => {
    writeOfficialJsonl(file, [...docs.values()].sort((a, b) => a.url.localeCompare(b.url)));
    lastSave = Date.now();
  };
  process.on('SIGINT', () => {
    console.log('\n[official] Interrupted; saving what was fetched.');
    save();
    process.exit(0);
  });

  while (queue.length && fetched < max) {
    const url = queue.shift()!;
    const html = await fetchPage(url);
    fetched++;
    if (html) {
      linksOf(html, url).forEach(enqueue);
      const title = titleOf(html);
      // Bulletin listings (CourseLeaf "courseblock"s) and any page that reads as a course list become one document per course.
      const looksLikeCourses = /courseblock/.test(html) || /bulletins\.nyu\.edu|\/courses?(?:\/|\.|$)/i.test(url);
      const courses = looksLikeCourses ? coursesOf(html) : [];
      if (courses.length >= 3) {
        for (const course of courses) {
          if (course.description.length < 40) continue;
          const courseUrl = `${url}#${course.code.replace(/\s+/g, '-')}`;
          docs.set(courseUrl, {
            id: officialId(courseUrl),
            url,
            title: `${course.code} ${course.title}`,
            section: 'courses',
            breadcrumbs: ['Bulletin', title],
            text: `${course.code} ${course.title}${course.credits ? ` (${course.credits} credits)` : ''}\n${course.description}`,
            code: course.code,
            credits: course.credits,
            fetchedAt,
          });
          kept++;
        }
      }
      const text = textOf(mainHtml(html));
      if (title && text.length >= 200) {
        const doc: OfficialDoc = { id: officialId(url), url, title, section: classifySection(url, title), breadcrumbs: breadcrumbsOf(html), text: text.slice(0, 60_000), fetchedAt };
        docs.set(url, doc);
        kept++;
      }
    }
    if (fetched % 25 === 0) {
      const rate = fetched / ((Date.now() - started) / 1000);
      console.log(`[official] ${fetched} fetched, ${kept} kept, ${queue.length} queued (${rate.toFixed(1)}/s)`);
    }
    if (Date.now() - lastSave > 60_000) save();
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  save();
  const sections = new Map<string, number>();
  for (const doc of docs.values()) sections.set(doc.section, (sections.get(doc.section) ?? 0) + 1);
  console.log(`[official] Done: ${fetched} pages fetched, ${docs.size} documents in ${file}.`);
  console.log(`[official] By section: ${[...sections.entries()].sort((a, b) => b[1] - a[1]).map(([section, count]) => `${section} ${count}`).join(', ')}`);
  if (flag('json')) console.log(JSON.stringify({ fetched, documents: docs.size }));
}

main().catch((error) => {
  console.error('[official] Failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
