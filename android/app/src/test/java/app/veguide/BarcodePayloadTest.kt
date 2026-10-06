package app.veguide

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.concurrent.TimeUnit

class BarcodePayloadTest {
    private val root = File(requireNotNull(System.getProperty("veguide.repo")))
    private val barcode = "4006381333931"
    private fun repository(server: MockWebServer): CheckRepository {
        var clock = 0L
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val original = chain.request()
            chain.proceed(original.newBuilder().url(server.url(original.url.encodedPath + (original.url.encodedQuery?.let { "?$it" } ?: ""))).build())
        }.build()
        return CheckRepository(Evaluator(JSONObject(File(root, "data/rules.json").readText())),
            JSONObject(File(root, "contracts/ai-extraction-prompt.json").readText()).getString("prompt"), http = http,
            productRequests = OpenFactsProductRequests(now = { clock }, wait = { clock += it }))
    }
    private fun product(ingredients: String? = null, code: String = barcode) = MockResponse().setHeader("Content-Type", "application/json")
        .setBody(JSONObject().put("product", JSONObject().put("code", code).put("product_name", "Test product")
            .put("countries_tags", JSONArray().put("en:sweden")).apply { ingredients?.let { put("ingredients_text", it) } }).toString())

    @Test fun passiveIdentityOnlyMatchRemainsUncertainAndDoesNotInvokeAi() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(product())
            val result = requireNotNull(repository(server).lookupBarcode(CheckInput(category = "food", barcode = barcode)))
            assertEquals(1, server.requestCount)
            assertEquals("uncertain", result.getString("outcome"))
            assertEquals("Test product", result.getString("title"))
            assertEquals(barcode, result.getJSONObject("identity").getString("barcode"))
            assertFalse(result.getBoolean("usedAI"))
            assertEquals(0, result.getJSONArray("findings").length())
            val evidence = result.getJSONArray("evidence").getJSONObject(0)
            assertEquals("database", evidence.getString("kind"))
            assertFalse(evidence.has("differentMarket"))
            val request = requireNotNull(server.takeRequest(1, TimeUnit.SECONDS))
            assertEquals("GET", request.method)
            assertEquals(0L, request.bodySize)
            assertNull(request.getHeader("Authorization"))
        }
    }

    @Test fun passiveDatabaseMatchUsesActualAnimalEvidenceAndRejectsDifferentProduct() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(product("milk, water"))
            val result = requireNotNull(repository(server).lookupBarcode(CheckInput(category = "food", barcode = barcode)))
            assertEquals("not_vegan", result.getString("outcome"))
            assertFalse(result.getBoolean("usedAI"))
            server.enqueue(product("water", code = "5901234123457"))
            try {
                repository(server).lookupBarcode(CheckInput(category = "food", barcode = barcode))
                fail("A different product must never be accepted")
            } catch (expected: java.io.IOException) { assertEquals("Product identity mismatch", expected.message) }
        }
    }

    @Test fun selectedNameAndBarcodeReachBothOpenAiResponsesAndCompatibleVisionRequests() = runBlocking {
        for (official in listOf(false, true)) MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(404))
            val extraction = """{"text":"","complete":false,"category":"food","name":"Test product"}"""
            val response = if (official) JSONObject().put("status", "completed").put("output", JSONArray().put(
                JSONObject().put("type", "message").put("content", JSONArray().put(JSONObject().put("type", "output_text").put("text", extraction)))))
            else JSONObject().put("choices", JSONArray().put(JSONObject().put("finish_reason", "stop").put("message", JSONObject().put("content", extraction))))
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(response.toString()))
            val result = repository(server).check(CheckInput(category = "food", name = "Selected name", barcode = barcode), listOf(PreparedPhoto(byteArrayOf(1, 2, 3))),
                AppSettings(connection = "api", aiEnabled = true, model = "vision", baseUrl = if (official) "https://api.openai.com/v1" else server.url("/v1").toString()), "")
            assertEquals("images", result.getString("aiStatus"))
            assertEquals(2, server.requestCount)
            assertEquals("GET", server.takeRequest(1, TimeUnit.SECONDS)?.method)
            val request = requireNotNull(server.takeRequest(1, TimeUnit.SECONDS))
            assertEquals(if (official) "/v1/responses" else "/v1/chat/completions", request.path)
            val body = JSONObject(request.body.readUtf8())
            val content = if (official) body.getJSONArray("input").getJSONObject(0).getJSONArray("content")
                else body.getJSONArray("messages").getJSONObject(1).getJSONArray("content")
            val context = JSONObject(content.getJSONObject(0).getString("text"))
            assertEquals(barcode, context.getString("barcode"))
            assertEquals("Selected name", context.getString("name"))
            assertEquals(2, content.length())
            val image = if (official) content.getJSONObject(1).getString("image_url") else content.getJSONObject(1).getJSONObject("image_url").getString("url")
            assertEquals("data:image/jpeg;base64,AQID", image)
        }
    }

    @Test fun malformedBarcodeIsNotAddedToProviderContext() {
        assertFalse(extractionInputContext(CheckInput(barcode = "not a barcode")).has("barcode"))
        assertEquals(barcode, extractionInputContext(CheckInput(barcode = barcode)).getString("barcode"))
    }
}
