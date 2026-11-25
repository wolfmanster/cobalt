package com.xmedia.archive.resolver

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class XCookieParserTest {
    @Test
    fun extractsOnlyTheRequiredCookiesAcrossOrigins() {
        val session = xAuthSessionFromCookieHeaders(listOf(
            "guest_id=guest; ct0=csrf-value; personalization_id=ignored",
            "lang=zh; auth_token=auth=value; twid=ignored",
        ))

        assertEquals("auth=value", session?.authToken)
        assertEquals("csrf-value", session?.csrfToken)
    }

    @Test
    fun requiresBothSessionCookies() {
        assertNull(xAuthSessionFromCookieHeaders(listOf("ct0=csrf-value; guest_id=guest")))
        assertNull(xAuthSessionFromCookieHeaders(listOf("auth_token=auth-value")))
    }

    @Test
    fun doesNotAcceptCookieNamesThatOnlyContainTheRequiredNames() {
        assertNull(xAuthSessionFromCookieHeaders(listOf("fake_auth_token=value; ct0_extra=value")))
    }
}
