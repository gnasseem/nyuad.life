/**
 * A stand-in for facebook.com used by scrape.test.ts: a login page that submits itself a moment later (like a
 * person clicking "Log in"), the "save your login info?" interstitial, a group feed whose client loads more
 * posts through /api/graphql/ with cursors, and thread pages whose comments expand through the same endpoint.
 * The JSON shapes mirror what lib/facebook.ts expects from the real site.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface FakePost {
  id: string;
  author: string;
  /** Unix seconds. */
  createdAt: number;
  text: string;
  comments: Array<{ author: string; createdAt: number; text: string }>;
}

export interface FakeOptions {
  slug: string;
  posts: FakePost[];
  /** Posts per feed page when the client asks; the scraper may ask for more. */
  pageSize?: number;
  /** Answer a feed request with a rate-limit error when this returns true (exercises the retry path). `nth` counts feed requests from 1. */
  failFeedRequest?: (request: { from: number; count: number; nth: number }) => boolean;
  loginDelayMs?: number;
}

export interface FakeFacebook {
  server: Server;
  url: string;
  calls: { logins: number; feedPages: number; comments: number; groupViews: number };
  close(): Promise<void>;
}

const b64 = (value: string) => Buffer.from(value).toString('base64');

export function makePosts(count: number, commentedEvery = 10): FakePost[] {
  const newest = Date.UTC(2026, 8, 20) / 1000;
  return Array.from({ length: count }, (_, i) => {
    const id = String(26_000_000_000_000_000 + i * 7919);
    const createdAt = newest - i * 86_400 * 3;
    const comments = i % commentedEvery === 0 ? [1, 2, 3].map((n) => ({ author: `Commenter ${n}`, createdAt: createdAt + n * 3600, text: `Reply ${n} on post ${i}` })) : [];
    return { id, author: `Student ${i}`, createdAt, text: `Post number ${i}: which professor is best for course CS-UH ${1000 + (i % 40)}?`, comments };
  });
}

