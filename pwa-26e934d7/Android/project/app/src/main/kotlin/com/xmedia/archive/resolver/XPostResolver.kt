package com.xmedia.archive.resolver

import android.media.MediaExtractor
import android.media.MediaFormat
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import kotlinx.coroutines.CancellationException
import java.net.URI
import java.net.URLDecoder
import java.time.Instant
import java.util.UUID
import kotlin.math.PI

data class ResolvedMetadata(
    val authorName: String,
    val username: String,
    val userId: String,
    val avatarUrl: String,
    val text: String,
    val language: String,
    val publishedAt: String,
)

data class ResolvedMedia(
    val id: String = UUID.randomUUID().toString(),
    val kind: String,
    val filename: String,
    val sourceUrl: String,
    val position: Int,
)

data class ResolvedPost(val tweetId: String, val canonicalUrl: String, val metadata: ResolvedMetadata, val media: List<ResolvedMedia>)

class XPostResolver(
    private val client: OkHttpClient = OkHttpClient(),
    private val audioBitrateResolver: (String) -> Int? = ::readAudioBitrate,
    private val authorizedSession: () -> XAuthSession? = { null },
) {
    // A manually supplied Cookie header is retained by OkHttp on cross-host redirects.
    // GraphQL requests therefore never follow redirects while a session might be attached.
    private val graphqlClient = client.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    fun parseUrl(raw: String): Pair<String, String> {
        val url = URI(raw.trim())
        val host = url.host?.lowercase() ?: throw IllegalArgumentException("链接缺少域名")
        if (host != "x.com" && host != "www.x.com" && host != "twitter.com" && host != "www.twitter.com") {
            throw IllegalArgumentException("仅支持 x.com 或 twitter.com 链接")
        }
        val match = Regex("/(?:[^/]+/)?status/(\\d+)", RegexOption.IGNORE_CASE).find(url.path)
            ?: throw IllegalArgumentException("不是有效的 X 帖子链接")
        val id = match.groupValues[1]
        return id to "https://x.com/i/status/$id"
    }

    fun resolve(tweetId: String, signal: () -> Boolean = { false }): ResolvedPost {
        if (signal()) throw CancellationException("任务已取消")
        try {
            return requestSyndication(tweetId, signal)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            // Protected, age-restricted, or temporarily unavailable posts continue through
            // GraphQL. This keeps public posts cookie-free even when a session is configured.
        }
        return when (val guest = resolveGraphql(tweetId, signal)) {
            is GraphqlOutcome.Resolved -> guest.post
            GraphqlOutcome.Protected, GraphqlOutcome.RequiresSession -> resolveWithSessionOrThrow(tweetId, signal)
            GraphqlOutcome.SessionRejected -> throw IllegalStateException("X 授权会话无效、已过期，或当前账号无权查看该帖子")
            GraphqlOutcome.TemporaryFailure -> throw IllegalStateException("X 服务暂时不可用或请求过于频繁，请稍后重试")
            GraphqlOutcome.Unavailable -> if (authorizedSession() != null) {
                resolveWithSessionOrThrow(tweetId, signal)
            } else {
                throw IllegalStateException("帖子不存在、不是公开帖子，或暂时无法读取")
            }
        }
    }

    private fun resolveWithSessionOrThrow(tweetId: String, signal: () -> Boolean): ResolvedPost {
        val session = authorizedSession()
            ?: throw IllegalStateException("该帖子需要登录 X；请先配置授权会话")
        return when (val authenticated = resolveGraphql(tweetId, signal, session)) {
            is GraphqlOutcome.Resolved -> authenticated.post
            GraphqlOutcome.Protected -> throw IllegalStateException("当前 X 账号无权查看该受保护帖子")
            GraphqlOutcome.SessionRejected, GraphqlOutcome.RequiresSession -> throw IllegalStateException("X 授权会话无效、已过期，或当前账号无权查看该帖子")
            GraphqlOutcome.TemporaryFailure -> throw IllegalStateException("X 服务暂时不可用或请求过于频繁，请稍后重试")
            GraphqlOutcome.Unavailable -> throw IllegalStateException("帖子不存在、已不可用，或暂时无法读取")
        }
    }

    private fun requestSyndication(tweetId: String, signal: () -> Boolean): ResolvedPost {
        if (signal()) throw CancellationException("任务已取消")
        val token = base36((tweetId.toDouble() / 1e15) * PI).replace(Regex("(0+|\\.)"), "")
        val requestUrl = "https://cdn.syndication.twimg.com/tweet-result?id=$tweetId&token=$token&lang=zh-cn"
        val request = Request.Builder().url(requestUrl).header("User-Agent", USER_AGENT).header("Accept", "application/json").build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException("Syndication HTTP ${response.code}")
            if (signal()) throw CancellationException("任务已取消")
            return postFromSyndication(JSONObject(response.body?.string() ?: "{}"), tweetId)
        }
    }

    private fun postFromSyndication(data: JSONObject, tweetId: String): ResolvedPost {
        val user = data.optJSONObject("user") ?: throw IllegalStateException("帖子用户不存在")
        if (user.optBoolean("protected", false)) throw IllegalStateException("不支持私有帖子")
        val username = user.optString("screen_name")
        val userId = user.optString("id_str")
        if (username.isBlank() || userId.isBlank()) throw IllegalStateException("无法读取帖子作者")
        return ResolvedPost(
            tweetId = tweetId,
            canonicalUrl = "https://x.com/i/status/$tweetId",
            metadata = ResolvedMetadata(
                authorName = user.optString("name", username),
                username = username,
                userId = userId,
                avatarUrl = user.optString("profile_image_url_https", "").replace("_normal.", "_400x400."),
                text = data.optString("text", ""),
                language = data.optString("lang", "und"),
                publishedAt = data.optString("created_at", "").let { if (it.isBlank()) "" else runCatching { Instant.parse(it).toString() }.getOrDefault(it) },
            ),
            media = parseMedia(data.optJSONArray("mediaDetails"), tweetId).ifEmpty { throw IllegalStateException("帖子中没有可下载的媒体") },
        )
    }

    private fun resolveGraphql(tweetId: String, signal: () -> Boolean, session: XAuthSession? = null): GraphqlOutcome {
        var token = if (session == null) guestToken() else ""
        if (session == null && token.isNullOrBlank()) return GraphqlOutcome.Unavailable
        repeat(2) { attempt ->
            if (signal()) throw CancellationException("任务已取消")
            val url = GRAPHQL_URL.toHttpUrl().newBuilder()
                .addQueryParameter("variables", JSONObject()
                    .put("focalTweetId", tweetId)
                    .put("with_rux_injections", false)
                    .put("rankingMode", "Relevance")
                    .put("includePromotedContent", true)
                    .put("withCommunity", true)
                    .put("withQuickPromoteEligibilityTweetFields", true)
                    .put("withBirdwatchNotes", true)
                    .put("withVoice", true)
                    .toString())
                .addQueryParameter("features", GRAPHQL_FEATURES)
                .addQueryParameter("fieldToggles", GRAPHQL_FIELD_TOGGLES)
                .build()
            val request = Request.Builder().url(url).headers(graphqlHeaders(token, session)).build()
            graphqlClient.newCall(request).execute().use { response ->
                if (session == null && response.code in setOf(403, 404, 429)) {
                    if (response.code in setOf(403, 429) && attempt == 0) {
                        token = guestToken(forceReload = true) ?: return GraphqlOutcome.RequiresSession
                        return@use
                    }
                    return GraphqlOutcome.RequiresSession
                }
                if (!response.isSuccessful) {
                    if (session != null && response.code in setOf(401, 403)) return GraphqlOutcome.SessionRejected
                    if (response.code == 429 || response.code >= 500) return GraphqlOutcome.TemporaryFailure
                    return GraphqlOutcome.Unavailable
                }
                val root = JSONObject(response.body?.string() ?: "{}")
                val result = findTweetResult(root, tweetId) ?: run {
                    logWarning("TweetDetail response has no focal result: ${graphqlErrorSummary(root)}")
                    return GraphqlOutcome.Unavailable
                }
                unavailableOutcome(result)?.let { outcome ->
                    logWarning("TweetDetail unavailable result: typename=${result.optString("__typename", "missing")}, outcome=$outcome")
                    return if (session != null && outcome == GraphqlOutcome.RequiresSession) GraphqlOutcome.SessionRejected else outcome
                }
                val base = if (result.optString("__typename") == "TweetWithVisibilityResults") result.optJSONObject("tweet") ?: result else result
                val legacy = base.optJSONObject("legacy") ?: run {
                    logGraphqlShape("missing tweet legacy", result, base)
                    return GraphqlOutcome.Unavailable
                }
                val media = legacy.optJSONObject("extended_entities")?.optJSONArray("media")
                    ?: legacy.optJSONObject("entities")?.optJSONArray("media")
                val parsedMedia = parseMedia(media, tweetId)
                if (parsedMedia.isEmpty()) {
                    logGraphqlShape("missing supported media", result, base, legacy)
                    return GraphqlOutcome.Unavailable
                }
                val userResult = base.optJSONObject("core")?.optJSONObject("user_results")?.optJSONObject("result")
                if (userResult == null) {
                    logGraphqlShape("missing user result", result, base)
                    return GraphqlOutcome.Unavailable
                }
                // X is migrating user identity fields from `legacy` to the newer split
                // core/avatar/privacy/rest_id shape. Accept both because TweetDetail may return
                // either shape depending on account and feature switches.
                val userLegacy = userResult.optJSONObject("legacy")
                val userCore = userResult.optJSONObject("core")
                val username = userLegacy?.optString("screen_name").orEmpty()
                    .ifBlank { userCore?.optString("screen_name").orEmpty() }
                val userId = userLegacy?.optString("id_str").orEmpty()
                    .ifBlank { userResult.optString("rest_id") }
                val isProtected = userLegacy?.optBoolean("protected", false) == true ||
                    userResult.optJSONObject("privacy")?.optBoolean("protected", false) == true
                if (isProtected && session == null) return GraphqlOutcome.Protected
                if (username.isBlank() || userId.isBlank()) {
                    logGraphqlShape("missing user identity", result, base, userResult, userLegacy, userCore)
                    return GraphqlOutcome.Unavailable
                }
                return GraphqlOutcome.Resolved(ResolvedPost(tweetId, "https://x.com/i/status/$tweetId", ResolvedMetadata(
                    userLegacy?.optString("name").orEmpty().ifBlank { userCore?.optString("name").orEmpty() }.ifBlank { username },
                    username,
                    userId,
                    userLegacy?.optString("profile_image_url_https").orEmpty()
                        .ifBlank { userResult.optJSONObject("avatar")?.optString("image_url").orEmpty() }
                        .replace("_normal.", "_400x400."),
                    legacy.optString("full_text", legacy.optString("text", "")), legacy.optString("lang", "und"),
                    legacy.optString("created_at", ""),
                ), parsedMedia))
            }
        }
        return GraphqlOutcome.Unavailable
    }

    /** Cobalt-style guest headers by default, or an authenticated X session when supplied. */
    internal fun graphqlHeaders(guestToken: String?, session: XAuthSession?): Headers {
        val headers = Headers.Builder()
            .add("User-Agent", USER_AGENT)
            .add("Authorization", BEARER)
            .add("X-Twitter-Client-Language", "en")
            .add("X-Twitter-Active-User", "yes")
            .add("Accept-Language", "en")
            .add("Accept", "application/json")
            .add("Content-Type", "application/json")
        if (session == null) {
            headers.add("X-Guest-Token", requireNotNull(guestToken))
            headers.add("Cookie", "guest_id=v1:${requireNotNull(guestToken)}")
        } else {
            headers.add("X-Twitter-Auth-Type", "OAuth2Session")
            headers.add("X-Csrf-Token", session.csrfToken)
            headers.add("Cookie", "auth_token=${session.authToken}; ct0=${session.csrfToken}")
        }
        return headers.build()
    }

    private fun unavailableOutcome(result: JSONObject): GraphqlOutcome? {
        if (result.optString("__typename") !in setOf("TweetUnavailable", "TweetTombstone")) return null
        val reason = result.optJSONObject("result")?.optString("reason")
        if (reason == "Protected") return GraphqlOutcome.Protected
        val text = result.optJSONObject("tombstone")?.optJSONObject("text")?.optString("text").orEmpty()
        return if (reason == "NsfwLoggedOut" || text.startsWith("Age-restricted")) GraphqlOutcome.RequiresSession else GraphqlOutcome.Unavailable
    }

    /** Returns only X error codes/messages; response data and session values are never logged. */
    private fun graphqlErrorSummary(root: JSONObject): String {
        val errors = root.optJSONArray("errors") ?: return "no GraphQL errors"
        return buildList {
            for (index in 0 until errors.length()) {
                val error = errors.optJSONObject(index) ?: continue
                val code = error.optString("code", error.optString("kind", "unknown"))
                val message = error.optString("message", "unknown")
                    .replace(Regex("\\s+"), " ")
                    .take(160)
                add("$code: $message")
            }
        }.joinToString(" | ").ifBlank { "empty GraphQL errors" }
    }

    private fun logGraphqlShape(stage: String, vararg objects: JSONObject?) {
        val shapes = objects.mapIndexed { index, value ->
            val keys = value?.keys()?.asSequence()?.toList()?.sorted()?.joinToString(",").orEmpty()
            "$index={${keys.take(600)}}"
        }.joinToString(" ")
        logWarning("TweetDetail $stage: $shapes")
    }

    // android.util.Log is unavailable in local JVM tests; diagnostics must never affect resolving.
    private fun logWarning(message: String) {
        runCatching { Log.w(LOG_TAG, message) }
    }

    private sealed interface GraphqlOutcome {
        data class Resolved(val post: ResolvedPost) : GraphqlOutcome
        data object RequiresSession : GraphqlOutcome
        data object SessionRejected : GraphqlOutcome
        data object TemporaryFailure : GraphqlOutcome
        data object Protected : GraphqlOutcome
        data object Unavailable : GraphqlOutcome
    }

    private fun guestToken(forceReload: Boolean = false): String? {
        if (!forceReload && cachedGuestToken != null) return cachedGuestToken
        val request = Request.Builder().url(GUEST_TOKEN_URL).headers(okhttp3.Headers.headersOf(
            "User-Agent", USER_AGENT, "Authorization", BEARER, "X-Twitter-Client-Language", "en", "X-Twitter-Active-User", "yes",
        )).post(ByteArray(0).toRequestBody(null)).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return null
            return JSONObject(response.body?.string() ?: "{}").optString("guest_token").takeIf(String::isNotBlank)?.also { cachedGuestToken = it }
        }
    }

    private fun findTweetResult(root: JSONObject, tweetId: String): JSONObject? {
        val array = root.optJSONObject("data")?.optJSONObject("threaded_conversation_with_injections_v2")?.optJSONArray("instructions") ?: return null
        for (index in 0 until array.length()) {
            val entries = array.optJSONObject(index)?.optJSONArray("entries") ?: continue
            for (entryIndex in 0 until entries.length()) {
                val entry = entries.optJSONObject(entryIndex) ?: continue
                if (entry.optString("entryId") != "tweet-$tweetId") continue
                return entry.optJSONObject("content")?.optJSONObject("itemContent")?.optJSONObject("tweet_results")?.optJSONObject("result")
            }
        }
        return null
    }

    private fun parseMedia(items: JSONArray?, tweetId: String): List<ResolvedMedia> {
        if (items == null) return emptyList()
        return buildList {
            for (index in 0 until items.length()) {
                val item = items.optJSONObject(index) ?: continue
                val type = item.optString("type")
                val source = when (type) {
                    "photo" -> originalPhotoUrl(item.optString("media_url_https"))
                    "video", "animated_gif" -> videoCandidates(item.optJSONObject("video_info")?.optJSONArray("variants")).firstOrNull().orEmpty()
                    else -> ""
                }
                if (source.isBlank()) continue
                // X serves animated GIFs as MP4 variants. Treat them as video so their
                // MediaStore collection and WebView renderer match the bytes on disk.
                val kind = if (type == "photo") "image" else "video"
                val ext = extension(source, if (kind == "image") "jpg" else "mp4")
                add(ResolvedMedia(kind = kind, filename = "x_${tweetId}_${index + 1}.$ext", sourceUrl = source, position = index))
            }
        }
    }

    /** Requests the original X image instead of the default 1200-pixel rendition. */
    internal fun originalPhotoUrl(rawUrl: String): String {
        if (rawUrl.isBlank()) return ""
        return rawUrl.toHttpUrl().newBuilder()
            .setQueryParameter("name", "orig")
            .build()
            .toString()
    }

    /**
     * Returns only directly downloadable MP4 variants. X also exposes HLS manifests,
     * which cannot be saved as a video file by the foreground downloader.
     */
    internal fun videoCandidates(variants: JSONArray?): List<String> {
        if (variants == null) return emptyList()
        val direct = directVideoVariants(buildList {
            for (index in 0 until variants.length()) {
                val item = variants.optJSONObject(index) ?: continue
                add(RawVideoVariant(
                    item.optString("content_type"),
                    item.optString("url"),
                    item.optInt("bitrate", 0),
                    item.optInt("audio_bitrate", -1).takeIf { it > 0 },
                ))
            }
        })
        val highestResolution = direct.maxWithOrNull(compareBy<VideoVariant> { it.height }.thenBy { it.width }) ?: return emptyList()
        return rankVideoCandidates(direct.map { candidate ->
            if (candidate.height != highestResolution.height || candidate.width != highestResolution.width) candidate
            else candidate.copy(audioBitrate = candidate.audioBitrate ?: audioBitrateResolver(candidate.url))
        })
    }

    /**
     * Keeps only directly downloadable MP4s with a discoverable resolution. Omitting
     * candidates of unknown resolution is intentional: choosing one by bitrate would
     * violate the highest-resolution download policy. These MP4s are muxed; for equal
     * video resolutions, audio bitrate is the primary tie-breaker and muxed bitrate is
     * used only when the audio bitrate cannot distinguish the variants.
     */
    internal fun directVideoCandidates(variants: List<RawVideoVariant>): List<String> {
        return rankVideoCandidates(directVideoVariants(variants))
    }

    internal fun directVideoVariants(variants: List<RawVideoVariant>): List<VideoVariant> = variants.mapNotNull { variant ->
            if (!isDirectMp4Variant(variant.contentType, variant.url)) return@mapNotNull null
            val (width, height) = videoResolution(variant.url) ?: return@mapNotNull null
            VideoVariant(variant.url, width, height, variant.audioBitrate, variant.bitrate)
        }

    internal fun rankVideoCandidates(candidates: List<VideoVariant>): List<String> = candidates
            .sortedWith(compareByDescending<VideoVariant> { it.height }
                .thenByDescending { it.width }
                .thenByDescending { it.audioBitrate ?: -1 }
                .thenByDescending { it.muxedBitrate })
            .map { it.url }
            .distinct()

    internal fun isDirectMp4Variant(contentType: String, url: String): Boolean =
        url.isNotBlank() && contentType.substringBefore(';').trim().equals("video/mp4", ignoreCase = true)

    private fun videoResolution(url: String): Pair<Int, Int>? {
        val uri = runCatching { URI(url) }.getOrNull() ?: return null
        val match = RESOLUTION_PATTERN.find(uri.rawPath.orEmpty())
            ?: namedResolutionQuery(uri.rawQuery)
            ?: return null
        val width = match.groupValues[1].toIntOrNull() ?: return null
        val height = match.groupValues[2].toIntOrNull() ?: return null
        return width to height
    }

    private fun namedResolutionQuery(rawQuery: String?): MatchResult? = rawQuery
        ?.split('&')
        ?.asSequence()
        ?.mapNotNull { entry ->
            val separator = entry.indexOf('=')
            if (separator < 1) return@mapNotNull null
            val name = URLDecoder.decode(entry.substring(0, separator), Charsets.UTF_8.name()).lowercase()
            if (name !in RESOLUTION_QUERY_NAMES) return@mapNotNull null
            RESOLUTION_PATTERN.find(URLDecoder.decode(entry.substring(separator + 1), Charsets.UTF_8.name()))
        }
        ?.firstOrNull()

    internal data class RawVideoVariant(val contentType: String, val url: String, val bitrate: Int, val audioBitrate: Int? = null)
    internal data class VideoVariant(val url: String, val width: Int, val height: Int, val audioBitrate: Int? = null, val muxedBitrate: Int)

    private fun extension(rawUrl: String, fallback: String): String = runCatching {
        URI(rawUrl).path.substringAfterLast('.', fallback).lowercase().takeIf { it.matches(Regex("[a-z0-9]{2,5}")) } ?: fallback
    }.getOrDefault(fallback)

    private fun base36(value: Double): String {
        val integer = value.toLong()
        var fraction = value - integer
        val builder = StringBuilder(integer.toString(36))
        if (fraction > 0) {
            builder.append('.')
            repeat(12) {
                fraction *= 36
                val digit = fraction.toInt()
                builder.append("0123456789abcdefghijklmnopqrstuvwxyz"[digit])
                fraction -= digit
                if (fraction == 0.0) return@repeat
            }
        }
        return builder.toString()
    }

    companion object {
        private const val LOG_TAG = "XPostResolver"
        private const val USER_AGENT = "Mozilla/5.0 (Android) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36"
        private const val GRAPHQL_URL = "https://api.x.com/graphql/4Siu98E55GquhG52zHdY5w/TweetDetail"
        private const val GUEST_TOKEN_URL = "https://api.x.com/1.1/guest/activate.json"
        private const val BEARER = "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
        // Keep this request contract aligned with cobalt's current Twitter resolver. X returns
        // HTTP 200 plus an empty timeline when required feature flags are omitted.
        private const val GRAPHQL_FEATURES = "{\"rweb_video_screen_enabled\":false,\"payments_enabled\":false,\"rweb_xchat_enabled\":false,\"profile_label_improvements_pcf_label_in_post_enabled\":true,\"rweb_tipjar_consumption_enabled\":true,\"verified_phone_label_enabled\":false,\"creator_subscriptions_tweet_preview_api_enabled\":true,\"responsive_web_graphql_timeline_navigation_enabled\":true,\"responsive_web_graphql_skip_user_profile_image_extensions_enabled\":false,\"premium_content_api_read_enabled\":false,\"communities_web_enable_tweet_community_results_fetch\":true,\"c9s_tweet_anatomy_moderator_badge_enabled\":true,\"responsive_web_grok_analyze_button_fetch_trends_enabled\":false,\"responsive_web_grok_analyze_post_followups_enabled\":true,\"responsive_web_jetfuel_frame\":true,\"responsive_web_grok_share_attachment_enabled\":true,\"articles_preview_enabled\":true,\"responsive_web_edit_tweet_api_enabled\":true,\"graphql_is_translatable_rweb_tweet_is_translatable_enabled\":true,\"view_counts_everywhere_api_enabled\":true,\"longform_notetweets_consumption_enabled\":true,\"responsive_web_twitter_article_tweet_consumption_enabled\":true,\"tweet_awards_web_tipping_enabled\":false,\"responsive_web_grok_show_grok_translated_post\":false,\"responsive_web_grok_analysis_button_from_backend\":true,\"creator_subscriptions_quote_tweet_preview_enabled\":false,\"freedom_of_speech_not_reach_fetch_enabled\":true,\"standardized_nudges_misinfo\":true,\"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled\":true,\"longform_notetweets_rich_text_read_enabled\":true,\"longform_notetweets_inline_media_enabled\":true,\"responsive_web_grok_image_annotation_enabled\":true,\"responsive_web_grok_imagine_annotation_enabled\":true,\"responsive_web_grok_community_note_auto_translation_is_enabled\":false,\"responsive_web_enhance_cards_enabled\":false}"
        private const val GRAPHQL_FIELD_TOGGLES = "{\"withArticleRichContentState\":true,\"withArticlePlainText\":false,\"withGrokAnalyze\":false,\"withDisallowedReplyControls\":false}"
        private val RESOLUTION_PATTERN = Regex("(?<!\\d)(\\d{2,5})x(\\d{2,5})(?!\\d)", RegexOption.IGNORE_CASE)
        private val RESOLUTION_QUERY_NAMES = setOf("resolution", "dimensions", "dimension", "size")
        @Volatile private var cachedGuestToken: String? = null

        private fun readAudioBitrate(url: String): Int? = runCatching {
            val extractor = MediaExtractor()
            try {
                extractor.setDataSource(url, mapOf("User-Agent" to USER_AGENT))
                (0 until extractor.trackCount)
                    .map { extractor.getTrackFormat(it) }
                    .filter { format -> format.getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true }
                    .mapNotNull { format -> if (format.containsKey(MediaFormat.KEY_BIT_RATE)) format.getInteger(MediaFormat.KEY_BIT_RATE) else null }
                    .maxOrNull()
            } finally {
                extractor.release()
            }
        }.getOrNull()
    }
}
