package app.vegsnapp

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancelAndJoin
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.concurrent.TimeUnit

class ProviderFlowTest {
    private val root = File(requireNotNull(System.getProperty("vegsnap.repo")))
    private val repository = CheckRepository(Evaluator(JSONObject(File(root, "data/rules.json").readText())), JSONObject(File(root, "contracts/ai-extraction-prompt.json").readText()).getString("prompt"))
    private fun response(text: String, finish: String = "stop") = MockResponse().setHeader("Content-Type", "application/json")
        .setBody(JSONObject().put("choices", JSONArray().put(JSONObject().put("finish_reason", finish)
            .put("message", JSONObject().put("content", text)))).toString())
    @Test fun mismatchedWebClaimStillShowsConsultedSourceWithoutPromotingVerdict() {
        val result = Evaluator(JSONObject(File(root, "data/rules.json").readText())).evaluate(CheckInput())
        val extracted = JSONObject().put("name", "Product A").put("brand", "Maker")
            .put("research", JSONObject().put("searched", true).put("sources", JSONArray().put(JSONObject().put("url", "https://maker.example/product"))))
            .put("webClaims", JSONArray().put(JSONObject().put("url", "https://maker.example/product").put("claim", "vegan").put("sourceType", "manufacturer").put("quote", "Product B is vegan").put("productName", "Product B").put("brand", "Maker")))
        val checked = applyWebEvidence(result, CheckInput(), extracted)
        assertEquals("uncertain", checked.getString("outcome"))
        val evidence = checked.getJSONArray("evidence")
        assertTrue((0 until evidence.length()).any { evidence.getJSONObject(it).optString("url") == "https://maker.example/product" && !evidence.getJSONObject(it).has("claim") })
    }
    @Test fun successfulVisionEvenUncertainNeverInvokesOcrFallback() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(response("""{"text":"","complete":false,"category":"household","name":"Tissues"}"""))
            var ocrCalls = 0
            val result = repository.check(CheckInput(), listOf(PreparedPhoto(byteArrayOf(1))),
                AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "vision"), "") {
                ocrCalls++; error("OCR must not run after successful vision")
            }
            assertEquals(0, ocrCalls)
            assertEquals(1, server.requestCount)
            assertEquals("uncertain", result.getString("outcome"))
            assertEquals("images", result.getString("aiStatus"))
            assertEquals("Tissues", result.getString("title"))
        }
    }
    @Test fun failedVisionUsesOcrOnceWithoutAnotherAiOrNetworkRequest() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(503))
            var ocrCalls = 0
            val result = repository.check(CheckInput(category = "food"), listOf(PreparedPhoto(byteArrayOf(1))),
                AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "vision"), "") { photos ->
                ocrCalls++; assertEquals(1, server.requestCount)
                photos.map { it.copy(text = "Ingredients: milk") }
            }
            assertEquals(1, ocrCalls)
            assertEquals(1, server.requestCount)
            assertEquals("not_vegan", result.getString("outcome"))
            assertEquals("failed", result.getString("aiStatus"))
            assertEquals("service", result.getJSONObject("aiError").getString("code"))
            assertEquals("ocr", result.getJSONArray("evidence").getJSONObject(0).getString("kind"))
        }
    }
    @Test fun failedProviderPersistsSafeLocalizedReasonAndKeepsManualEvidence() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(429).setBody("""{"error":{"code":"insufficient_quota","message":"secret@example.test private-token"}}"""))
            val result = repository.check(CheckInput("unknown additive", "food", true, locale = "de"), emptyList(),
                AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "test"), "")
            assertEquals("failed", result.getString("aiStatus"))
            assertEquals("quota", result.getJSONObject("aiError").getString("code"))
            assertTrue(result.getJSONObject("aiError").getString("message").contains("Nutzungslimit"))
            assertEquals("unknown additive", result.getJSONArray("evidence").getJSONObject(0).getString("excerpt"))
            assertFalse(result.toString().contains("private-token"))
            assertFalse(result.toString().contains("secret@example.test"))
        }
    }
    @Test fun invalidModelJsonPersistsReasonInsteadOfGenericFailure() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(response("not valid JSON"))
            val result = repository.check(CheckInput("unknown", "food"), emptyList(),
                AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "test"), "")
            assertEquals("invalid_response", result.getJSONObject("aiError").getString("code"))
        }
    }
    @Test fun offlineDisabledUnconfiguredAndVisionDisabledUseOnlyLocalFallback() = runBlocking {
        MockWebServer().use { server ->
            val configured = AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "vision")
            for ((settings, status) in listOf(configured.copy(offline = true) to "offline", configured.copy(aiEnabled = false) to "disabled",
                configured.copy(model = "") to "unconfigured", configured.copy(vision = false) to "vision_disabled")) {
                var ocrCalls = 0
                val result = repository.check(CheckInput(category = "food"), listOf(PreparedPhoto(byteArrayOf(1))), settings, "") { photos ->
                    ocrCalls++; photos.map { it.copy(text = "Ingredients: water") }
                }
                assertEquals(1, ocrCalls)
                assertEquals(status, result.getString("aiStatus"))
                assertEquals("uncertain", result.getString("outcome"))
            }
            assertEquals(0, server.requestCount)
        }
    }
    @Test fun unstructuredPhotoOcrIsNotPresentedAsCompositionAndExplainsDisabledAi() = runBlocking {
        val result = repository.check(CheckInput(), listOf(PreparedPhoto(byteArrayOf(1, 2, 3), "Mi\n® 1")), AppSettings(aiEnabled = false), "")
        assertEquals("Product check", result.getString("title"))
        assertEquals(0, result.getJSONArray("findings").length())
        assertEquals("disabled", result.getString("aiStatus"))
        assertFalse(result.getBoolean("usedAI"))
    }
    @Test fun photoOcrHeadingDoesNotProveWholeLabelWasCaptured() = runBlocking {
        val result = repository.check(CheckInput(category = "food"), listOf(PreparedPhoto(byteArrayOf(1), "Ingredients: water")), AppSettings(), "")
        assertEquals("uncertain", result.getString("outcome"))
        assertEquals("ocr", result.getJSONArray("evidence").getJSONObject(0).getString("kind"))
        assertEquals("photo-ocr", result.getJSONArray("findings").getJSONObject(0).getString("evidenceId"))
    }
    @Test fun configuredPhotoCheckSendsImageBytesAndUsesIdentityWithoutOcrGarbage() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(response("""{"text":"","complete":false,"category":"household","name":"ICA Basic Näsdukar"}"""))
            val jpeg = byteArrayOf(1, 2, 3, 4)
            val result = repository.check(CheckInput(), listOf(PreparedPhoto(jpeg, "Mi\n® 1")),
                AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "vision"), "")
            val request = JSONObject(requireNotNull(server.takeRequest(1, TimeUnit.SECONDS)).body.readUtf8())
            val content = request.getJSONArray("messages").getJSONObject(1).getJSONArray("content")
            assertEquals("data:image/jpeg;base64,AQIDBA==", content.getJSONObject(1).getJSONObject("image_url").getString("url"))
            assertTrue(content.getJSONObject(0).getString("text").contains("Mi"))
            assertEquals("ICA Basic Näsdukar", result.getString("title"))
            assertEquals("household", result.getString("category"))
            assertEquals(0, result.getJSONArray("findings").length())
            assertEquals("images", result.getString("aiStatus"))
            assertTrue(result.getBoolean("usedAI"))
        }
    }
    @Test fun photoCheckMakesOfflineMissingModelAndVisionSuppressionExplicit() = runBlocking {
        MockWebServer().use { server ->
            val photo = listOf(PreparedPhoto(byteArrayOf(1), "Mi\n® 1"))
            val base = AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "vision")
            assertEquals("offline", repository.check(CheckInput(), photo, base.copy(offline = true), "").getString("aiStatus"))
            assertEquals("unconfigured", repository.check(CheckInput(), photo, base.copy(model = ""), "").getString("aiStatus"))
            assertEquals(0, server.requestCount)
            server.enqueue(response("""{"text":"Mi\n® 1","complete":false,"category":"other"}"""))
            val result = repository.check(CheckInput(), photo, base.copy(vision = false), "")
            assertEquals("vision_disabled", result.getString("aiStatus"))
            assertEquals(1, JSONObject(requireNotNull(server.takeRequest(1, TimeUnit.SECONDS)).body.readUtf8()).getJSONArray("messages").getJSONObject(1).getJSONArray("content").length())
        }
    }
    @Test fun photoLabelIsObservedEvidenceAndCannotHideManualAnimalIngredients() = runBlocking {
        MockWebServer().use { server ->
            val extracted = """{"text":"water","complete":true,"category":"food","labelObservations":[{"kind":"vegan_certification","name":"V-Label","text":"VEGAN"}]}"""
            val base = AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "vision")
            server.enqueue(response(extracted))
            val result = repository.check(CheckInput("natural flavouring", "food", true), listOf(PreparedPhoto(byteArrayOf(1), "")), base, "")
            assertEquals("vegan", result.getString("outcome"))
            assertEquals("packaging", result.getString("basis"))
            assertEquals("natural flavouring", result.getJSONArray("findings").getJSONObject(0).getString("term"))
            assertTrue(result.getJSONArray("evidence").toString().contains("unverified"))
            // Known animal evidence prevents the provider call entirely, so apply a conflicting
            // observed label directly at the evidence seam to exercise its precedence rule.
            val animal = Evaluator(JSONObject(File(root, "data/rules.json").readText())).evaluate(CheckInput("milk", "food", true))
            assertEquals("conflicting", applyAIEvidence(animal, CheckInput("milk", "food", true), JSONObject(extracted), true, true).getString("outcome"))
        }
    }
    @Test fun aiAssessmentOnlyResolvesActualUnknownTermsAndFindingsAreNotDuplicated() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(response("""{"text":"water, mystery fibre","complete":true,"category":"food","ingredientAssessments":[{"term":"mystery fibre","status":"plant","explanation":"The visible material is plant fibre."},{"term":"absent term","status":"animal","explanation":"Must be ignored."}]}"""))
            val result = repository.check(CheckInput("water, mystery fibre", "food", true), emptyList(),
                AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "text"), "")
            assertEquals("vegan", result.getString("outcome"))
            assertEquals(2, result.getJSONArray("findings").length())
            assertEquals("ai-assessment", result.getJSONArray("findings").getJSONObject(1).getString("evidenceId"))
        }
    }
    @Test fun incompleteAiResponsePreservesOriginalEvidence() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(response("""{"text":"water","complete":true,"category":"food"}""", "length"))
            val result = repository.check(CheckInput("Ingredients: water, unknown additive", "food", true), emptyList(),
                AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "test"), "test-token")
            assertEquals("uncertain", result.getString("outcome"))
            assertFalse(result.getBoolean("usedAI"))
            assertTrue(result.getJSONArray("evidence").getJSONObject(0).getString("excerpt").contains("unknown additive"))
            assertEquals("Bearer test-token", server.takeRequest(1, TimeUnit.SECONDS)?.getHeader("Authorization"))
        }
    }
    @Test fun redirectDoesNotForwardApiCredentials() = runBlocking {
        MockWebServer().use { server -> MockWebServer().use { other ->
            server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", other.url("/steal")))
            val result = repository.check(CheckInput("unknown", "food"), emptyList(),
                AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "test"), "test-token")
            assertEquals("uncertain", result.getString("outcome"))
            assertEquals(0, other.requestCount)
        } }
    }
    @Test fun offlineModeDoesNotInvokeConnectedProvider() = runBlocking {
        MockWebServer().use { server ->
            val result = repository.check(CheckInput("unknown", "food"), emptyList(),
                AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "test", offline = true), "test-token")
            assertEquals("uncertain", result.getString("outcome"))
            assertEquals(0, server.requestCount)
        }
    }
    @Test fun textModelCannotOmitUnrecognizedIngredient() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(response("""{"text":"water","complete":true,"category":"food"}"""))
            val result = repository.check(CheckInput("Ingredients: water, unknown additive", "food", true), emptyList(),
                AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "test"), "")
            assertEquals("uncertain", result.getString("outcome"))
            assertFalse(result.getBoolean("usedAI"))
        }
    }
    @Test fun textModelCannotClaimUnheadedTextIsComplete() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(response("""{"text":"water, salt","complete":true,"category":"food"}"""))
            val result = repository.check(CheckInput("water, salt", "food"), emptyList(),
                AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "test"), "")
            assertEquals("uncertain", result.getString("outcome"))
        }
    }
    @Test fun prelimitedManualSharedAndOcrTextRemainIncomplete() = runBlocking {
        val original = "Ingredients: water" + " ".repeat(30_000) + ", milk"
        val shared = ScanState().withText(original, replace = true)
        assertEquals(30_000, shared.text.length)
        assertTrue(shared.textTruncated)
        val edited = shared.withText("Ingredients: water")
        assertTrue(edited.textTruncated)
        assertFalse(edited.withText("").textTruncated)
        assertFalse(edited.withText("Ingredients: water", replace = true).textTruncated)
        val manualResult = repository.check(CheckInput(edited.text, "food", true, truncated = edited.textTruncated),
            emptyList(), AppSettings(offline = true), "")
        assertEquals("uncertain", manualResult.getString("outcome"))
        assertTrue(manualResult.getJSONArray("warnings").toString().contains("shortened"))
        val ocr = boundedProductText(original, 20_000)
        assertEquals(20_000, ocr.text.length)
        val photoResult = repository.check(CheckInput(category = "food", complete = true),
            listOf(PreparedPhoto(byteArrayOf(), ocr.text, ocr.truncated)), AppSettings(offline = true), "")
        assertEquals("uncertain", photoResult.getString("outcome"))
        assertTrue(photoResult.getJSONArray("warnings").toString().contains("shortened"))
    }
    @Test fun cancelledProviderCheckCannotReturnAResultForHistory() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.NO_RESPONSE))
            var producedResult = false
            val scan = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Default).launch {
                repository.check(CheckInput("unknown", "food"), emptyList(),
                    AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "test"), "")
                producedResult = true
            }
            assertNotNull(server.takeRequest(3, TimeUnit.SECONDS))
            kotlinx.coroutines.withTimeout(3000) { scan.cancelAndJoin() }
            assertTrue(scan.isCancelled)
            assertFalse(producedResult)
        }
    }
    private fun databaseRepository(server: MockWebServer) = CheckRepository(
        Evaluator(JSONObject(File(root, "data/rules.json").readText())), "Unused in database tests",
        CheckRepository.defaultHttpClient().newBuilder().addInterceptor { chain ->
            val request = chain.request()
            chain.proceed(request.newBuilder().url(server.url(request.url.encodedPath + "?" + request.url.encodedQuery)).build())
        }.build(),
    )
    private fun product(text: String, market: String = "en:germany") = MockResponse().setBody(JSONObject().put("product",
        JSONObject().put("code", "4006381333931").put("ingredients_text", text).put("product_name", "Test product")
            .put("countries_tags", JSONArray().put(market))).toString())
    @Test fun uncertainDatabaseCannotEraseKnownMilkInOriginal() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(product("water, salt"))
            val result = databaseRepository(server).check(CheckInput("Ingredients: milk", "food", barcode = "4006381333931"), emptyList(), AppSettings(connection = "api"), "")
            assertEquals("not_vegan", result.getString("outcome"))
            assertEquals(2, result.getJSONArray("evidence").length())
            assertEquals("milk", result.getJSONArray("findings").getJSONObject(0).getString("term"))
            assertEquals("input", result.getJSONArray("findings").getJSONObject(0).getString("evidenceId"))
            assertTrue(result.getJSONArray("evidence").getJSONObject(1).getString("id").contains("openfoodfacts"))
        }
    }
    @Test fun databaseAnimalEvidenceConflictsWithCompletePlantList() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(product("milk"))
            val result = databaseRepository(server).check(CheckInput("Ingredients: water, salt", "food", barcode = "4006381333931"), emptyList(), AppSettings(connection = "api"), "")
            assertEquals("conflicting", result.getString("outcome"))
            assertEquals("insufficient", result.getString("basis"))
            assertEquals(2, result.getJSONArray("evidence").length())
        }
    }
    @Test fun otherMarketExactBarcodePreservesConflictingCompositionWithWarning() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(product("milk", "en:united-states"))
            val result = databaseRepository(server).check(CheckInput("Ingredients: water, salt", "food", barcode = "4006381333931"), emptyList(), AppSettings(connection = "api"), "")
            assertEquals("conflicting", result.getString("outcome"))
            assertEquals(2, result.getJSONArray("evidence").length())
            assertEquals("exact_barcode", result.getJSONObject("identity").getString("match"))
            assertTrue(result.getJSONArray("warnings").toString().contains("other markets"))
            assertTrue(result.getJSONArray("findings").toString().contains("milk"))
            assertFalse(result.getBoolean("usedAI"))
        }
    }
    @Test fun aiCategoryCannotTurnShoesIntoFood() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(response("""{"text":"polyester, rubber","complete":true,"category":"food"}"""))
            val result = repository.check(CheckInput("Materials: polyester, rubber", "shoes", true), emptyList(),
                AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "test"), "")
            assertEquals("shoes", result.getString("category"))
            assertEquals("uncertain", result.getString("outcome"))
            assertTrue(result.getBoolean("usedAI"))
        }
    }
    @Test fun aiCanFillUnspecifiedCategory() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(response("""{"text":"water, salt","complete":true,"category":"food"}"""))
            val result = repository.check(CheckInput("Ingredients: water, salt", "other", true), emptyList(),
                AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "test"), "")
            assertEquals("food", result.getString("category"))
            assertEquals("vegan", result.getString("outcome"))
            assertEquals("composition", result.getString("basis"))
            assertTrue(result.getBoolean("usedAI"))
        }
    }
    @Test fun autoCategoryCanIdentifyShoesClothingAndDrinksWithoutFalseVeganCertainty() = runBlocking {
        for (category in listOf("shoes", "clothing", "drink")) {
            MockWebServer().use { server ->
                val text = if (category == "drink") "water, salt" else "cotton"
                server.enqueue(response(JSONObject().put("text", text).put("complete", true).put("category", category).put("name", if (category == "drink") "White wine" else "Product").toString()))
                val result = repository.check(CheckInput(text, "other", true), emptyList(),
                    AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "test"), "")
                assertEquals(category, result.getString("category"))
                assertEquals("uncertain", result.getString("outcome"))
                assertEquals("insufficient", result.getString("basis"))
                assertTrue(result.getBoolean("usedAI"))
                assertTrue(result.getJSONArray("questions").length() > 0)
                assertEquals(1, server.requestCount)
            }
        }
    }
    @Test fun autoCategoryStaysUnknownWithoutAiAndOfflineCannotUseConnectedProvider() = runBlocking {
        MockWebServer().use { server ->
            for (settings in listOf(
                AppSettings(connection = "api", aiEnabled = false, baseUrl = server.url("/v1").toString(), model = "test"),
                AppSettings(connection = "api", aiEnabled = true, offline = true, baseUrl = server.url("/v1").toString(), model = "test"),
            )) {
                val result = repository.check(CheckInput("water, salt", "other", true), emptyList(), settings, "")
                assertEquals("other", result.getString("category"))
                assertEquals("uncertain", result.getString("outcome"))
                assertFalse(result.getBoolean("usedAI"))
            }
            assertEquals(0, server.requestCount)
        }
    }
    @Test fun autoCategoryUsesDatabaseCategoryButKeepsIncompleteRecordUncertain() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(product("water, salt"))
            val result = databaseRepository(server).check(CheckInput(category = "other", barcode = "4006381333931"),
                emptyList(), AppSettings(), "")
            assertEquals("food", result.getString("category"))
            assertEquals("exact_barcode", result.getJSONObject("identity").getString("match"))
            assertEquals("uncertain", result.getString("outcome"))
            assertFalse(result.getBoolean("usedAI"))
            assertEquals(1, server.requestCount)
        }
    }
    @Test fun aiDifferentBarcodeCannotFetchAnotherProduct() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(product("water, salt"))
            server.enqueue(response("""{"text":"unknown","complete":false,"category":"food","barcode":"5901234123457"}"""))
            val result = databaseRepository(server).check(CheckInput("unknown", "food", barcode = "4006381333931"), emptyList(),
                AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "test"), "")
            assertEquals("4006381333931", result.getJSONObject("identity").getString("barcode"))
            assertEquals("exact_barcode", result.getJSONObject("identity").getString("match"))
            assertEquals(2, server.requestCount)
            assertFalse(result.getBoolean("usedAI"))
            assertEquals(2, result.getJSONArray("evidence").length())
        }
    }
    @Test fun exactDatabaseIdentitySurvivesAiUnknownAndEquivalentGtinIsNotQueriedTwice() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(product("water, salt"))
            server.enqueue(response("""{"text":"unknown","complete":false,"category":"food","barcode":"04006381333931"}"""))
            val result = databaseRepository(server).check(CheckInput("unknown", "food", barcode = "4006381333931"), emptyList(),
                AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "test"), "")
            assertEquals("4006381333931", result.getJSONObject("identity").getString("barcode"))
            assertEquals("exact_barcode", result.getJSONObject("identity").getString("match"))
            assertEquals("Test product", result.getJSONObject("identity").getString("name"))
            assertEquals(2, server.requestCount)
            assertTrue(result.getBoolean("usedAI"))
            assertEquals(3, result.getJSONArray("evidence").length())
        }
    }
    @Test fun locallyTruncatedTextCannotBecomeComplete() = runBlocking {
        val heading = "Ingredients: "
        val firstThirtyThousand = heading + " ".repeat(30_000 - heading.length - "water".length) + "water"
        assertEquals(30_000, firstThirtyThousand.length)
        val result = repository.check(CheckInput(firstThirtyThousand + ", milk", "food", true), emptyList(), AppSettings(offline = true), "")
        assertEquals("uncertain", result.getString("outcome"))
        assertTrue(result.getJSONArray("warnings").getString(0).contains("incomplete"))
    }
    @Test fun conflictRemainsAfterLaterUnknownAndEvidenceIsDeduplicated() {
        val evaluator = Evaluator(JSONObject(File(root, "data/rules.json").readText()))
        val original = evaluator.evaluate(CheckInput("Ingredients: water", "food"))
        val negative = evaluator.evaluate(CheckInput("Ingredients: milk", "food"))
        negative.getJSONArray("evidence").getJSONObject(0).put("id", "database")
        negative.getJSONArray("findings").getJSONObject(0).put("evidenceId", "database")
        val conflict = mergeResults(original, negative)
        assertEquals("conflicting", conflict.getString("outcome"))
        val merged = mergeResults(conflict, negative)
        assertEquals("conflicting", merged.getString("outcome"))
        assertEquals(2, merged.getJSONArray("evidence").length())
        assertEquals(2, merged.getJSONArray("findings").length())
    }
}
