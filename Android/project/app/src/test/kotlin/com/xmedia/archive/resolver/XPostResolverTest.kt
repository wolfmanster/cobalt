package com.xmedia.archive.resolver

import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class XPostResolverTest {
    private val resolver = XPostResolver()

    @Test
    fun parsesSupportedPostUrls() {
        assertEquals("123456789", resolver.parseUrl("https://x.com/user/status/123456789").first)
        assertEquals("123456789", resolver.parseUrl("https://twitter.com/i/status/123456789").first)
        assertEquals("https://x.com/i/status/123456789", resolver.parseUrl("https://x.com/user/status/123456789").second)
    }

    @Test
    fun rejectsUnsupportedUrls() {
        assertThrows(IllegalArgumentException::class.java) {
            resolver.parseUrl("https://example.com/user/status/123456789")
        }
        assertThrows(IllegalArgumentException::class.java) {
            resolver.parseUrl("https://x.com/user/post/not-a-number")
        }
    }

    @Test
    fun ranksDirectVariantsByResolutionThenMuxedAudioVideoBitrate() {
        val variants = listOf(
            XPostResolver.VideoVariant("https://video.example/vid/avc1/1280x720/low.mp4", 1280, 720, null, 2_000_000),
            XPostResolver.VideoVariant("https://video.example/vid/avc1/1920x1080/low.mp4", 1920, 1080, 128_000, 3_000_000),
            XPostResolver.VideoVariant("https://video.example/vid/avc1/1920x1080/high.mp4", 1920, 1080, 192_000, 1_000_000),
        )

        assertEquals(
            listOf(
                "https://video.example/vid/avc1/1920x1080/high.mp4",
                "https://video.example/vid/avc1/1920x1080/low.mp4",
                "https://video.example/vid/avc1/1280x720/low.mp4",
            ),
            resolver.rankVideoCandidates(variants),
        )
    }

    @Test
    fun excludesHlsManifestsFromDirectDownloadCandidates() {
        assertTrue(resolver.isDirectMp4Variant("video/mp4", "https://video.example/file.mp4"))
        assertFalse(resolver.isDirectMp4Variant("application/x-mpegURL", "https://video.example/master.m3u8"))
    }

    @Test
    fun usesGuestHeadersWithoutAnAuthorizedSession() {
        val headers = resolver.graphqlHeaders("guest-token", null)

        assertEquals("guest-token", headers["X-Guest-Token"])
        assertEquals("guest_id=v1:guest-token", headers["Cookie"])
        assertEquals(null, headers["X-Csrf-Token"])
        assertEquals(null, headers["X-Twitter-Auth-Type"])
    }

    @Test
    fun usesCobaltStyleSessionHeadersOnlyForAuthorizedRequests() {
        val headers = resolver.graphqlHeaders("guest-token", XAuthSession("auth-value", "csrf-value"))

        assertEquals(null, headers["X-Guest-Token"])
        assertEquals("auth_token=auth-value; ct0=csrf-value", headers["Cookie"])
        assertEquals("csrf-value", headers["X-Csrf-Token"])
        assertEquals("OAuth2Session", headers["X-Twitter-Auth-Type"])
        assertEquals("application/json", headers["Content-Type"])
    }

    @Test
    fun usesTheCurrentCobaltTweetDetailRequestContract() {
        var graphqlRequest: Request? = null
        val resolver = resolverFor { request ->
            when {
                request.url.host == "cdn.syndication.twimg.com" -> jsonResponse(request, "{}", 503)
                request.url.encodedPath.endsWith("guest/activate.json") -> jsonResponse(request, "{\"guest_token\":\"guest-token\"}")
                else -> {
                    graphqlRequest = request
                    jsonResponse(request, resolvedTweet("123"))
                }
            }
        }

        resolver.resolve("123")

        val variables = JSONObject(graphqlRequest?.url?.queryParameter("variables").orEmpty())
        val features = JSONObject(graphqlRequest?.url?.queryParameter("features").orEmpty())
        val fieldToggles = JSONObject(graphqlRequest?.url?.queryParameter("fieldToggles").orEmpty())
        assertTrue(variables.getBoolean("withQuickPromoteEligibilityTweetFields"))
        assertTrue(variables.getBoolean("withBirdwatchNotes"))
        assertTrue(variables.getBoolean("withVoice"))
        assertTrue(features.length() >= 30)
        assertTrue(features.getBoolean("communities_web_enable_tweet_community_results_fetch"))
        assertFalse(features.getBoolean("responsive_web_grok_show_grok_translated_post"))
        assertFalse(fieldToggles.getBoolean("withGrokAnalyze"))
        assertFalse(fieldToggles.getBoolean("withDisallowedReplyControls"))
    }

    @Test
    fun resolvesPublicSyndicationWithoutSendingTheAuthorizedSession() {
        var nonSyndicationRequests = 0
        val resolver = resolverFor { request ->
            if (request.url.host == "cdn.syndication.twimg.com") {
                jsonResponse(request, syndicationTweet())
            } else {
                nonSyndicationRequests += 1
                jsonResponse(request, "{}", 500)
            }
        }

        val post = resolver.resolve("123")

        assertEquals("example", post.metadata.username)
        assertEquals(0, nonSyndicationRequests)
    }

    @Test
    fun retriesLoginRestrictedPostsWithTheAuthorizedSession() {
        var authorizedRequest: Request? = null
        val resolver = resolverFor { request ->
            when {
                request.url.encodedPath.endsWith("guest/activate.json") -> jsonResponse(request, "{\"guest_token\":\"guest-token\"}")
                request.header("X-Twitter-Auth-Type") == "OAuth2Session" -> {
                    authorizedRequest = request
                    jsonResponse(request, resolvedTweet("123"))
                }
                else -> jsonResponse(request, loginRequiredTweet("123"))
            }
        }

        val post = resolver.resolve("123")

        assertEquals("example", post.metadata.username)
        assertEquals("auth_token=auth-value; ct0=csrf-value", authorizedRequest?.header("Cookie"))
        assertEquals("csrf-value", authorizedRequest?.header("X-Csrf-Token"))
    }

    @Test
    fun retriesGuest403404And429WithTheAuthorizedSession() {
        listOf(403, 404, 429).forEach { status ->
            var guestGraphqlRequests = 0
            var authorizedRequests = 0
            val resolver = resolverFor { request ->
                when {
                    request.url.host == "cdn.syndication.twimg.com" -> jsonResponse(request, "{}", 503)
                    request.url.encodedPath.endsWith("guest/activate.json") -> jsonResponse(request, "{\"guest_token\":\"guest-token\"}")
                    request.header("X-Twitter-Auth-Type") == "OAuth2Session" -> {
                        authorizedRequests += 1
                        jsonResponse(request, resolvedTweet("123"))
                    }
                    else -> {
                        guestGraphqlRequests += 1
                        jsonResponse(request, "{}", status)
                    }
                }
            }

            assertEquals("example", resolver.resolve("123").metadata.username)
            assertEquals(if (status == 404) 1 else 2, guestGraphqlRequests)
            assertEquals(1, authorizedRequests)
        }
    }

    @Test
    fun reportsAuthenticatedRateLimitsAsTemporaryFailures() {
        val resolver = resolverFor { request ->
            when {
                request.url.encodedPath.endsWith("guest/activate.json") -> jsonResponse(request, "{\"guest_token\":\"guest-token\"}")
                request.header("X-Twitter-Auth-Type") == "OAuth2Session" -> jsonResponse(request, "{}", 429)
                else -> jsonResponse(request, loginRequiredTweet("123"))
            }
        }

        val error = assertThrows(IllegalStateException::class.java) { resolver.resolve("123") }

        assertTrue(error.message.orEmpty().contains("稍后重试"))
    }

    @Test
    fun doesNotFollowRedirectsForAuthenticatedGraphqlRequests() {
        var redirectedRequest: Request? = null
        val resolver = resolverFor { request ->
            when {
                request.url.encodedPath.endsWith("guest/activate.json") -> jsonResponse(request, "{\"guest_token\":\"guest-token\"}")
                request.url.host == "capture.example" -> {
                    redirectedRequest = request
                    jsonResponse(request, "{}")
                }
                request.header("X-Twitter-Auth-Type") == "OAuth2Session" -> redirectResponse(request, "https://capture.example/collect")
                else -> jsonResponse(request, loginRequiredTweet("123"))
            }
        }

        assertThrows(IllegalStateException::class.java) { resolver.resolve("123") }

        assertEquals(null, redirectedRequest)
    }

    @Test
    fun retriesProtectedPostsAndAllowsThemForAnAuthorizedFollower() {
        var authorizedRequestMade = false
        val resolver = resolverFor { request ->
            when {
                request.url.encodedPath.endsWith("guest/activate.json") -> jsonResponse(request, "{\"guest_token\":\"guest-token\"}")
                request.header("X-Twitter-Auth-Type") == "OAuth2Session" -> {
                    authorizedRequestMade = true
                    jsonResponse(request, resolvedTweet("123", protected = true))
                }
                else -> jsonResponse(request, protectedTweet("123"))
            }
        }

        val post = resolver.resolve("123")

        assertEquals("example", post.metadata.username)
        assertTrue(authorizedRequestMade)
    }

    @Test
    fun parsesTheModernUserShapeForAnAuthorizedProtectedPost() {
        val resolver = resolverFor { request ->
            when {
                request.url.encodedPath.endsWith("guest/activate.json") -> jsonResponse(request, "{\"guest_token\":\"guest-token\"}")
                request.header("X-Twitter-Auth-Type") == "OAuth2Session" -> jsonResponse(request, resolvedTweet("123", protected = true, modernUser = true))
                else -> jsonResponse(request, protectedTweet("123"))
            }
        }

        val post = resolver.resolve("123")

        assertEquals("example", post.metadata.username)
        assertEquals("Example", post.metadata.authorName)
        assertEquals("1", post.metadata.userId)
        assertEquals("https://pbs.twimg.com/profile_400x400.jpg", post.metadata.avatarUrl)
    }

    @Test
    fun retriesAnUnavailableGuestResultWithTheAuthorizedSession() {
        var authorizedRequestMade = false
        val resolver = resolverFor { request ->
            when {
                request.url.encodedPath.endsWith("guest/activate.json") -> jsonResponse(request, "{\"guest_token\":\"guest-token\"}")
                request.header("X-Twitter-Auth-Type") == "OAuth2Session" -> {
                    authorizedRequestMade = true
                    jsonResponse(request, resolvedTweet("123", protected = true))
                }
                else -> jsonResponse(request, tweetEnvelope("123", JSONObject().put("__typename", "TweetUnavailable")))
            }
        }

        assertEquals("example", resolver.resolve("123").metadata.username)
        assertTrue(authorizedRequestMade)
    }

    @Test
    fun preservesCancellationBeforeTheAuthenticatedRetry() {
        val resolver = resolverFor { request ->
            when {
                request.url.encodedPath.endsWith("guest/activate.json") -> jsonResponse(request, "{\"guest_token\":\"guest-token\"}")
                request.header("X-Twitter-Auth-Type") == "OAuth2Session" -> jsonResponse(request, "{}", 404)
                else -> jsonResponse(request, "{}", 404)
            }
        }
        var checks = 0

        assertThrows(kotlinx.coroutines.CancellationException::class.java) {
            resolver.resolve("123") { ++checks >= 4 }
        }
    }

    @Test
    fun choosesTheHighestResolutionAcrossSupportedUrlFormats() {
        val candidates = listOf(
            XPostResolver.RawVideoVariant("video/mp4; codecs=avc1", "https://video.example/vid_1280x720.mp4", 4_000_000),
            XPostResolver.RawVideoVariant("video/mp4", "https://video.example/file.mp4?resolution=1920x1080", 1_000_000),
            XPostResolver.RawVideoVariant("video/mp4", "https://video.example/no-resolution.mp4", 9_000_000),
            XPostResolver.RawVideoVariant("video/mp4", "https://1920x1080.cdn.example/file.mp4", 10_000_000),
        )

        assertEquals(
            listOf(
                "https://video.example/file.mp4?resolution=1920x1080",
                "https://video.example/vid_1280x720.mp4",
            ),
            resolver.directVideoCandidates(candidates),
        )
    }

    @Test
    fun prefersHigherAudioBitrateBeforeMuxedBitrateAtTheSameResolution() {
        val variants = listOf(
            XPostResolver.RawVideoVariant("video/mp4", "https://video.example/vid/1920x1080/video-heavy.mp4", 5_000_000, 96_000),
            XPostResolver.RawVideoVariant("video/mp4", "https://video.example/vid/1920x1080/audio-best.mp4", 3_000_000, 192_000),
        )

        assertEquals(
            listOf(
                "https://video.example/vid/1920x1080/audio-best.mp4",
                "https://video.example/vid/1920x1080/video-heavy.mp4",
            ),
            resolver.directVideoCandidates(variants),
        )
    }

    private fun resolverFor(responseFor: (Request) -> Response): XPostResolver = XPostResolver(
        client = OkHttpClient.Builder().addInterceptor { chain -> responseFor(chain.request()) }.build(),
        authorizedSession = { XAuthSession("auth-value", "csrf-value") },
    )

    private fun jsonResponse(request: Request, body: String, code: Int = 200): Response = Response.Builder()
        .request(request)
        .protocol(Protocol.HTTP_1_1)
        .code(code)
        .message(if (code in 200..299) "OK" else "Error")
        .body(body.toResponseBody("application/json".toMediaType()))
        .build()

    private fun redirectResponse(request: Request, location: String): Response = Response.Builder()
        .request(request)
        .protocol(Protocol.HTTP_1_1)
        .code(302)
        .message("Found")
        .header("Location", location)
        .body("".toResponseBody("application/json".toMediaType()))
        .build()

    private fun loginRequiredTweet(id: String): String = tweetEnvelope(id, JSONObject()
        .put("__typename", "TweetTombstone")
        .put("result", JSONObject().put("reason", "NsfwLoggedOut")))

    private fun protectedTweet(id: String): String = tweetEnvelope(id, JSONObject()
        .put("__typename", "TweetUnavailable")
        .put("result", JSONObject().put("reason", "Protected")))

    private fun syndicationTweet(): String = JSONObject()
        .put("text", "hello")
        .put("lang", "en")
        .put("created_at", "2025-01-01T00:00:00Z")
        .put("user", JSONObject()
            .put("name", "Example")
            .put("screen_name", "example")
            .put("id_str", "1")
            .put("protected", false)
            .put("profile_image_url_https", ""))
        .put("mediaDetails", JSONArray().put(JSONObject()
            .put("type", "photo")
            .put("media_url_https", "https://pbs.twimg.com/media/example.jpg")))
        .toString()

    private fun resolvedTweet(id: String, protected: Boolean = false, modernUser: Boolean = false): String {
        val user = if (modernUser) JSONObject()
            .put("rest_id", "1")
            .put("core", JSONObject().put("name", "Example").put("screen_name", "example"))
            .put("avatar", JSONObject().put("image_url", "https://pbs.twimg.com/profile_normal.jpg"))
            .put("privacy", JSONObject().put("protected", protected))
        else JSONObject().put("legacy", JSONObject()
            .put("name", "Example")
            .put("screen_name", "example")
            .put("id_str", "1")
            .put("protected", protected)
            .put("profile_image_url_https", ""))
        return tweetEnvelope(id, JSONObject()
            .put("__typename", "Tweet")
            .put("legacy", JSONObject()
                .put("full_text", "hello")
                .put("lang", "en")
                .put("created_at", "2025-01-01T00:00:00Z")
                .put("extended_entities", JSONObject().put("media", JSONArray().put(JSONObject()
                    .put("type", "photo")
                    .put("media_url_https", "https://pbs.twimg.com/media/example.jpg")))))
            .put("core", JSONObject().put("user_results", JSONObject().put("result", user))))
    }

    private fun tweetEnvelope(id: String, result: JSONObject): String {
        val entry = JSONObject()
            .put("entryId", "tweet-$id")
            .put("content", JSONObject().put("itemContent", JSONObject().put("tweet_results", JSONObject().put("result", result))))
        val instructions = JSONArray().put(JSONObject().put("entries", JSONArray().put(entry)))
        return JSONObject()
            .put("data", JSONObject().put("threaded_conversation_with_injections_v2", JSONObject().put("instructions", instructions)))
            .toString()
    }
}
