/**
 * Pulls posts and comments out of the JSON Facebook's web client receives (GraphQL responses and the
 * JSON blobs embedded in the page). It walks the data generically by `__typename`, so it survives most
 * of Facebook's frequent renames. The scraper (scripts/scrape.ts) feeds it and merges the results.
 */
import type { SourceComment, SourcePost } from './types.ts';

export interface StoryRecord {
  id: string;
  url: string;
  author: string;
  date: string;
  text: string;
  reactions?: number;
  commentCount?: number;
}

export interface CommentRecord {
  id: string;
  author: string;
  date: string;
  text: string;
  parentId?: string;
  /** Post id when Facebook tells us (decoded from feedback ids). */
  postId?: string;
}

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

/** Facebook streams several JSON documents per GraphQL response, one per line; some lines are not JSON. */
export function parseJsonDocuments(body: string): unknown[] {
  const out: unknown[] = [];
  const trimmed = body.trim();
  if (!trimmed) return out;
  try {
    out.push(JSON.parse(trimmed));
    return out;
  } catch {
    // fall through to line mode
  }
  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
    try {
      out.push(JSON.parse(candidate));
    } catch {
      // ignore partial lines
    }
  }
  return out;
}

/** Finds the JSON payloads Facebook embeds in <script type="application/json"> tags of a server-rendered page. */
export function embeddedJsonFromHtml(html: string): unknown[] {
  const out: unknown[] = [];
  const pattern = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
  for (const match of html.matchAll(pattern)) {
    try {
      out.push(JSON.parse(match[1]!));
    } catch {
      // not JSON
    }
  }
  return out;
}

const SKIP_KEYS = new Set(['attached_story', 'attached_story_render_location', 'shared_story', 'sponsored_data', 'ad_context']);

/** Collects every Story-like node, merging nested copies of the same story by post id. */
export function extractStories(root: unknown, options: { groupPath?: string } = {}): StoryRecord[] {
  const byId = new Map<string, StoryRecord>();
  walk(root, (node) => {
    if (!isRecord(node) || node.__typename !== 'Story') return;
    const record = storyFromNode(node);
    if (!record) return;
    if (options.groupPath && record.url && !record.url.includes(options.groupPath) && !record.url.includes('/posts/')) return;
    const existing = byId.get(record.id);
    byId.set(record.id, existing ? mergeStory(existing, record) : record);
  });
  return [...byId.values()].filter((story) => story.text || (story.commentCount ?? 0) > 0);
}

export function extractComments(root: unknown): CommentRecord[] {
  const byId = new Map<string, CommentRecord>();
  walk(root, (node) => {
    if (!isRecord(node) || node.__typename !== 'Comment') return;
    const record = commentFromNode(node);
    if (record && !byId.has(record.id)) byId.set(record.id, record);
  });
  return [...byId.values()];
}

function storyFromNode(node: Record<string, unknown>): StoryRecord | null {
  const postId =
    str(node.post_id) ||
    idFromFeedback(deepFirst(node, (key, value) => key === 'id' && typeof value === 'string' && looksLikeFeedbackId(value)) as string | undefined) ||
    idFromStoryId(str(node.id)) ||
    idFromUrl(str(deepFirst(node, (key, value) => (key === 'wwwURL' || key === 'url' || key === 'permalink_url') && typeof value === 'string' && value.includes('/posts/'))));
  if (!postId) return null;
  const url = str(deepFirst(node, (key, value) => (key === 'wwwURL' || key === 'permalink_url' || key === 'url') && typeof value === 'string' && /\/(posts|permalink)\/\d+/.test(value)));
  const message = deepFirst(node, (key, value, parentKey) => key === 'text' && typeof value === 'string' && (parentKey === 'message' || parentKey === 'message_preview' || parentKey === 'title'));
  const actors = deepFirst(node, (key, value) => key === 'actors' && Array.isArray(value)) as Array<Record<string, unknown>> | undefined;
  const author = str(actors?.[0]?.name) || str(deepFirst(node, (key, value, parentKey) => key === 'name' && typeof value === 'string' && (parentKey === 'author' || parentKey === 'owning_profile')));
  const created = deepFirst(node, (key, value) => (key === 'creation_time' || key === 'publish_time') && typeof value === 'number') as number | undefined;
  const reactions = deepFirst(node, (key, value, parentKey) => key === 'count' && typeof value === 'number' && (parentKey === 'reaction_count' || parentKey === 'reactors' || parentKey === 'i18n_reaction_count')) as number | undefined;
  const commentCount = deepFirst(
    node,
    (key, value, parentKey) =>
      (key === 'total_comment_count' && typeof value === 'number') || (key === 'total_count' && typeof value === 'number' && (parentKey === 'comments' || parentKey === 'comment_count' || parentKey === 'display_comments')),
  ) as number | undefined;
  const record: StoryRecord = {
    id: postId,
    url: url || '',
    author: author || '',
    date: created ? new Date(created * 1000).toISOString().slice(0, 10) : '',
    text: typeof message === 'string' ? message : '',
  };
  if (typeof reactions === 'number') record.reactions = reactions;
  if (typeof commentCount === 'number') record.commentCount = commentCount;
  return record;
}

