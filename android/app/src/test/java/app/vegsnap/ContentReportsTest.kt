package app.vegsnap

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ContentReportsTest {
    private val id = "12345678-1234-4234-8234-123456789abc"
    @Test fun `reports send only reviewed fields without authentication photos or history`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(201).setBody(JSONObject().put("id", id).toString()))
            val report = ContentReport("ai", text = "Reviewed excerpt", reason = "Misleading explanation")
            assertEquals(id, ContentReportsRepository(server.url("/?private=ignored#private")).submit(report))
            val request = server.takeRequest(5, TimeUnit.SECONDS)!!
            assertEquals("/api/reports", request.path)
            assertEquals("POST", request.method)
            assertEquals(setOf("kind", "contentId", "text", "reason"), JSONObject(request.body.readUtf8()).keys().asSequence().toSet())
            for (header in listOf("Authorization", "Cookie", "Referer")) assertNull(request.getHeader(header))
            assertEquals("no-store", request.getHeader("Cache-Control"))
        }
    }
    @Test fun `community reports contain a reference rather than the saved result`() {
        assertEquals("", ContentReport("community", contentId = id, reason = "Personal data").json().getString("text"))
        for (report in listOf(ContentReport("ai", text = "", reason = "Issue"), ContentReport("ai", text = "x", reason = ""),
            ContentReport("community", contentId = "bad", reason = "Issue"), ContentReport("community", contentId = id, text = "private", reason = "Issue"))) {
            try { report.json(); fail("Invalid report accepted") } catch (_: IllegalArgumentException) { }
        }
    }
    @Test fun `redirects malformed acknowledgements and errors do not confirm submission`() = runBlocking {
        MockWebServer().use { server ->
            val repository = ContentReportsRepository(server.url("/"))
            val report = ContentReport("ai", text = "Excerpt", reason = "Issue")
            for (response in listOf(MockResponse().setResponseCode(302).setHeader("Location", server.url("/elsewhere")),
                MockResponse().setResponseCode(503), MockResponse().setResponseCode(201).setBody("{}"),
                MockResponse().setResponseCode(201).setBody("x".repeat(4097)))) {
                server.enqueue(response)
                try { repository.submit(report); fail("Unconfirmed report accepted") } catch (_: Exception) { }
            }
            assertEquals(4, server.requestCount)
        }
    }
}
