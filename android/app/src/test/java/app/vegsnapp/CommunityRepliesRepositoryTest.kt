package app.vegsnapp

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CommunityRepliesRepositoryTest {
    private val lookup = CommunityLookup("Oat & drink", "Maker", "3017620422003", "se")
    private fun reply() = JSONObject().put("id", "12345678-1234-4234-8234-123456789abc")
        .put("productName", "Oat & drink").put("brand", "Maker").put("market", "SE").put("variant", "Vanilla 1 L")
        .put("question", "Is the vitamin D plant derived?").put("reply", "The vitamin D is plant derived.\nOther ingredients were not checked.")
        .put("repliedOn", "2026-01-10").put("claim", "vegan").put("scope", "ingredients")
        .put("reviewedAt", "2026-01-11T12:00:00Z").put("sourceUrl", "https://maker.example/contact").put("evidencePublic", false)
    private fun page(record: JSONObject? = reply(), more: Boolean = false) = JSONObject()
        .put("replies", JSONArray().apply { if (record != null) put(record) }).put("more", more)
    private fun response(value: JSONObject) = MockResponse().setHeader("Content-Type", "application/json").setBody(value.toString())

    @Test fun `explicit lookup sends only canonical GTIN and country and preserves scoped text`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(response(page(more = true)))
            val result = CommunityRepliesRepository(server.url("/")).search(lookup)
            val request = server.takeRequest(5, TimeUnit.SECONDS)!!
            assertEquals("/api/replies", request.requestUrl!!.encodedPath)
            assertEquals(setOf("market", "barcode"), request.requestUrl!!.queryParameterNames)
            assertEquals("03017620422003", request.requestUrl!!.queryParameter("barcode"))
            assertEquals("SE", request.requestUrl!!.queryParameter("market"))
            for (header in listOf("Authorization", "Cookie", "Referer")) assertNull(request.getHeader(header))
            assertEquals("no-store", request.getHeader("Cache-Control"))
            assertNull(request.body.readUtf8().takeIf { it.isNotEmpty() })
            assertEquals("ingredients", result.replies.single().scope)
            assertTrue(result.replies.single().reply.contains('\n'))
            assertFalse(result.replies.single().evidencePublic)
            assertTrue(result.more)
        }
    }
    @Test fun `name search retains exact product and brand identity`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(response(page(null)))
            assertTrue(CommunityRepliesRepository(server.url("/")).search(lookup.copy(barcode = "")).replies.isEmpty())
            val url = server.takeRequest().requestUrl!!
            assertEquals(setOf("market", "name", "brand"), url.queryParameterNames)
            assertEquals("Oat & drink", url.queryParameter("name"))
            assertEquals("Maker", url.queryParameter("brand"))
        }
    }
    @Test fun `invalid identity never reaches the network`() = runBlocking {
        MockWebServer().use { server ->
            val repository = CommunityRepliesRepository(server.url("/"))
            for (invalid in listOf(lookup.copy(market = ""), lookup.copy(market = "Sweden"), lookup.copy(barcode = "3017620422004"), lookup.copy(barcode = "", brand = ""))) {
                try { repository.search(invalid); fail("must reject invalid lookup") } catch (_: IllegalArgumentException) { }
            }
            assertEquals(0, server.requestCount)
        }
    }
    @Test fun `service errors and malformed responses can be retried and do not look empty`() = runBlocking {
        MockWebServer().use { server ->
            val repository = CommunityRepliesRepository(server.url("/"))
            for (failure in listOf(MockResponse().setResponseCode(503), response(JSONObject().put("error", "unavailable")),
                response(page(reply().put("scope", "unknown"))), response(page(reply().put("reviewedAt", "invalid"))))) {
                server.enqueue(failure)
                try { repository.search(lookup); fail("must reject unavailable data") } catch (_: Exception) { }
            }
            server.enqueue(response(page()))
            assertEquals(1, repository.search(lookup).replies.size)
        }
    }
    @Test fun `unsafe source links are omitted and nonpublic evidence stays private`() {
        val result = parseCommunityReplies(page(reply().put("sourceUrl", "javascript:alert(1)")).toString()).replies.single()
        assertNull(result.sourceUrl)
        assertFalse(result.evidencePublic)
    }
    @Test fun `redirects are not followed and cancellation stops the request`() = runBlocking {
        MockWebServer().use { server ->
            val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).build()
            val repository = CommunityRepliesRepository(server.url("/"), http)
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", server.url("/unexpected")))
            try { repository.search(lookup); fail("must reject redirect") } catch (_: java.io.IOException) { }
            assertEquals(1, server.requestCount)
            server.takeRequest()
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            val pending = async { repository.search(lookup) }
            withContext(Dispatchers.IO) { assertNotNull(server.takeRequest(5, TimeUnit.SECONDS)) }
            pending.cancelAndJoin()
            withTimeout(5000) { while (http.dispatcher.runningCallsCount() > 0) delay(10) }
            assertTrue(pending.isCancelled)
        }
    }
}
