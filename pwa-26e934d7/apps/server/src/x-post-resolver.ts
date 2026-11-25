import { randomUUID } from 'node:crypto';
import type { MediaItem, PostMetadata } from './types.js';
import type { XSession, XSessionStore } from './x-session-store.js';

const GRAPHQL_URL = 'https://api.x.com/graphql/4Siu98E55GquhG52zHdY5w/TweetDetail';
const GUEST_TOKEN_URL = 'https://api.x.com/1.1/guest/activate.json';
const USER_AGENT = 'Mozilla/5.0 (Android) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36';
const BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const FEATURES = {
  rweb_video_screen_enabled: false, payments_enabled: false, rweb_xchat_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true, rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false, creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false, communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true, responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true, responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true, articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true, graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true, longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true, tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: false, responsive_web_grok_analysis_button_from_backend: true,
  creator_subscriptions_quote_tweet_preview_enabled: false, freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true, tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true, longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true, responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false, responsive_web_enhance_cards_enabled: false,
};
const FIELD_TOGGLES = {
  withArticleRichContentState: true, withArticlePlainText: false, withGrokAnalyze: false,
  withDisallowedReplyControls: false,
};

type Outcome =
  | { kind: 'resolved'; metadata: PostMetadata; media: MediaItem[] }
  | { kind: 'protected' }
  | { kind: 'requires-session' }
  | { kind: 'session-rejected' }
  | { kind: 'rate-limited' }
  | { kind: 'temporary' }
  | { kind: 'redirect' }
  | { kind: 'unavailable' };

interface RawVideoVariant { content_type?: string; url?: string; bitrate?: number; audio_bitrate?: number }
interface RankedVideoVariant { url: string; width: number; height: number; audioBitrate: number; muxedBitrate: number }

/** X GraphQL fallback for posts the public syndication/Cobalt path cannot read. */
export class XPostResolver {
  private cachedGuestToken: string | undefined;

  constructor(private readonly sessions: Pick<XSessionStore, 'available' | 'get'>, private readonly fetcher: typeof fetch = globalThis.fetch) {}

  async resolveFallback(tweetId: string, signal?: AbortSignal): Promise<{ metadata: PostMetadata; media: MediaItem[] }> {
    let outcome = await this.resolveGraphql(tweetId, signal);
    if (outcome.kind === 'protected' || outcome.kind === 'requires-session') {
      return this.resolveWithSession(tweetId, signal, await this.sessions.get());
    }
    if (outcome.kind === 'unavailable' && this.sessions.available) {
      const session = await this.sessions.get();
      if (session) return this.resolveWithSession(tweetId, signal, session);
    }
    return unwrapOutcome(outcome);
  }

  private async resolveWithSession(tweetId: string, signal: AbortSignal | undefined, session: XSession | undefined) {
    if (!session) throw new Error('该帖子需要登录 X；请先配置授权会话');
    const outcome = await this.resolveGraphql(tweetId, signal, session);
    if (outcome.kind === 'protected') throw new Error('当前 X 账号无权查看该受保护帖子');
    if (outcome.kind === 'session-rejected' || outcome.kind === 'requires-session') throw new Error('X 授权会话无效或已过期，请重新登录');
    return unwrapOutcome(outcome);
  }

