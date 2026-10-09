package app.vegsnap

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit

class BarcodePayloadTest {
    private val root = File(requireNotNull(System.getProperty("vegsnap.repo")))
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
    private fun product(ingredients: String? = null, code: String = barcode, name: String = "Test product", market: String = "en:germany") = MockResponse().setHeader("Content-Type", "application/json")
        .setBody(JSONObject().put("product", JSONObject().put("code", code).put("product_name", name)
            .put("countries_tags", JSONArray().put(market)).apply { ingredients?.let { put("ingredients_text", it) } }).toString())

    @Test fun canonicalCountryTagsSupportAutomaticAndManualBarcodeLookup() = runBlocking {
        for ((country, tag) in mapOf("CZ" to "en:czech-republic", "TR" to "en:turkey")) {
            MockWebServer().use { server ->
                val repo = repository(server)
                server.enqueue(product(market = tag))
                for (automatic in listOf(true, false)) {
                    val result = requireNotNull(repo.lookupBarcode(CheckInput(category = "food", barcode = barcode, market = if (automatic) "DE" else country, autoMarket = automatic)))
                    assertEquals(country, result.getJSONObject("identity").getString("market"))
                    assertEquals(if (automatic) "database" else "manual", result.getJSONObject("identity").getString("marketSource"))
                    assertFalse(result.getJSONArray("warnings").toString().contains("other markets"))
                }
                assertEquals(1, server.requestCount)
            }
        }
    }

