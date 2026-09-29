import { describe, expect, it } from 'vitest';
import { embeddedJsonFromHtml, extractComments, extractStories, idFromCommentId, idFromFeedback, idFromStoryId, parseJsonDocuments, toSourcePosts } from './facebook.ts';

const b64 = (value: string) => Buffer.from(value).toString('base64');

const feedResponse = {
  data: {
    node: {
      group_feed: {
        edges: [
          {
            node: {
              __typename: 'Story',
              id: b64('S:_I100001:26371649095819695'),
              post_id: '26371649095819695',
              comet_sections: {
                content: {
                  story: {
                    __typename: 'Story',
                    id: b64('S:_I100001:26371649095819695'),
                    wwwURL: 'https://www.facebook.com/groups/nyuad.room.of.requirement/posts/26371649095819695/',
                    actors: [{ __typename: 'User', name: 'Jordan Fictional' }],
                    message: { text: 'Anyone had Professor Jean Imbs as a capstone mentor?' },
                    attached_story: { __typename: 'Story', post_id: '999', message: { text: 'SHARED POST' } },
                  },
                },
                context_layout: { story: { comet_sections: { metadata: [{ story: { creation_time: 1774915200 } }] } } },
                feedback: {
                  story: {
                    feedback_context: {
                      feedback_target_with_context: {
                        comet_ufi_summary_and_actions_renderer: {
                          feedback: { id: b64('feedback:26371649095819695'), reaction_count: { count: 7 }, comment_rendering_instance: { comments: { total_count: 3 } }, total_comment_count: 3 },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          { node: { __typename: 'Story', id: 'x', comet_sections: { content: { story: { message: { text: 'no id, dropped' } } } } } },
        ],
      },
    },
  },
};

const commentsResponse = {
  data: {
    feedback: {
      comment_rendering_instance_for_feed_location: {
        comments: {
          edges: [
            { node: { __typename: 'Comment', id: b64('comment:26371649095819695_111'), body: { text: 'Yes, he was great.' }, author: { __typename: 'User', name: 'Ruslan B' }, created_time: 1775001600, feedback: { id: b64('feedback:26371649095819695_111') } } },
            { node: { __typename: 'Comment', id: b64('comment:26371649095819695_222'), body: { text: 'Bump' }, author: { name: 'Dana A' }, created_time: 1775088000, comment_parent: { id: b64('comment:26371649095819695_111') } } },
          ],
        },
      },
    },
  },
};

describe('facebook extraction', () => {
  it('decodes the ids Facebook uses', () => {
    expect(idFromFeedback(b64('feedback:123'))).toBe('123');
    expect(idFromStoryId(b64('S:_I1:456'))).toBe('456');
    expect(idFromStoryId('789')).toBe('789');
    expect(idFromCommentId(b64('comment:12_34'))).toBe('12');
    expect(idFromFeedback('not base64!!')).toBe('');
  });

  it('extracts stories, merging nested copies and ignoring shared posts', () => {
    const stories = extractStories(feedResponse, { groupPath: '/groups/nyuad.room.of.requirement' });
    expect(stories).toHaveLength(1);
    expect(stories[0]).toEqual({
      id: '26371649095819695',
      url: 'https://www.facebook.com/groups/nyuad.room.of.requirement/posts/26371649095819695/',
      author: 'Jordan Fictional',
      date: '2026-03-31',
      text: 'Anyone had Professor Jean Imbs as a capstone mentor?',
      reactions: 7,
      commentCount: 3,
    });
  });

  it('extracts comments with their post id and parent', () => {
    const comments = extractComments(commentsResponse);
    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({ author: 'Ruslan B', text: 'Yes, he was great.', date: '2026-04-01', postId: '26371649095819695' });
    expect(comments[1]!.parentId).toBe(b64('comment:26371649095819695_111'));
  });

  it('assembles archive posts', () => {
    const posts = toSourcePosts(extractStories(feedResponse), extractComments(commentsResponse));
    expect(posts[0]!.comments.map((comment) => comment.text)).toEqual(['Yes, he was great.', 'Bump']);
    expect(posts[0]!.commentCount).toBe(3);
    expect(posts[0]!.reactions).toBe(7);
  });

  it('parses multi-document GraphQL bodies and embedded page JSON', () => {
    const body = `${JSON.stringify(feedResponse)}\n{"label":"x","data":{"y":1}}\n/*junk*/`;
    expect(parseJsonDocuments(body)).toHaveLength(2);
    const html = `<html><script type="application/json" data-sjs>${JSON.stringify({ require: [feedResponse] })}</script><script type="application/json">nope</script></html>`;
    const docs = embeddedJsonFromHtml(html);
    expect(docs).toHaveLength(1);
    expect(extractStories(docs)).toHaveLength(1);
  });
});