  private async resolveGraphql(tweetId: string, signal?: AbortSignal, session?: XSession): Promise<Outcome> {
    let token = session ? '' : await this.guestToken(signal);
    if (!session && !token) return { kind: 'unavailable' };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal?.throwIfAborted();
      const url = new URL(GRAPHQL_URL);
      url.searchParams.set('variables', JSON.stringify({
        focalTweetId: tweetId,
        with_rux_injections: false,
        rankingMode: 'Relevance',
        includePromotedContent: true,
        withCommunity: true,
        withQuickPromoteEligibilityTweetFields: true,
        withBirdwatchNotes: true,
        withVoice: true,
      }));
      url.searchParams.set('features', JSON.stringify(FEATURES));
      url.searchParams.set('fieldToggles', JSON.stringify(FIELD_TOGGLES));

      let response: Response;
      try {
        response = await this.fetcher(url, {
          headers: graphqlHeaders(token ?? '', session),
          signal,
          redirect: 'manual',
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        return { kind: 'temporary' };
      }

      if (response.status >= 300 && response.status < 400) return { kind: 'redirect' };
      if (!session && [403, 404, 429].includes(response.status)) {
        if ([403, 429].includes(response.status) && attempt === 0) {
          token = await this.guestToken(signal, true);
          if (token) continue;
          return response.status === 429 ? { kind: 'rate-limited' } : { kind: 'requires-session' };
        }
        return response.status === 429 ? { kind: 'rate-limited' } : { kind: 'requires-session' };
      }
      if (!response.ok) {
        if (session && [401, 403].includes(response.status)) return { kind: 'session-rejected' };
        if (response.status === 429) return { kind: 'rate-limited' };
        if (response.status >= 500) return { kind: 'temporary' };
        return { kind: 'unavailable' };
      }

      let root: Record<string, any>;
      try { root = await response.json() as Record<string, any>; } catch { return { kind: 'unavailable' }; }
      const tweet = findTweetResult(root, tweetId);
      if (!tweet) return { kind: 'unavailable' };
      const unavailable = unavailableOutcome(tweet);
      if (unavailable) return session && unavailable.kind === 'requires-session' ? { kind: 'session-rejected' } : unavailable;

      const base = tweet.__typename === 'TweetWithVisibilityResults' ? tweet.tweet ?? tweet : tweet;
      const legacy = base?.legacy;
      if (!legacy || typeof legacy !== 'object') return { kind: 'unavailable' };
      const mediaSource = legacy.extended_entities?.media ?? legacy.entities?.media;
      const media = parseMedia(mediaSource, tweetId);
      if (!media.length) return { kind: 'unavailable' };

      const user = base.core?.user_results?.result;
      if (!user || typeof user !== 'object') return { kind: 'unavailable' };
      const userLegacy = user.legacy ?? {};
      const userCore = user.core ?? {};
      const username = stringValue(userLegacy.screen_name) || stringValue(userCore.screen_name);
      const userId = stringValue(userLegacy.id_str) || stringValue(user.rest_id);
      const isProtected = userLegacy.protected === true || user.privacy?.protected === true;
      if (isProtected && !session) return { kind: 'protected' };
      if (!username || !userId) return { kind: 'unavailable' };

      const avatar = stringValue(userLegacy.profile_image_url_https) || stringValue(user.avatar?.image_url);
      return {
        kind: 'resolved',
        metadata: {
          authorName: stringValue(userLegacy.name) || stringValue(userCore.name) || username,
          username,
          userId,
          avatarUrl: avatar.replace('_normal.', '_400x400.'),
          text: stringValue(legacy.full_text) || stringValue(legacy.text),
          language: stringValue(legacy.lang) || 'und',
          publishedAt: stringValue(legacy.created_at),
        },
        media,
      };
    }
    return { kind: 'unavailable' };
  }

  private async guestToken(signal?: AbortSignal, forceReload = false): Promise<string | undefined> {
    if (!forceReload && this.cachedGuestToken) return this.cachedGuestToken;
    try {
      const response = await this.fetcher(GUEST_TOKEN_URL, {
        method: 'POST',
        headers: {
          'user-agent': USER_AGENT,
          authorization: BEARER,
          'x-twitter-client-language': 'en',
          'x-twitter-active-user': 'yes',
        },
        signal,
        redirect: 'manual',
      });
      if (!response.ok || (response.status >= 300 && response.status < 400)) return undefined;
      const body = await response.json() as { guest_token?: unknown };
      if (typeof body.guest_token !== 'string' || !body.guest_token) return undefined;
      this.cachedGuestToken = body.guest_token;
      return body.guest_token;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      return undefined;
    }
  }
}

function graphqlHeaders(token: string, session?: XSession): Headers {
  const headers = new Headers({
    'user-agent': USER_AGENT,
    authorization: BEARER,
    'x-twitter-client-language': 'en',
    'x-twitter-active-user': 'yes',
    'accept-language': 'en',
    accept: 'application/json',
    'content-type': 'application/json',
  });
  if (session) {
    headers.set('x-twitter-auth-type', 'OAuth2Session');
    headers.set('x-csrf-token', session.csrfToken);
    headers.set('cookie', `auth_token=${session.authToken}; ct0=${session.csrfToken}`);
  } else {
    headers.set('x-guest-token', token);
    headers.set('cookie', `guest_id=${encodeURIComponent(`v1:${token}`)}`);
  }
  return headers;
}

function findTweetResult(root: Record<string, any>, tweetId: string): Record<string, any> | undefined {
  const entries = root.data?.threaded_conversation_with_injections_v2?.instructions;
  if (!Array.isArray(entries)) return undefined;
  for (const instruction of entries) {
    if (!Array.isArray(instruction?.entries)) continue;
    for (const entry of instruction.entries) {
      if (entry?.entryId !== `tweet-${tweetId}`) continue;
      const result = entry.content?.itemContent?.tweet_results?.result;
      if (result && typeof result === 'object') return result;
    }
  }
  return undefined;
}

function unavailableOutcome(tweet: Record<string, any>): Extract<Outcome, { kind: 'protected' | 'requires-session' | 'unavailable' }> | undefined {
  if (!['TweetUnavailable', 'TweetTombstone'].includes(tweet.__typename)) return undefined;
  if (tweet.result?.reason === 'Protected') return { kind: 'protected' };
  const text = stringValue(tweet.tombstone?.text?.text);
  if (tweet.result?.reason === 'NsfwLoggedOut' || text.startsWith('Age-restricted')) return { kind: 'requires-session' };
  return { kind: 'unavailable' };
}

function parseMedia(items: unknown, tweetId: string): MediaItem[] {
  if (!Array.isArray(items)) return [];
  const result: MediaItem[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || typeof item !== 'object') continue;
    let sourceUrl = '';
    let kind: MediaItem['kind'];
    if (item.type === 'photo') {
      sourceUrl = originalPhotoUrl(stringValue(item.media_url_https));
      kind = 'image';
    } else if (item.type === 'video' || item.type === 'animated_gif') {
      sourceUrl = videoCandidates(item.video_info?.variants)[0] ?? '';
      kind = 'video';
    } else continue;
    if (!sourceUrl) continue;
    const extension = extensionFromUrl(sourceUrl, kind === 'image' ? 'jpg' : 'mp4');
    result.push({
      id: randomUUID(),
      kind,
      filename: `x_${tweetId}_${index + 1}.${extension}`,
      downloadedBytes: 0,
      sourceUrl,
    });
  }
  return result;
}

function originalPhotoUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set('name', 'orig');
    return url.protocol === 'https:' ? url.toString() : '';
  } catch { return ''; }
}

function videoCandidates(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const candidates: RankedVideoVariant[] = [];
  for (const variant of input as RawVideoVariant[]) {
    if (variant.content_type?.split(';', 1)[0]?.trim().toLowerCase() !== 'video/mp4' || !variant.url) continue;
    let url: URL;
    try { url = new URL(variant.url); } catch { continue; }
    if (url.protocol !== 'https:') continue;
    const resolution = videoResolution(url);
    if (!resolution) continue;
    candidates.push({
      url: url.toString(), width: resolution.width, height: resolution.height,
      audioBitrate: Number(variant.audio_bitrate) > 0 ? Number(variant.audio_bitrate) : -1,
      muxedBitrate: Number(variant.bitrate) || 0,
    });
  }
  const highest = candidates.reduce<RankedVideoVariant | undefined>((best, value) =>
    !best || value.height > best.height || (value.height === best.height && value.width > best.width) ? value : best, undefined);
  if (!highest) return [];
  return candidates
    .sort((a, b) => b.height - a.height || b.width - a.width || b.audioBitrate - a.audioBitrate || b.muxedBitrate - a.muxedBitrate)
    .map(({ url }) => url)
    .filter((url, index, all) => all.indexOf(url) === index);
}

function videoResolution(url: URL): { width: number; height: number } | undefined {
  const pattern = /(?<!\d)(\d{2,5})x(\d{2,5})(?!\d)/i;
  let match = pattern.exec(url.pathname);
  if (!match) {
    for (const key of ['resolution', 'dimensions', 'dimension', 'size']) {
      const value = url.searchParams.get(key);
      if (value && (match = pattern.exec(value))) break;
    }
  }
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function extensionFromUrl(rawUrl: string, fallback: string): string {
  try {
    const extension = new URL(rawUrl).pathname.split('.').at(-1)?.toLowerCase();
    return extension && /^[a-z0-9]{2,5}$/.test(extension) ? extension : fallback;
  } catch { return fallback; }
}

function stringValue(value: unknown): string { return typeof value === 'string' ? value : ''; }

function unwrapOutcome(outcome: Outcome): { metadata: PostMetadata; media: MediaItem[] } {
  if (outcome.kind === 'resolved') return { metadata: outcome.metadata, media: outcome.media };
  switch (outcome.kind) {
    case 'protected': throw new Error('当前 X 账号无权查看该受保护帖子');
    case 'requires-session': throw new Error('该帖子需要登录 X；请先配置授权会话');
    case 'session-rejected': throw new Error('X 授权会话无效或已过期，请重新登录');
    case 'rate-limited': throw new Error('X 请求过于频繁，请稍后重试');
    case 'temporary': throw new Error('X 服务暂时不可用，请稍后重试');
    case 'redirect': throw new Error('X 请求发生重定向，已停止请求以保护授权会话');
    default: throw new Error('帖子不存在、不是公开帖子，或暂时无法读取');
  }
}