    @Test fun exactBarcodeCountryIsDetectedWithoutAi() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(product(market = "en:sweden"))
            val result = requireNotNull(repository(server).lookupBarcode(CheckInput(category = "food", barcode = barcode, autoMarket = true)))
            assertEquals("SE", result.getJSONObject("identity").getString("market"))
            assertEquals("database", result.getJSONObject("identity").getString("marketSource"))
            assertEquals(1, server.requestCount)
        }
    }
    @Test fun manualBarcodeCountryRejectsKnownMismatchesButRetainsMatchingAndUntaggedRecords() = runBlocking {
        for (countries in listOf(JSONArray().put("en:germany"), JSONArray().put("en:sweden"), JSONArray())) MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(JSONObject().put("product", JSONObject().put("code", barcode)
                .put("ingredients_text", "milk").put("countries_tags", countries)).toString()))
            val result = repository(server).lookupBarcode(CheckInput(category = "food", barcode = barcode, market = "SE", autoMarket = false))
            if (countries.optString(0) == "en:germany") assertNull(result)
            else {
                assertNotNull(result)
                assertEquals("SE", result!!.getJSONObject("identity").getString("market"))
                assertEquals("not_vegan", result.getString("outcome"))
                if (countries.length() == 0) assertTrue(result.getJSONArray("warnings").toString().contains("does not confirm the product country"))
            }
        }
    }
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

    @Test fun inconclusiveBarcodeCanBeSentToAiAndReplacesItsHistoryItem() = runBlocking {
        val storage = Files.createTempDirectory("vegsnap-barcode-ai").toFile()
        try {
            MockWebServer().use { server ->
                val repository = repository(server)
                val input = CheckInput(category = "food", barcode = barcode)
                server.enqueue(product("glycerin"))
                val original = requireNotNull(repository.lookupBarcode(input))
                assertTrue(canSendBarcodeToAI(original))
                assertEquals(1, server.requestCount)
                val id = original.getString("id")
                val rows = mutableMapOf(id to HistoryEntry(id, original.getString("title"), original.getString("checkedAt"), original.toString()))
                val photos = HistoryPhotoStore(File(storage, "history"))
                photos.save(id, emptyList(), input) { }
                val queue = AnalysisQueueStore(File(storage, "queue"))
                queue.enqueueHistory(id, requireNotNull(photos.input(id)),
                    AppSettings(connection = "api", aiEnabled = true, model = "test", baseUrl = server.url("/v1").toString()), emptyList())
                val extraction = """{"text":"glycerin","complete":false,"category":"food","name":"Test product"}"""
                server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(JSONObject()
                    .put("choices", JSONArray().put(JSONObject().put("finish_reason", "stop")
                        .put("message", JSONObject().put("content", extraction)))).toString()))
                AnalysisQueueRunner(queue, { job, progress -> repository.check(job.input, emptyList(), job.settings, "", progress) }, { job, result ->
                    publishAnalysisResult(job, result, photos, { emptyList() }, rows::containsKey) { rows[it.id] = it }
                }).run(requireNotNull(queue.next(false)))
                assertTrue(queue.jobs.value.toString(), queue.jobs.value.isEmpty())
                assertEquals(setOf(id), rows.keys)
                val updated = JSONObject(rows.getValue(id).json)
                assertEquals(id, updated.getString("id"))
                assertTrue(updated.getBoolean("usedAI"))
                assertEquals("text", updated.getString("aiStatus"))
                assertEquals(input, photos.input(id))
                assertEquals(2, server.requestCount)
                assertEquals("GET", server.takeRequest(1, TimeUnit.SECONDS)?.method)
                val request = requireNotNull(server.takeRequest(1, TimeUnit.SECONDS))
                assertEquals("POST", request.method)
                val context = JSONObject(JSONObject(request.body.readUtf8()).getJSONArray("messages").getJSONObject(1).getJSONArray("content")
                    .getJSONObject(0).getString("text"))
                assertEquals(barcode, context.getString("barcode"))
                assertEquals("Test product", context.getString("name"))
                assertEquals("glycerin", context.getString("text"))
                assertFalse(context.getBoolean("complete"))
                val evidence = updated.getJSONArray("evidence")
                assertFalse((0 until evidence.length()).any {
                    val source = evidence.getJSONObject(it)
                    source.optString("kind") == "user_text" && source.optString("excerpt").isNotBlank()
                })
            }
        } finally { storage.deleteRecursively() }
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

    @Test fun communityFieldsAreBoundedBeforeBeingSentToAi() = runBlocking {
        for (savedName in listOf("", "Long product name ".repeat(100))) MockWebServer().use { server ->
            val text = "water, ".repeat(5_000)
            val name = "Long product name ".repeat(100)
            server.enqueue(product(text, name = name))
            server.enqueue(MockResponse().setResponseCode(503))
            val result = repository(server).check(CheckInput(category = "food", name = savedName, barcode = barcode), emptyList(),
                AppSettings(connection = "api", model = "test", baseUrl = server.url("/v1").toString()), "")
            assertEquals("failed", result.getString("aiStatus"))
            assertEquals("GET", server.takeRequest(1, TimeUnit.SECONDS)?.method)
            val request = requireNotNull(server.takeRequest(1, TimeUnit.SECONDS))
            val context = JSONObject(JSONObject(request.body.readUtf8()).getJSONArray("messages").getJSONObject(1)
                .getJSONArray("content").getJSONObject(0).getString("text"))
            assertEquals(text.take(30_000), context.getString("text"))
            assertEquals(name.take(300), context.getString("name"))
            assertFalse(context.getBoolean("complete"))
        }
    }

    @Test fun barcodeOnlyCompletenessCannotPromoteCommunityIngredientsToACompleteComposition() = runBlocking {
        for (text in listOf("water, salt", "Ingredients: water, salt")) MockWebServer().use { server ->
            server.enqueue(product(text))
            val extraction = JSONObject().put("text", text).put("complete", true).put("category", "food").put("name", "Test product")
            server.enqueue(MockResponse().setBody(JSONObject().put("choices", JSONArray().put(JSONObject().put("finish_reason", "stop")
                .put("message", JSONObject().put("content", extraction.toString())))).toString()))
            val result = repository(server).check(CheckInput(category = "food", complete = true, barcode = barcode), emptyList(),
                AppSettings(connection = "api", model = "test", baseUrl = server.url("/v1").toString()), "")
            assertEquals("text", result.getString("aiStatus"))
            assertTrue(result.getBoolean("usedAI"))
            assertEquals("uncertain", result.getString("outcome"))
            assertEquals("insufficient", result.getString("basis"))
        }
    }

    @Test fun malformedBarcodeIsNotAddedToProviderContext() {
        assertFalse(extractionInputContext(CheckInput(barcode = "not a barcode")).has("barcode"))
        assertEquals(barcode, extractionInputContext(CheckInput(barcode = barcode)).getString("barcode"))
    }
}
