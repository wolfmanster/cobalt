import { describe, expect, it, vi } from 'vitest';
import { XPostResolver } from './x-post-resolver.js';
import type { XSession } from './x-session-store.js';

const session: XSession = { authToken: 'auth-token-private-123', csrfToken: 'csrf-token-private-456' };
const id = '1234567890123456789';

function resolvedTweet(media: unknown[], protectedAccount = false) {
  return {
    __typename: 'Tweet',
    legacy: {
      full_text: 'Protected post text', lang: 'en', created_at: '2026-01-01T00:00:00.000Z',
      extended_entities: { media },
    },
    core: { user_results: { result: {
      rest_id: '42',
      legacy: { id_str: '42', screen_name: 'example', name: 'Example Author', protected: protectedAccount, profile_image_url_https: 'https://pbs.twimg.com/profile_images/avatar_normal.jpg' },
    } } },
  };
}

function tweetResponse(tweet: Record<string, unknown>) {
  return new Response(JSON.stringify({
    data: { threaded_conversation_with_injections_v2: { instructions: [{ entries: [{
      entryId: `tweet-${id}`, content: { itemContent: { tweet_results: { result: tweet } } },
    }] }] } },
  }), { headers: { 'content-type': 'application/json' } });
}

function unavailable(reason: string) {
  return tweetResponse({ __typename: 'TweetUnavailable', result: { reason } });
}

function video(type: string, url: string, bitrate = 0, audio_bitrate?: number) {
  return { content_type: type, url, bitrate, audio_bitrate };
}

function media(type: string, path: string) {
  return { type, media_url_https: `https://pbs.twimg.com/${path}` };
}

function setup(responder: (url: URL, init: RequestInit, index: number) => Response | Promise<Response>, saved?: XSession) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const sessions = {
    available: true,
    get: vi.fn(async () => saved),
  };
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push({ url, init });
    return responder(url, init, calls.length - 1);
  };
  return { resolver: new XPostResolver(sessions, fetcher), calls, sessions };
}

