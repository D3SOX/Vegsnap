package app.vegsnap

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.concurrent.TimeUnit

class HostedAIFlowTest {
    private val root = File(requireNotNull(System.getProperty("vegsnap.repo")))
    private val extraction = """{"text":"Ingredients: oats","ingredients":["oats"],"complete":true,"category":"food","name":"Oats","brand":"Maker","research":{"searched":false,"sources":[]}}"""
    private val token = "a".repeat(64)
    private fun repository(origin: String) = CheckRepository(Evaluator(JSONObject(File(root, "data/rules.json").readText())),
        "test instructions", hostedBaseUrl = origin)
    @Test fun hostedPhotoUsesProductOnlyEndpointAndDoesNotResearchAgainOnDevice() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(extraction))
            val origin = server.url("/").toString().trimEnd('/')
            val result = repository(origin).check(CheckInput(category = "food"), listOf(PreparedPhoto(byteArrayOf(1))),
                AppSettings(connection = "hosted", baseUrl = origin, model = "gpt-6-luna"), token)
            assertEquals("images", result.getString("aiStatus"))
            assertEquals("not_used", result.getString("webSearchStatus"))
            assertEquals(1, server.requestCount)
            val request = server.takeRequest(1, TimeUnit.SECONDS)!!
            assertEquals("/api/check", request.path)
            assertEquals("Bearer $token", request.getHeader("Authorization"))
            val payload = JSONObject(request.body.readUtf8())
            assertTrue(payload.has("images"))
            assertFalse(payload.has("model"))
            assertFalse(payload.has("instructions"))
            assertFalse(payload.has("complete"))
        }
    }
    @Test fun missingHostedSessionKeepsLocalEvidenceWithoutSendingAPhoto() = runBlocking {
        MockWebServer().use { server ->
            val origin = server.url("/").toString().trimEnd('/')
            val result = repository(origin).check(CheckInput("unknown additive", "food"), emptyList(),
                AppSettings(connection = "hosted", baseUrl = origin, model = "gpt-6-luna"), "")
            assertEquals("unconfigured", result.getString("aiStatus"))
            assertEquals(0, server.requestCount)
            assertFalse(result.getBoolean("usedAI"))
        }
    }
    @Test fun clientCannotSendHostedSessionToAnArbitraryEndpoint() = runBlocking {
        MockWebServer().use { server ->
            val result = repository("https://trusted.example").check(CheckInput("unknown additive", "food"), emptyList(),
                AppSettings(connection = "hosted", baseUrl = server.url("/").toString(), model = "gpt-6-luna"), token)
            assertEquals("unconfigured", result.getString("aiStatus"))
            assertEquals(0, server.requestCount)
        }
    }
    @Test fun hostedQueueUsesFixedEndpointWithoutReplacingOwnApiConfiguration() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(extraction))
            val origin = server.url("/").toString().trimEnd('/')
            val api = AppSettings(connection = "api", baseUrl = "https://own-api.example/v1", model = "own-model")
            val hosted = api.copy(connection = "hosted")
            val result = repository(origin).check(CheckInput(category = "food"), listOf(PreparedPhoto(byteArrayOf(1))),
                hosted.forAnalysis(origin, "gpt-6-luna"), token)
            assertEquals("images", result.getString("aiStatus"))
            assertEquals("/api/check", server.takeRequest().path)
            assertEquals(api.baseUrl, hosted.baseUrl)
            assertEquals(api.model, hosted.model)
            assertEquals(api, hosted.copy(connection = "api").forAnalysis(origin, "gpt-6-luna"))
        }
    }
    @Test fun quotaFailureKeepsLocalEvidenceAndSafeError() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(429).setBody("""{"error":{"message":"Private server details"}}"""))
            val origin = server.url("/").toString().trimEnd('/')
            val result = repository(origin).check(CheckInput("unknown additive", "food"), emptyList(),
                AppSettings(connection = "hosted", baseUrl = origin, model = "gpt-6-luna"), token)
            assertEquals("failed", result.getString("aiStatus"))
            assertFalse(result.toString().contains("Private server details"))
        }
    }
    @Test fun browserVerificationUsesEphemeralRandomTokenAndRefreshesAllowance() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(201).setBody("{}"))
            server.enqueue(MockResponse().setBody("""{"state":"connected","remaining":3,"expiresAt":1791561600000,"enabled":true}"""))
            val connection = HostedAIConnection(server.url("/").toString().trimEnd('/'), "gpt-6-luna")
            val issued = connection.connect("b".repeat(64))
            assertTrue(issued.matches(Regex("[a-f0-9]{64}")))
            assertEquals("#token=$issued&client=android", "#" + java.net.URI(connection.browserUrl(issued)).fragment)
            assertEquals(3, connection.status(issued).remaining)
            val connectRequest = server.takeRequest()
            assertEquals("/api/connect", connectRequest.path)
            assertEquals("b".repeat(64), JSONObject(connectRequest.body.readUtf8()).getString("installationId"))
            assertEquals("Bearer $issued", server.takeRequest().getHeader("Authorization"))
        }
    }
    @Test fun appReturnOnlyAcceptsTheFixedHostedRouteWithoutCredentials() {
        assertTrue(isHostedAIAppReturn("vegsnap://ai/complete"))
        listOf(null, "vegsnap://auth/complete", "https://ai/complete", "vegsnap://ai/complete?token=$token",
            "vegsnap://ai/other", "vegsnap://other/complete").forEach { assertFalse(isHostedAIAppReturn(it)) }
    }
}
