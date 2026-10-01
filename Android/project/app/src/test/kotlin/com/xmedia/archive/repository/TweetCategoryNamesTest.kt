package com.xmedia.archive.repository

import org.junit.Assert.assertEquals
import org.junit.Test

class TweetCategoryNamesTest {
    @Test
    fun trimsNamesAndCountsUnicodeCodePoints() {
        val (name, normalized) = TweetCategoryNames.normalize(" 旅行 😀 ")
        assertEquals("旅行 😀", name)
        assertEquals("旅行 😀", normalized)

        val emojiName = "😀".repeat(30)
        assertEquals(emojiName to emojiName, TweetCategoryNames.normalize(emojiName))
    }

    @Test
    fun rejectsEmptyAndNamesLongerThanThirtyCharacters() {
        listOf("", "   ", "😀".repeat(31), "x".repeat(31)).forEach { value ->
            try {
                TweetCategoryNames.normalize(value)
                throw AssertionError("Expected invalid category name to fail")
            } catch (expected: IllegalArgumentException) {
                assertEquals("分类名需为 1–30 个字符", expected.message)
            }
        }
    }
}
