package app.vegsnap

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
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
    @Test fun `result reports mirror the shared payload without photos evidence text or history`() {
        val result = JSONObject().put("id", "private-history-id").put("outcome", "not_vegan").put("photos", JSONArray().put("private-photo"))
            .put("identity", JSONObject().put("name", " Oat drink ").put("brand", "Maker").put("barcode", "3017620422003"))
            .put("findings", JSONArray()
                .put(JSONObject().put("term", "milk").put("status", "animal").put("ruleId", "milk").put("explanation", "private explanation").put("evidenceId", "e1"))
                .put(JSONObject().put("term", "oats").put("status", "plant").put("explanation", "private explanation").put("evidenceId", "e2")))
            .put("evidence", JSONArray().put(JSONObject().put("excerpt", "private label text")))
        val details = resultReport(result, "de", "0.2.19")
        val json = ContentReport("result", reason = " Milk is plant based here ", result = details).json()
        assertEquals(setOf("kind", "contentId", "text", "reason", "result"), json.keys().asSequence().toSet())
        assertEquals("Milk is plant based here", json.getString("reason")); assertEquals("", json.getString("text"))
        assertEquals(setOf("product", "brand", "outcome", "findings", "locale", "platform", "appVersion"), details.keys().asSequence().toSet())
        assertEquals("Oat drink", details.getString("product")); assertEquals("Maker", details.getString("brand"))
        assertEquals("not_vegan", details.getString("outcome")); assertEquals("de", details.getString("locale"))
        assertEquals("android", details.getString("platform")); assertEquals("0.2.19", details.getString("appVersion"))
        val findings = details.getJSONArray("findings")
        assertEquals(2, findings.length())
        assertEquals(setOf("term", "status", "ruleId"), findings.getJSONObject(0).keys().asSequence().toSet())
        assertEquals("milk", findings.getJSONObject(0).getString("ruleId")); assertEquals("", findings.getJSONObject(1).getString("ruleId"))
        for (secret in listOf("private", "3017620422003", "explanation", "excerpt")) assertFalse(secret, json.toString().contains(secret))
        for (report in listOf(ContentReport("result", reason = "Issue"), ContentReport("result", text = "private", reason = "Issue", result = details),
            ContentReport("ai", text = "x", reason = "Issue", result = details), ContentReport("community", contentId = id, reason = "Issue", result = details))) {
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
