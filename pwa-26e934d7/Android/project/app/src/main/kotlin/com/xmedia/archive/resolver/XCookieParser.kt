package com.xmedia.archive.resolver

/** Extracts only the two X session cookies required by authenticated GraphQL calls. */
internal fun xAuthSessionFromCookieHeaders(headers: Iterable<String?>): XAuthSession? {
    val values = mutableMapOf<String, String>()
    headers.filterNotNull().forEach { header ->
        header.split(';').forEach { part ->
            val separator = part.indexOf('=')
            if (separator <= 0) return@forEach
            val name = part.substring(0, separator).trim()
            if (name == "auth_token" || name == "ct0") {
                values[name] = part.substring(separator + 1).trim()
            }
        }
    }
    val authToken = values["auth_token"]?.takeIf(String::isNotBlank) ?: return null
    val csrfToken = values["ct0"]?.takeIf(String::isNotBlank) ?: return null
    return XAuthSession(authToken, csrfToken)
}