export function startFakeFacebook(options: FakeOptions): Promise<FakeFacebook> {
  const pageSize = options.pageSize ?? 3;
  const loginDelay = options.loginDelayMs ?? 1500;
  const calls = { logins: 0, feedPages: 0, comments: 0, groupViews: 0 };
  const groupPath = `/groups/${options.slug}`;
  let origin = '';

  const storyNode = (post: FakePost) => ({
    __typename: 'Story',
    id: b64(`S:_I100001:${post.id}`),
    post_id: post.id,
    comet_sections: {
      content: {
        story: {
          __typename: 'Story',
          id: b64(`S:_I100001:${post.id}`),
          wwwURL: `${origin}${groupPath}/posts/${post.id}/`,
          actors: [{ __typename: 'User', name: post.author }],
          message: { text: post.text },
        },
      },
      context_layout: { story: { comet_sections: { metadata: [{ story: { creation_time: post.createdAt } }] } } },
      feedback: {
        story: {
          feedback_context: {
            feedback_target_with_context: {
              comet_ufi_summary_and_actions_renderer: {
                feedback: { id: b64(`feedback:${post.id}`), reaction_count: { count: 2 }, total_comment_count: post.comments.length },
              },
            },
          },
        },
      },
    },
  });

  const commentNode = (post: FakePost, index: number) => ({
    __typename: 'Comment',
    id: b64(`comment:${post.id}_${index + 1}`),
    body: { text: post.comments[index]!.text },
    author: { __typename: 'User', name: post.comments[index]!.author },
    created_time: post.comments[index]!.createdAt,
    feedback: { id: b64(`feedback:${post.id}_${index + 1}`) },
  });

  const feedDoc = (from: number, count: number) => {
    const slice = options.posts.slice(from, from + count);
    const next = from + slice.length;
    return {
      data: {
        node: {
          __typename: 'Group',
          id: '1234',
          group_feed: {
            edges: slice.map((post) => ({ node: storyNode(post), cursor: `c:${options.posts.indexOf(post) + 1}` })),
            page_info: { end_cursor: `c:${next}`, has_next_page: next < options.posts.length },
          },
        },
      },
    };
  };

  const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  const send = (res: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': type, ...headers });
    res.end(body);
  };
  const loggedIn = (req: IncomingMessage) => /(?:^|;\s*)c_user=\d+/.test(req.headers.cookie ?? '');
  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  };

  const feedPage = () => {
    const first = feedDoc(0, 5);
    const client = `
      const state = { cursor: ${JSON.stringify(first.data.node.group_feed.page_info.end_cursor)}, hasNext: ${first.data.node.group_feed.page_info.has_next_page}, busy: false };
      function append(node) {
        const div = document.createElement('div');
        div.setAttribute('role', 'article');
        div.style.height = '420px';
        div.textContent = node.comet_sections.content.story.message.text;
        document.getElementById('feed').appendChild(div);
      }
      for (const edge of ${JSON.stringify(first.data.node.group_feed.edges)}) append(edge.node);
      function loadMore() {
        if (!state.hasNext || state.busy) return;
        state.busy = true;
        const variables = JSON.stringify({ count: ${pageSize}, cursor: state.cursor, feedLocation: 'GROUP', feedType: 'DISCUSSION', sortingSetting: 'CHRONOLOGICAL', id: '1234', scale: 1 });
        const body = new URLSearchParams({ av: '100', __user: '100', __a: '1', fb_dtsg: 'DTSG-TOKEN', jazoest: '25', lsd: 'LSD-TOKEN', fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: 'GroupsCometFeedRegularStoriesPaginationQuery', variables, server_timestamps: 'true', doc_id: '7000000001' }).toString();
        fetch('/api/graphql/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-fb-friendly-name': 'GroupsCometFeedRegularStoriesPaginationQuery', 'x-fb-lsd': 'LSD-TOKEN', 'x-asbd-id': '129477' }, body })
          .then((response) => response.json())
          .then((doc) => {
            const feed = doc.data.node.group_feed;
            for (const edge of feed.edges) append(edge.node);
            state.cursor = feed.page_info.end_cursor;
            state.hasNext = feed.page_info.has_next_page;
            state.busy = false;
          })
          .catch(() => { state.busy = false; });
      }
      window.addEventListener('scroll', () => {
        if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 300) loadMore();
      });`;
    return page(
      'Group',
      `<div role="navigation">Logged in as Test</div><div id="feed" role="feed"></div><script type="application/json" data-sjs>${JSON.stringify({ require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { require: [['RelayPrefetchedStreamCache', 'next', [], ['adp_GroupsCometFeedQuery', { __bbox: { result: first } }]]] } }]]] })}</script><script>${client}</script>`,
    );
  };

  const threadPage = (post: FakePost) => {
    const shown = post.comments.slice(0, 2).map((_, index) => commentNode(post, index));
    const doc = { data: { node: storyNode(post), comments: shown } };
    const client = `
      const feedback = ${JSON.stringify(b64(`feedback:${post.id}`))};
      function graphql(name, variables) {
        const body = new URLSearchParams({ av: '100', fb_dtsg: 'DTSG-TOKEN', lsd: 'LSD-TOKEN', fb_api_req_friendly_name: name, variables: JSON.stringify(variables), doc_id: '7000000002' }).toString();
        return fetch('/api/graphql/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-fb-friendly-name': name, 'x-fb-lsd': 'LSD-TOKEN' }, body }).then((r) => r.json());
      }
      document.getElementById('sorter').addEventListener('click', () => { document.getElementById('menu').style.display = 'block'; });
      document.getElementById('all').addEventListener('click', () => { document.getElementById('menu').style.display = 'none'; graphql('CommentsListComponentsPaginationQuery', { id: feedback, commentsIntentToken: 'CHRONOLOGICAL_UNFILTERED_INTENT_V1' }); });
      const more = document.getElementById('more');
      if (more) more.addEventListener('click', () => { more.remove(); graphql('CommentsListComponentsPaginationQuery', { id: feedback, commentsAfterCursor: 'after:2' }); });`;
    return page(
      'Thread',
      `<article><h1>${post.author}</h1><p>${post.text}</p></article>
       <div role="button" id="sorter" tabindex="0">Most relevant</div>
       <div role="menu" id="menu" style="display:none"><div role="menuitem" tabindex="0">Most relevant</div><div role="menuitem" id="all" tabindex="0">All comments</div></div>
       <section id="comments">${shown.map((c) => `<div>${c.body.text}</div>`).join('')}</section>
       ${post.comments.length > 2 ? '<div role="button" id="more" tabindex="0">View more comments</div>' : ''}
       <script type="application/json" data-sjs>${JSON.stringify(doc)}</script><script>${client}</script>`,
    );
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin || 'http://localhost');
    const pathname = url.pathname.replace(/\/$/, '') || '/';
    try {
      if (pathname === '/login' && req.method === 'GET') {
        const next = url.searchParams.get('next') ?? '/';
        return send(
          res,
          200,
          'text/html',
          page(
            'Log in to Facebook',
            `<form method="post" action="/login/?next=${encodeURIComponent(next)}" data-testid="royal_login_form"><input name="email" value="test@example.com"><input name="pass" type="password" value="x"><button type="submit" name="login">Log in</button></form>
             <script>setTimeout(() => document.querySelector('form').submit(), ${loginDelay});</script>`,
          ),
        );
      }
      if (pathname === '/login' && req.method === 'POST') {
        await readBody(req);
        calls.logins++;
        const next = url.searchParams.get('next') ?? '/';
        // Like the real ones, these persist for a year so the saved browser profile stays logged in between runs.
        res.setHeader('set-cookie', ['c_user=100001; Path=/; Max-Age=31536000; HttpOnly', 'xs=session%3Atoken; Path=/; Max-Age=31536000; HttpOnly']);
        return send(res, 302, 'text/plain', '', { location: `/login/save-device/?next=${encodeURIComponent(next)}` });
      }
      if (pathname === '/login/save-device') {
        return send(res, 200, 'text/html', page('Save your login info?', '<h1>Save your login info?</h1><div role="button">Save</div><div role="button">Not now</div>'));
      }
      if (pathname === '/api/graphql' && req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        if (form.get('fb_dtsg') !== 'DTSG-TOKEN') return send(res, 200, 'application/json', JSON.stringify({ errors: [{ message: 'Please try closing and re-opening your browser window.', summary: 'Session expired', code: 1357001 }] }));
        if (!loggedIn(req)) return send(res, 200, 'application/json', JSON.stringify({ errors: [{ message: 'login required', summary: 'Not logged in', code: 1357004 }] }));
        const name = form.get('fb_api_req_friendly_name') ?? '';
        const variables = JSON.parse(form.get('variables') ?? '{}') as Record<string, unknown>;
        if (name === 'GroupsCometFeedRegularStoriesPaginationQuery') {
          const from = Number(String(variables.cursor ?? 'c:0').replace('c:', ''));
          const count = Math.min(Number(variables.count) || pageSize, 25);
          calls.feedPages++;
          if (options.failFeedRequest?.({ from, count, nth: calls.feedPages })) {
            return send(res, 200, 'application/json', JSON.stringify({ data: null, errors: [{ message: 'Rate limited', summary: 'Rate limited', code: 1675004 }] }));
          }
          // Facebook streams a second, deferred document after the main one; mimic that.
          return send(res, 200, 'application/json', `${JSON.stringify(feedDoc(from, count))}\n${JSON.stringify({ label: 'deferred', path: ['node'], data: { extra: true } })}`);
        }
        if (name === 'CommentsListComponentsPaginationQuery') {
          calls.comments++;
          const post = options.posts.find((entry) => b64(`feedback:${entry.id}`) === variables.id);
          if (!post) return send(res, 200, 'application/json', JSON.stringify({ data: null, errors: [{ summary: 'Unknown feedback' }] }));
          const all = post.comments.map((_, index) => commentNode(post, index));
          const nodes = variables.commentsAfterCursor ? all.slice(2) : all.slice(0, 2);
          return send(res, 200, 'application/json', JSON.stringify({ data: { node: { comment_rendering_instance_for_feed_location: { comments: { edges: nodes.map((node) => ({ node })), page_info: { end_cursor: null, has_next_page: false } } } } } }));
        }
        return send(res, 200, 'application/json', JSON.stringify({ data: {} }));
      }
      if (pathname.startsWith(groupPath)) {
        if (!loggedIn(req)) return send(res, 302, 'text/plain', '', { location: `/login/?next=${encodeURIComponent(url.pathname + url.search)}` });
        const thread = /\/posts\/(\d+)$/.exec(pathname);
        if (thread) {
          const post = options.posts.find((entry) => entry.id === thread[1]);
          return post ? send(res, 200, 'text/html', threadPage(post)) : send(res, 404, 'text/html', page('Missing', 'This content is not available.'));
        }
        calls.groupViews++;
        return send(res, 200, 'text/html', feedPage());
      }
      return send(res, 404, 'text/html', page('Not found', 'Nothing here.'));
    } catch (error) {
      send(res, 500, 'text/plain', (error as Error).message);
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      origin = `http://127.0.0.1:${port}`;
      resolve({
        server,
        url: origin,
        calls,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
