package app.vegsnap

import java.net.URI
import java.net.URLDecoder
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CommunityRepliesTest {
    @Test fun prefillIncludesOnlyIdentityAndLanguageWithoutChangingHistory() {
        val result = JSONObject().put("identity", JSONObject().put("name", "Oat & drink").put("brand", "Maker")
            .put("barcode", "3017620422003").put("market", "SE"))
            .put("photos", "private photo").put("questions", "private question").put("outcome", "vegan")
        val before = result.toString()
        val links = requireNotNull(communityLinks(result, "sv", "https://community.example/path"))
        val url = URI(links.submit)
        assertEquals("/submit", url.path); assertNull(url.query)
        val params = url.rawFragment.split('&').associate { val pair = it.split('=', limit = 2); pair[0] to URLDecoder.decode(pair[1], "UTF-8") }
        assertEquals(setOf("name", "brand", "barcode", "market", "lang"), params.keys)
        assertEquals("Oat & drink", params["name"]); assertEquals("sv", params["lang"])
        assertEquals(before, result.toString()); assertFalse(links.replies.contains("private"))
    }
    @Test fun unavailableAndUnsafeServicesDoNotCreateActions() {
        for (url in listOf("", "http://community.example", "https://127.0.0.1/", "https://user:secret@community.example/"))
            assertNull(communityLinks(JSONObject(), "en", url))
        assertTrue(requireNotNull(communityLinks(JSONObject(), "fr", "https://community.example")).submit.endsWith("lang=en"))
    }
}