function commentFromNode(node: Record<string, unknown>): CommentRecord | null {
  const id = str(node.id) || str(node.legacy_fbid);
  const body = node.body;
  const text = isRecord(body) ? str(body.text) : str(node.body_text);
  if (!id || (!text && !isRecord(node.author))) return null;
  const author = isRecord(node.author) ? str(node.author.name) : '';
  const created = typeof node.created_time === 'number' ? node.created_time : typeof node.creation_time === 'number' ? node.creation_time : undefined;
  const record: CommentRecord = {
    id,
    author,
    date: created ? new Date(created * 1000).toISOString().slice(0, 10) : '',
    text,
  };
  const parent = node.comment_parent ?? node.reply_parent ?? node.parent_comment;
  if (isRecord(parent) && typeof parent.id === 'string') record.parentId = parent.id;
  const feedback = node.feedback;
  const postId = idFromCommentId(id) || (isRecord(feedback) ? idFromFeedback(str(feedback.id)) : '');
  if (postId) record.postId = postId;
  return record;
}

function mergeStory(a: StoryRecord, b: StoryRecord): StoryRecord {
  return {
    id: a.id,
    url: a.url || b.url,
    author: a.author || b.author,
    date: a.date || b.date,
    text: b.text.length > a.text.length ? b.text : a.text,
    reactions: Math.max(a.reactions ?? -1, b.reactions ?? -1) >= 0 ? Math.max(a.reactions ?? 0, b.reactions ?? 0) : undefined,
    commentCount: Math.max(a.commentCount ?? -1, b.commentCount ?? -1) >= 0 ? Math.max(a.commentCount ?? 0, b.commentCount ?? 0) : undefined,
  };
}

/** Attaches comments to stories and produces archive records. Comments without a known post go to `fallbackPostId`. */
export function toSourcePosts(stories: StoryRecord[], comments: CommentRecord[], fallbackPostId?: string): SourcePost[] {
  const grouped = new Map<string, SourceComment[]>();
  for (const comment of comments) {
    const postId = comment.postId ?? fallbackPostId;
    if (!postId) continue;
    const list = grouped.get(postId) ?? [];
    list.push({ author: comment.author, date: comment.date, text: comment.text });
    grouped.set(postId, list);
  }
  return stories.map((story) => {
    const post: SourcePost = {
      id: story.id,
      url: story.url,
      author: story.author,
      date: story.date,
      text: story.text,
      comments: grouped.get(story.id) ?? [],
      scrapedAt: new Date().toISOString(),
    };
    if (typeof story.reactions === 'number') post.reactions = story.reactions;
    post.commentCount = Math.max(story.commentCount ?? 0, post.comments.length);
    return post;
  });
}

/** "feedback:1234567890" base64-encoded → "1234567890". */
export function idFromFeedback(value: string | undefined): string {
  if (!value) return '';
  const decoded = decodeBase64(value);
  const match = /^feedback:(\d+)/.exec(decoded);
  return match?.[1] ?? '';
}

/** Story ids decode to strings like "S:_I100001234567890:1234567890123456"; the last number is the post id. */
export function idFromStoryId(value: string | undefined): string {
  if (!value) return '';
  if (/^\d+$/.test(value)) return value;
  const decoded = decodeBase64(value);
  const match = /^S:_I\d+:(\d+)$/.exec(decoded);
  return match?.[1] ?? '';
}

/** Comment ids decode to "comment:POSTID_COMMENTID". */
export function idFromCommentId(value: string | undefined): string {
  if (!value) return '';
  const decoded = decodeBase64(value);
  const match = /^comment:(\d+)_\d+/.exec(decoded);
  return match?.[1] ?? '';
}

export function idFromUrl(value: string | undefined): string {
  if (!value) return '';
  const match = /\/(?:posts|permalink)\/(\d+)/.exec(value) ?? /[?&](?:story_fbid|fbid)=(\d+)/.exec(value);
  return match?.[1] ?? '';
}

function looksLikeFeedbackId(value: string): boolean {
  return decodeBase64(value).startsWith('feedback:');
}