describe('X GraphQL fallback', () => {
  it('resolves a public photo, MP4 video, and animated GIF without an account cookie', async () => {
    const variants = [
      video('application/x-mpegURL', 'https://video.twimg.com/ext_tw_video/1/pu/pl/playlist.m3u8'),
      video('video/mp4', 'https://video.twimg.com/ext_tw_video/1/pu/vid/640x360/a.mp4', 832000),
      video('video/mp4', 'https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/b.mp4', 2176000),
      video('video/mp4', 'https://video.twimg.com/ext_tw_video/1/pu/vid/no-size.mp4', 4000000),
    ];
    const { resolver, calls, sessions } = setup((url) => url.pathname.includes('/guest/activate')
      ? Response.json({ guest_token: 'guest-value' })
      : tweetResponse(resolvedTweet([
        media('photo', 'media/one.jpg?name=small'),
        { type: 'video', video_info: { variants } },
        { type: 'animated_gif', video_info: { variants: [video('video/mp4', 'https://video.twimg.com/ext_tw_video/2/pu/vid/480x480/gif.mp4', 1000000)] } },
      ])));

    const result = await resolver.resolveFallback(id);

    expect(result.metadata).toMatchObject({ authorName: 'Example Author', username: 'example', userId: '42', text: 'Protected post text' });
    expect(result.metadata.avatarUrl).toContain('avatar_400x400.jpg');
    expect(result.media.map((item) => [item.kind, item.filename])).toEqual([
      ['image', `x_${id}_1.jpg`], ['video', `x_${id}_2.mp4`], ['video', `x_${id}_3.mp4`],
    ]);
    expect(result.media[0]?.sourceUrl).toContain('name=orig');
    expect(result.media[1]?.sourceUrl).toContain('/1280x720/');
    expect(calls.filter(({ url }) => url.pathname.includes('/graphql/'))).toHaveLength(1);
    expect(new Headers(calls[1]?.init.headers).get('cookie')).toContain('guest_id=');
    expect(new Headers(calls[1]?.init.headers).get('cookie')).not.toContain('auth_token');
    expect(calls[1]?.init.redirect).toBe('manual');
    expect(sessions.get).not.toHaveBeenCalled();
  });

  it('retries a protected post with the saved session only on X GraphQL', async () => {
    const { resolver, calls, sessions } = setup((url, init) => {
      if (url.pathname.includes('/guest/activate')) return Response.json({ guest_token: 'guest-value' });
      if (!new Headers(init.headers).has('x-twitter-auth-type')) return unavailable('Protected');
      return tweetResponse(resolvedTweet([media('photo', 'media/private.jpg')], true));
    }, session);

    const result = await resolver.resolveFallback(id);
    const requests = calls.filter(({ url }) => url.pathname.includes('/graphql/'));
    const guestCookie = new Headers(requests[0]?.init.headers).get('cookie') ?? '';
    const authCookie = new Headers(requests[1]?.init.headers).get('cookie') ?? '';

    expect(result.media).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(guestCookie).toContain('guest_id=');
    expect(guestCookie).not.toContain(session.authToken);
    expect(authCookie).toContain(`auth_token=${session.authToken}`);
    expect(authCookie).toContain(`ct0=${session.csrfToken}`);
    expect(new Headers(calls[0]?.init.headers).has('cookie')).toBe(false);
    expect(sessions.get).toHaveBeenCalledTimes(1);
    expect(requests.every(({ init }) => init.redirect === 'manual')).toBe(true);
  });

  it('classifies an account that cannot view the protected post', async () => {
    const { resolver } = setup((url, init) => url.pathname.includes('/guest/activate')
      ? Response.json({ guest_token: 'guest-value' })
      : unavailable('Protected'), session);
    await expect(resolver.resolveFallback(id)).rejects.toThrow('当前 X 账号无权查看');
  });

  it('classifies an expired session and a guest rate limit', async () => {
    const expired = setup((url, init) => {
      if (url.pathname.includes('/guest/activate')) return Response.json({ guest_token: `guest-${Math.random()}` });
      if (!new Headers(init.headers).has('x-twitter-auth-type')) return unavailable('NsfwLoggedOut');
      return new Response('', { status: 401 });
    }, session);
    await expect(expired.resolver.resolveFallback(id)).rejects.toThrow('无效或已过期');

    let graphCalls = 0;
    const limited = setup((url) => {
      if (url.pathname.includes('/guest/activate')) return Response.json({ guest_token: `guest-${++graphCalls}` });
      graphCalls += 1;
      return new Response('', { status: 429 });
    }, session);
    await expect(limited.resolver.resolveFallback(id)).rejects.toThrow('请求过于频繁');
    expect(limited.sessions.get).not.toHaveBeenCalled();

    let guestCalls = 0;
    const limitedRefreshFailure = setup((url) => {
      if (url.pathname.includes('/guest/activate')) {
        guestCalls += 1;
        return guestCalls === 1 ? Response.json({ guest_token: 'guest-value' }) : new Response('', { status: 503 });
      }
      return new Response('', { status: 429 });
    }, session);
    await expect(limitedRefreshFailure.resolver.resolveFallback(id)).rejects.toThrow('请求过于频繁');
    expect(limitedRefreshFailure.sessions.get).not.toHaveBeenCalled();
  });

  it('stops an authenticated GraphQL redirect without forwarding its Cookie', async () => {
    const { resolver, calls } = setup((url, init) => {
      if (url.pathname.includes('/guest/activate')) return Response.json({ guest_token: 'guest-value' });
      if (!new Headers(init.headers).has('x-twitter-auth-type')) return unavailable('Protected');
      return new Response('', { status: 302, headers: { location: 'https://collector.example/steal' } });
    }, session);

    await expect(resolver.resolveFallback(id)).rejects.toThrow('重定向');
    expect(calls.some(({ url }) => url.hostname === 'collector.example')).toBe(false);
    const authenticated = calls.at(-1);
    expect(authenticated?.url.hostname).toBe('api.x.com');
    expect(authenticated?.init.redirect).toBe('manual');
    expect(new Headers(authenticated?.init.headers).get('cookie')).toContain(session.authToken);
  });
});
