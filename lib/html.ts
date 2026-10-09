/**
 * Enough HTML handling to turn an official web page into a titled block of text without a parser dependency:
 * scripts, styles, navigation and footers go, the main content area is preferred, block tags become line breaks,
 * list items become bullets, entities are decoded. Links are collected separately for the crawler.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•' };

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeChar(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeChar(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
}

const DROP = /<(script|style|noscript|svg|template|iframe|nav|header|footer|aside|form|button|select|dialog)\b[\s\S]*?<\/\1>/gi;
const DROP_BY_CLASS = /<(div|section|ul|ol)\b[^>]*\b(?:class|id|role)=["'][^"']*(?:breadcrumb|cookie|nav|menu|footer|header|sidebar|social|share|skip|banner|modal|search|megamenu|utility|toolbar|newsletter|related-links)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi;

/** The part of the page that holds the content, as raw HTML. */
export function mainHtml(html: string): string {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const candidates = [/<main\b[^>]*>([\s\S]*?)<\/main>/i, /<article\b[^>]*>([\s\S]*?)<\/article>/i, /<div\b[^>]*\b(?:id|class)=["'][^"']*(?:main-content|maincontent|content-main|page-content|article-body|entry-content|contentarea|textcontainer)[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<(?:footer|\/body)/i, /<body\b[^>]*>([\s\S]*?)<\/body>/i];
  for (const pattern of candidates) {
    const match = pattern.exec(withoutComments);
    if (match?.[1] && textOf(match[1]).length > 120) return match[1];
  }
  return withoutComments;
}

/** Plain text of an HTML fragment, blocks separated by newlines and list items bulleted. */
export function textOf(fragment: string): string {
  let text = fragment.replace(DROP, ' ');
  let previous = '';
  while (previous !== text) {
    previous = text;
    text = text.replace(DROP_BY_CLASS, ' ');
  }
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|tr|blockquote|pre|dd|dt|figcaption|table)>/gi, '\n')
    .replace(/<(h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<t[dh]\b[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function titleOf(html: string): string {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = (h1?.[1] && textOf(h1[1])) || (title?.[1] && textOf(title[1])) || '';
  return raw
    .replace(/\s*[|–-]\s*(?:NYU Abu Dhabi|NYUAD|New York University Abu Dhabi|NYU)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Keep service headings attached to their own hours and instructions. */
export function sectionsOf(html: string): Array<{ title: string; text: string }> {
  const titles: string[] = [];
  let parent = '';
  const marked = mainHtml(html).replace(/<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, raw: string) => {
    const title = textOf(raw);
    if (level === '2') parent = title;
    titles.push(level === '3' && parent ? `${parent} · ${title}` : title);
    return `\nNYUAD_SECTION_${titles.length - 1}\n`;
  });
  const blocks = textOf(marked).split(/NYUAD_SECTION_(\d+)/);
  const sections: Array<{ title: string; text: string }> = [];
  for (let i = 1; i < blocks.length; i += 2) {
    const title = titles[Number(blocks[i])];
    const text = blocks[i + 1]?.trim();
    if (title && text && text.length >= 40) sections.push({ title, text });
  }
  const intro = blocks[0]?.trim();
  if (sections.length && intro && intro.length >= 40) sections.unshift({ title: titleOf(html), text: intro });
  return sections;
}

export function breadcrumbsOf(html: string): string[] {
  const block = /<(?:nav|ol|ul|div)\b[^>]*\b(?:class|id|aria-label)=["'][^"']*breadcrumb[^"']*["'][^>]*>([\s\S]*?)<\/(?:nav|ol|ul|div)>/i.exec(html);
  if (!block?.[1]) return [];
  return [...block[1].matchAll(/<(?:a|li|span)\b[^>]*>([\s\S]*?)<\/(?:a|li|span)>/gi)]
    .map((match) => textOf(match[1]!).replace(/^-\s*/, '').trim())
    .filter((crumb) => crumb && !/^[\/>»›→|·-]+$/.test(crumb))
    .filter((crumb, index, all) => all.indexOf(crumb) === index)
    .slice(0, 6);
}

/** Absolute http(s) links on the page, with fragments removed. */
export function linksOf(html: string, base: string): string[] {
  const out = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*\bhref=["']([^"'#]+)(?:#[^"']*)?["']/gi)) {
    const href = decodeEntities(match[1]!).trim();
    if (!href || /^(?:javascript|mailto|tel|data):/i.test(href)) continue;
    try {
      const url = new URL(href, base);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      url.hash = '';
      out.add(url.toString());
    } catch {
      // ignore malformed hrefs
    }
  }
  return [...out];
}

interface CourseEntry {
  code: string;
  title: string;
  credits?: number;
  description: string;
}

/**
 * Course entries from a bulletin listing. NYU's bulletin (CourseLeaf) renders each course as a "courseblock" with a
 * title like "CS-UH 1001  Introduction to Computer Science  (4 Credits)"; other pages are read line by line.
 */
export function coursesOf(html: string): CourseEntry[] {
  const out: CourseEntry[] = [];
  const blocks = [...html.matchAll(/<div\b[^>]*\bclass=["'][^"']*courseblock[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?=<div\b[^>]*\bclass=["'][^"']*courseblock|$|<\/)/gi)];
  const sources = blocks.length ? blocks.map((match) => textOf(match[1]!)) : [textOf(mainHtml(html))];
  const head = /^\s*([A-Z]{2,7}-UH\s?\d{4}[A-Z]{0,2})\s*[-–:.]?\s+(.+?)\s*(?:\((\d+(?:\.\d+)?)\s*(?:credits?|units?|points?)\)\s*)?$/i;
  for (const source of sources) {
    const lines = source.split('\n').map((line) => line.trim()).filter(Boolean);
    let current: CourseEntry | null = null;
    for (const line of lines) {
      const match = head.exec(line);
      if (match && line.length < 160) {
        if (current) out.push(current);
        current = { code: normalizeCode(match[1]!), title: match[2]!.trim(), credits: match[3] ? Number(match[3]) : undefined, description: '' };
      } else if (current) {
        current.description = current.description ? `${current.description}\n${line}` : line;
      }
    }
    if (current) out.push(current);
  }
  const byCode = new Map<string, CourseEntry>();
  for (const entry of out) if (!byCode.has(entry.code) || entry.description.length > byCode.get(entry.code)!.description.length) byCode.set(entry.code, entry);
  return [...byCode.values()];
}

export function normalizeCode(code: string): string {
  const match = /^([A-Za-z]{2,7})-UH\s?(\d{4}[A-Za-z]{0,2})$/.exec(code.trim());
  return match ? `${match[1]!.toUpperCase()}-UH ${match[2]!.toUpperCase()}` : code.toUpperCase();
}
