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
    @Test fun hostedPhotoBoundsTheUserProvidedNameAtTheWorkerLimit() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(extraction))
            val origin = server.url("/").toString().trimEnd('/')
            val name = "Product ".repeat(50)
            repository(origin).check(CheckInput(name = name), listOf(PreparedPhoto(byteArrayOf(1))),
                AppSettings(connection = "hosted", baseUrl = origin, model = "gpt-6-luna"), token)
            assertEquals(name.take(300), JSONObject(server.takeRequest().body.readUtf8()).getString("name"))
        }
        assertFalse(extractionInputContext(CheckInput(name = " ")).has("name"))
    }
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
    @Test fun hostedCountryContextPreservesFallbackAndExactDatabaseClues() = runBlocking {
        for (automatic in listOf(true, false)) MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(JSONObject().put("product", JSONObject().put("code", "4006381333931")
                .put("product_name", "Oats").put("ingredients_text", "mystery").put("countries_tags", org.json.JSONArray().put("en:sweden"))).toString()))
            server.enqueue(MockResponse().setBody(extraction))
            val origin = server.url("/").toString().trimEnd('/')
            val client = CheckRepository.defaultHttpClient().newBuilder().addInterceptor { chain ->
                chain.proceed(chain.request().newBuilder().url(server.url(chain.request().url.encodedPath)).build())
            }.build()
            CheckRepository(Evaluator(JSONObject(File(root, "data/rules.json").readText())), "test instructions", client,
                hostedBaseUrl = origin).check(CheckInput(category = "food", market = "DE", autoMarket = automatic, barcode = "4006381333931"),
                listOf(PreparedPhoto(byteArrayOf(1))), AppSettings(connection = "hosted", baseUrl = origin, model = "gpt-6-luna"), token)
            server.takeRequest()
            val payload = JSONObject(server.takeRequest().body.readUtf8())
            assertEquals(if (automatic) "SE" else "DE", payload.getString("market"))
            if (automatic) {
                assertEquals("DE", payload.getJSONObject("countryContext").getString("fallbackMarket"))
                assertEquals("SE", payload.getJSONObject("countryContext").getJSONArray("markets").getString(0))
            } else assertFalse(payload.has("countryContext"))
            assertFalse(payload.has("autoMarket"))
            assertEquals(2, server.requestCount)
        }
    }
    @Test fun hostedResearchForAnotherCountryCannotOverrideLocalBarcodeClues() = runBlocking {
        MockWebServer().use { server ->
            val source = "https://maker.example/oats"
            val response = JSONObject(extraction).put("text", "Ingredients: mystery").put("ingredients", org.json.JSONArray().put("mystery"))
                .put("barcode", "4006381333931").put("packaging", JSONObject().put("country", "SE"))
                .put("research", JSONObject().put("searched", true).put("market", "SE")
                    .put("sources", org.json.JSONArray().put(JSONObject().put("url", source).put("title", "Oats"))))
                .put("ingredientAssessments", org.json.JSONArray().put(JSONObject().put("term", "mystery").put("status", "plant").put("explanation", "Swedish formula")))
                .put("webClaims", org.json.JSONArray().put(JSONObject().put("url", source).put("quote", "Oats are vegan.")
                    .put("claim", "vegan").put("sourceType", "manufacturer").put("productName", "Oats").put("brand", "Maker")))
            response.put("contact", JSONObject().put("productName", "Oats").put("brand", "Maker")
                .put("sourceUrl", source).put("url", source).put("email", "sweden@maker.example"))
            server.enqueue(MockResponse().setBody(response.toString()))
            server.enqueue(MockResponse().setBody(JSONObject().put("product", JSONObject().put("code", "4006381333931")
                .put("product_name", "Oats").put("ingredients_text", "mystery").put("countries_tags", org.json.JSONArray().put("en:germany"))).toString()))
            val origin = server.url("/").toString().trimEnd('/')
            val client = CheckRepository.defaultHttpClient().newBuilder().addInterceptor { chain ->
                chain.proceed(chain.request().newBuilder().url(server.url(chain.request().url.encodedPath)).build())
            }.build()
            val result = CheckRepository(Evaluator(JSONObject(File(root, "data/rules.json").readText())), "test instructions", client,
                hostedBaseUrl = origin).check(CheckInput(category = "food", market = "DE", autoMarket = true),
                listOf(PreparedPhoto(byteArrayOf(1))), AppSettings(connection = "hosted", baseUrl = origin, model = "gpt-6-luna"), token)
            assertEquals(2, server.requestCount)
            assertEquals("DE", result.getJSONObject("identity").getString("market"))
            assertEquals("fallback", result.getJSONObject("identity").getString("marketSource"))
            assertEquals("uncertain", result.getString("outcome"))
            assertTrue(result.getJSONArray("warnings").toString().contains("Web research used a different product country"))
            val evidence = result.getJSONArray("evidence")
            assertTrue((0 until evidence.length()).any { evidence.getJSONObject(it).optString("kind") == "ai_extraction" && evidence.getJSONObject(it).optString("excerpt") == "Ingredients: mystery" })
            assertFalse(result.getJSONArray("findings").toString().contains("Swedish formula"))
            assertFalse(result.has("manufacturerContact"))
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
    @Test fun hostedTextAtClientLimitAcceptsTheFullTranscription() = runBlocking {
        MockWebServer().use { server ->
            val text = "unknown additive ".repeat(2000).take(30_000)
            server.enqueue(MockResponse().setBody(JSONObject(extraction).put("text", text).put("ingredients", org.json.JSONArray()).toString()))
            val origin = server.url("/").toString().trimEnd('/')
            val result = repository(origin).check(CheckInput(text, "food", complete = true), emptyList(),
                AppSettings(connection = "hosted", baseUrl = origin, model = "gpt-6-luna"), token)
            assertEquals("text", result.getString("aiStatus"))
            assertEquals("uncertain", result.getString("outcome"))
            assertEquals(text, JSONObject(server.takeRequest().body.readUtf8()).getString("text"))
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
                hosted.forAnalysis(origin, "gpt-6-luna", connected = true), token)
            assertEquals("images", result.getString("aiStatus"))
            assertEquals("/api/check", server.takeRequest().path)
            assertEquals(api.baseUrl, hosted.baseUrl)
            assertEquals(api.model, hosted.model)
            assertEquals(api, hosted.copy(connection = "api").forAnalysis(origin, "gpt-6-luna", connected = true))
        }
    }
    @Test fun quotaFailureKeepsLocalEvidenceAndSafeError() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(429).setBody("""{"error":{"code":"usage_limit_reached","message":"Private server details"}}"""))
            val origin = server.url("/").toString().trimEnd('/')
            val result = repository(origin).check(CheckInput("unknown additive", "food", locale = "de"), emptyList(),
                AppSettings(connection = "hosted", baseUrl = origin, model = "gpt-6-luna"), token)
            assertEquals("failed", result.getString("aiStatus"))
            assertEquals("quota", result.getJSONObject("aiError").getString("code"))
            assertTrue(result.getJSONObject("aiError").getString("message").contains("Mitternacht UTC"))
            assertFalse(result.getJSONObject("aiError").getString("message").contains("ChatGPT"))
            assertFalse(result.toString().contains("Private server details"))
        }
    }
    @Test fun firstCheckWithThreePhotosReportsTemporaryHostedThrottling() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(429).setBody("""{"error":{"code":"rate_limit_exceeded","message":"Private server details"}}"""))
            val origin = server.url("/").toString().trimEnd('/')
            val result = repository(origin).check(CheckInput(locale = "de"), List(3) { PreparedPhoto(byteArrayOf(1)) },
                AppSettings(connection = "hosted", baseUrl = origin, model = "gpt-6-luna"), token)
            assertEquals("failed", result.getString("aiStatus"))
            assertEquals("rate_limit", result.getJSONObject("aiError").getString("code"))
            assertTrue(result.getJSONObject("aiError").getString("message").contains("Vegsnap"))
            assertTrue(result.getJSONObject("aiError").getString("message").contains("Minute"))
            assertEquals(1, server.requestCount)
            assertEquals(3, JSONObject(server.takeRequest().body.readUtf8()).getJSONArray("images").length())
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
    @Test fun disabledServiceRetainsSessionAndReportsUnavailableUntilReenabled() = runBlocking {
        MockWebServer().use { server ->
            val connection = HostedAIConnection(server.url("/").toString().trimEnd('/'), "gpt-6-luna")
            for (enabled in listOf(false, true)) {
                server.enqueue(MockResponse().setBody("""{"state":"connected","remaining":3,"expiresAt":1791561600000,"enabled":$enabled}"""))
                val status = connection.status(token)
                assertEquals("connected", status.state)
                assertEquals(enabled, status.enabled)
                assertEquals(3, status.remaining)
                assertEquals("Bearer $token", server.takeRequest().getHeader("Authorization"))
            }
        }
    }
}