function decodeBase64(value: string): string {
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Depth-first visit of every object in the tree, skipping shared/attached stories so they are not mistaken for the post itself. */
function walk(root: unknown, visit: (node: unknown) => void, depth = 0): void {
  if (depth > 60 || root === null || typeof root !== 'object') return;
  visit(root);
  if (Array.isArray(root)) {
    for (const item of root) walk(item, visit, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    if (SKIP_KEYS.has(key)) continue;
    walk(value, visit, depth + 1);
  }
}

/** Like `walk`, but tells the visitor the key each value sits under and the key of the object that holds it. */
function walkKeyed(root: unknown, visit: (value: unknown, key: string, parentKey: string) => void, key = '', parentKey = '', depth = 0): void {
  if (depth > 60 || root === null || typeof root !== 'object') return;
  if (Array.isArray(root)) {
    for (const item of root) walkKeyed(item, visit, key, parentKey, depth + 1);
    return;
  }
  for (const [childKey, value] of Object.entries(root as Record<string, unknown>)) {
    if (SKIP_KEYS.has(childKey)) continue;
    visit(value, childKey, key);
    walkKeyed(value, visit, childKey, key, depth + 1);
  }
}

/* ---------- GraphQL pagination helpers (used by scripts/scrape.ts to page through the feed itself) ---------- */

export interface PageInfo {
  endCursor: string;
  hasNextPage: boolean;
}

/**
 * The `page_info` (cursor for the next page) of a feed connection such as `group_feed`. When a response holds several
 * connections (comments have page_info too) the one whose parent key mentions "feed" wins.
 */
export function extractFeedPageInfo(root: unknown): PageInfo | null {
  let best: PageInfo | null = null;
  let bestScore = -1;
  walkKeyed(root, (value, key, parentKey) => {
    if (key !== 'page_info' || !isRecord(value) || typeof value.has_next_page !== 'boolean') return;
    const score = /feed/i.test(parentKey) ? 2 : /stories|posts/i.test(parentKey) ? 1 : 0;
    if (score > bestScore) {
      bestScore = score;
      best = { endCursor: typeof value.end_cursor === 'string' ? value.end_cursor : '', hasNextPage: value.has_next_page };
    }
  });
  return best;
}

export interface GraphqlRequest {
  friendlyName: string;
  docId: string;
  variables: Record<string, unknown>;
}

/** Parses the x-www-form-urlencoded body Facebook's client posts to /api/graphql/. */
export function parseGraphqlForm(postData: string | null | undefined): GraphqlRequest | null {
  if (!postData) return null;
  const fields = new URLSearchParams(postData);
  const raw = fields.get('variables');
  if (!raw) return null;
  try {
    const variables = JSON.parse(raw) as unknown;
    if (!isRecord(variables)) return null;
    return { friendlyName: fields.get('fb_api_req_friendly_name') ?? '', docId: fields.get('doc_id') ?? '', variables };
  } catch {
    return null;
  }
}

/** The same form body with different `variables`; every other field (session tokens, doc_id, …) is kept as it was. */
export function withGraphqlVariables(postData: string, variables: Record<string, unknown>): string {
  const fields = new URLSearchParams(postData);
  fields.set('variables', JSON.stringify(variables));
  return fields.toString();
}

/** True for the request Facebook's client sends to load more group posts: the one worth replaying with new cursors. */
export function isFeedPaginationRequest(request: GraphqlRequest): boolean {
  const variables = request.variables;
  if (!('cursor' in variables)) return false;
  if (/feed/i.test(request.friendlyName) && /pagination/i.test(request.friendlyName)) return true;
  return 'sortingSetting' in variables || 'feedType' in variables || variables.feedLocation === 'GROUP';
}

/** Error messages Facebook reports inside an otherwise successful GraphQL response (rate limits, expired sessions…). */
export function graphqlErrors(docs: unknown[]): string[] {
  const out: string[] = [];
  for (const doc of docs) {
    if (!isRecord(doc) || !Array.isArray(doc.errors)) continue;
    for (const error of doc.errors) {
      if (!isRecord(error)) continue;
      const code = typeof error.code === 'number' ? ` (code ${error.code})` : '';
      out.push(`${str(error.summary) || str(error.description) || str(error.message) || 'unknown error'}${code}`);
    }
  }
  return out;
}

/** Breadth-first search for the first (shallowest) value whose key/value/parentKey satisfy the predicate. */
function deepFirst(root: unknown, predicate: (key: string, value: unknown, parentKey: string) => boolean): unknown {
  const queue: Array<{ node: unknown; parentKey: string; depth: number }> = [{ node: root, parentKey: '', depth: 0 }];
  while (queue.length) {
    const { node, parentKey, depth } = queue.shift()!;
    if (node === null || typeof node !== 'object' || depth > 40) continue;
    if (Array.isArray(node)) {
      for (const item of node) queue.push({ node: item, parentKey, depth: depth + 1 });
      continue;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (SKIP_KEYS.has(key)) continue;
      if (predicate(key, value, parentKey)) return value;
      if (value !== null && typeof value === 'object') queue.push({ node: value, parentKey: key, depth: depth + 1 });
    }
  }
  return undefined;
}

export type { Json };
