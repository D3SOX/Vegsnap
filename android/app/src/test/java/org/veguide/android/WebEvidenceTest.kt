package org.veguide.android

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.concurrent.TimeUnit

class WebEvidenceTest {
    private val root = File(requireNotNull(System.getProperty("veguide.repo")))
    private val evaluator = Evaluator(JSONObject(File(root, "data/rules.json").readText()))
    private val claim = JSONObject("""{"url":"https://maker.example/tissues","quote":"ICA Basic tissues are vegan.","claim":"vegan","sourceType":"manufacturer","productName":"Basic tissues","brand":"ICA"}""")
    private fun extraction() = JSONObject().put("text", "").put("complete", false).put("category", "household")
        .put("name", "Basic tissues").put("brand", "ICA").put("webClaims", JSONArray().put(claim))
    private fun providerResponse(text: String, sourceUrl: String = claim.getString("url")) = JSONObject().put("status", "completed").put("output", JSONArray()
        .put(JSONObject().put("type", "web_search_call").put("status", "completed").put("action", JSONObject().put("sources", JSONArray().put(JSONObject().put("url", sourceUrl)))))
        .put(JSONObject().put("type", "message").put("content", JSONArray().put(JSONObject().put("type", "output_text").put("text", text)))))
    @Test fun searchedAmbiguousCompositionGetsOneDeclarationLookupWithoutDroppingOriginalSource() = runBlocking {
        MockWebServer().use { server ->
            val ingredientUrl = "https://www.oddlygood.com/fi/tuotteet/oddlygood-soygurt-1-kg-maustamaton/"
            val declarationUrl = "https://www.dabas.com/productsheet/06430081491338"
            val name = "Oddlygood Soygurt Natural"
            val first = JSONObject().put("text", "").put("complete", false).put("category", "food").put("name", name).put("brand", "Oddlygood")
                .put("webCompositions", JSONArray().put(sourceComposition(name, "Oddlygood", "vesi, kuorittu soijapapu, hapate").put("url", ingredientUrl)))
            val second = JSONObject().put("text", "").put("complete", false).put("category", "food").put("name", name).put("brand", "Oddlygood")
                .put("webClaims", JSONArray().put(JSONObject().put("url", declarationUrl).put("quote", "Diettyp: Vegan. Uppgiftslämnare: Oddlygood Sweden AB.")
                    .put("claim", "vegan").put("sourceType", "manufacturer").put("productName", name).put("brand", "Oddlygood")))
            server.enqueue(MockResponse().setBody(providerResponse(first.toString(), ingredientUrl).toString()))
            server.enqueue(MockResponse().setBody(providerResponse(second.toString(), declarationUrl).toString()))
            val result = officialRepository(server).check(CheckInput("Private refrigerator note"), listOf(PreparedPhoto(byteArrayOf(1))), AppSettings(connection = "api", model = "test"), "")
            assertEquals(2, server.requestCount)
            server.takeRequest()
            val request = JSONObject(server.takeRequest().body.readUtf8())
            assertEquals("required", request.getString("tool_choice"))
            val input = request.getJSONArray("input").toString()
            assertTrue(input.contains("hapate"))
            assertFalse(input.contains("Private refrigerator note"))
            assertFalse(input.contains("input_image"))
            assertEquals("vegan", result.getString("outcome"))
            assertEquals("manufacturer", result.getString("basis"))
            assertTrue(result.getJSONArray("evidence").toString().contains(ingredientUrl))
            assertTrue(result.getJSONArray("evidence").toString().contains(declarationUrl))
            assertFalse(result.getJSONArray("warnings").toString().contains("did not complete"))
        }
    }
    @Test fun unansweredVitaminDResearchRemainsHonestAndDoesNotRetryAgain() = runBlocking {
        MockWebServer().use { server ->
            val first = JSONObject().put("text", "").put("complete", false).put("category", "drink").put("name", "Soy drink").put("brand", "Maker")
                .put("webCompositions", JSONArray().put(sourceComposition("Soy drink", "Maker", "water, soybeans, vitamins (D)")))
            server.enqueue(MockResponse().setBody(providerResponse(first.toString()).toString()))
            server.enqueue(MockResponse().setResponseCode(503))
            val result = officialRepository(server).check(CheckInput(), listOf(PreparedPhoto(byteArrayOf(1))), AppSettings(connection = "api", model = "test"), "")
            assertEquals(2, server.requestCount)
            assertEquals("uncertain", result.getString("outcome"))
            assertEquals("images", result.getString("aiStatus"))
            assertEquals("searched", result.getString("webSearchStatus"))
            assertTrue(result.getJSONArray("questions").toString().contains("vitamin d"))
            assertFalse(result.getJSONArray("warnings").toString().contains("did not complete"))
        }
    }
    @Test fun identifiedGranolaCanUseResearchedIngredientsWithoutInventingVisibleText() = runBlocking {
        MockWebServer().use { server ->
            // Deliberately simplified fixture, not a claim about a real recipe.
            val extracted = JSONObject().put("text", "").put("complete", false).put("category", "food")
                .put("name", "Granola Kakao & Hallon").put("brand", "Paulúns")
                .put("ingredientAssessments", JSONArray().put(JSONObject().put("term", "hallon").put("status", "plant").put("explanation", "Raspberries are plant fruit.")))
                .put("webCompositions", JSONArray().put(JSONObject().put("url", "https://maker.example/tissues")
                    .put("text", "havre, kakao, hallon").put("complete", true).put("sourceType", "manufacturer")
                    .put("productName", "Granola Kakao & Hallon").put("brand", "Paulúns")))
            server.enqueue(MockResponse().setBody(providerResponse(extracted.toString()).toString()))
            val client = CheckRepository.defaultHttpClient().newBuilder().addInterceptor { chain -> chain.proceed(chain.request().newBuilder().url(server.url("/v1/responses")).build()) }.build()
            val result = CheckRepository(evaluator, "prompt", client).check(CheckInput(), listOf(PreparedPhoto(byteArrayOf(1))), AppSettings(connection = "api", aiEnabled = true, model = "test"), "")
            assertEquals("vegan", result.getString("outcome"))
            assertEquals("composition", result.getString("basis"))
            val evidence = result.getJSONArray("evidence")
            val researched = (0 until evidence.length()).map { evidence.getJSONObject(it) }.first { it.getString("id") == "web-composition-0" }
            assertFalse((0 until evidence.length()).map { evidence.getJSONObject(it) }.any { it.getString("id") == "ai-extraction" && it.getString("excerpt").isBlank() })
            assertEquals("havre, kakao, hallon", researched.getString("excerpt"))
            assertEquals("unverified", researched.getString("verification"))
        }
    }
    private fun sourceComposition(name: String, brand: String, text: String, type: String = "manufacturer") = JSONObject()
        .put("url", "https://maker.example/tissues").put("text", text).put("complete", true).put("sourceType", type)
        .put("productName", name).put("brand", brand)
    private fun officialRepository(server: MockWebServer) = CheckRepository(evaluator, "Photo prompt",
        CheckRepository.defaultHttpClient().newBuilder().addInterceptor { chain -> chain.proceed(chain.request().newBuilder().url(server.url("/v1/responses")).build()) }.build(), researchPrompt = "Research the identified product")
    @Test fun researchedRavioliAnimalIngredientCannotBeOverriddenByModelAssessment() = runBlocking {
        MockWebServer().use { server ->
            val extracted = JSONObject().put("text", "").put("complete", false).put("category", "food")
                .put("name", "Ravioli in Tomatensauce").put("brand", "MAGGI")
                .put("webCompositions", JSONArray().put(sourceComposition("Ravioli in Tomatensauce", "MAGGI", "water, beef")))
                .put("ingredientAssessments", JSONArray().put(JSONObject().put("term", "beef").put("status", "plant").put("explanation", "Incorrect model assessment must not erase the local animal rule.")))
            server.enqueue(MockResponse().setBody(providerResponse(extracted.toString()).toString()))
            val result = officialRepository(server).check(CheckInput(), listOf(PreparedPhoto(byteArrayOf(1))), AppSettings(connection = "api", aiEnabled = true, model = "test"), "")
            assertEquals("not_vegan", result.getString("outcome"))
            assertEquals("composition", result.getString("basis"))
            assertTrue((0 until result.getJSONArray("findings").length()).map { result.getJSONArray("findings").getJSONObject(it) }.any { it.getString("term") == "beef" && it.getString("status") == "animal" })
            assertFalse(result.getJSONArray("evidence").toString().contains("web-consulted"))
        }
    }
    @Test fun researchedCompositionRequiresConsultedUrlExactIdentityAndPreservesConflicts() {
        val input = CheckInput(category = "food", name = "Granola Kakao & Hallon")
        for (mode in listOf("wrong-url", "wrong-variant", "no-search")) {
            val composition = sourceComposition("Granola Kakao & Hallon", "Paulúns", "water, salt")
            val extracted = JSONObject().put("text", "").put("complete", false).put("category", "food")
                .put("name", input.name).put("brand", "Paulúns").put("webCompositions", JSONArray().put(composition))
                .put("research", responseResearch(providerResponse("{}")))
            when (mode) {
                "wrong-url" -> composition.put("url", "https://invented.example/recipe")
                "wrong-variant" -> composition.put("productName", "Granola another flavour")
                "no-search" -> extracted.getJSONObject("research").put("searched", false)
            }
            assertEquals(mode, "uncertain", applyWebCompositions(evaluator.evaluate(input), input, extracted, evaluator).getString("outcome"))
        }
        val extracted = JSONObject().put("name", input.name).put("brand", "Paulúns")
            .put("research", responseResearch(providerResponse("{}")))
            .put("webCompositions", JSONArray().put(sourceComposition(input.name, "Paulúns", "water, salt"))
                .put(sourceComposition(input.name, "Paulúns", "water, milk", "retailer")))
        val result = applyWebCompositions(evaluator.evaluate(input), input, extracted, evaluator)
        assertEquals("conflicting", result.getString("outcome"))
        assertTrue(result.getJSONArray("evidence").toString().contains("Retailer composition"))
        assertTrue(result.getJSONArray("findings").toString().contains("milk"))
    }
    @Test fun unresearchedFrontPhotoTriggersOneIdentityOnlyRequiredSearch() = runBlocking {
        MockWebServer().use { server ->
            val first = JSONObject().put("text", "").put("complete", false).put("category", "food").put("name", "Granola Kakao & Hallon").put("brand", "Paulúns")
            val initialResponse = providerResponse(first.toString()).also { it.getJSONArray("output").remove(0) }
            server.enqueue(MockResponse().setBody(initialResponse.toString()))
            val second = JSONObject(first.toString()).put("text", "invented visible text must be ignored").put("complete", true)
                .put("webCompositions", JSONArray().put(sourceComposition(first.getString("name"), first.getString("brand"), "water, salt")))
            server.enqueue(MockResponse().setBody(providerResponse(second.toString()).toString()))
            val result = officialRepository(server).check(CheckInput("private product note"), listOf(PreparedPhoto(byteArrayOf(1,2,3))), AppSettings(connection = "api", aiEnabled = true, model = "test"), "")
            assertEquals(2, server.requestCount)
            server.takeRequest()
            val followup = JSONObject(requireNotNull(server.takeRequest(1, TimeUnit.SECONDS)).body.readUtf8())
            assertEquals("required", followup.getString("tool_choice"))
            val content = followup.getJSONArray("input").getJSONObject(0).getJSONArray("content")
            assertEquals(1, content.length())
            val identity = JSONObject(content.getJSONObject(0).getString("text"))
            assertEquals("Granola Kakao & Hallon", identity.getString("name"))
            assertEquals(setOf("name", "brand", "category", "locale", "unresolvedIngredients"), identity.keys().asSequence().toSet())
            assertEquals(0, identity.getJSONArray("unresolvedIngredients").length())
            assertFalse(followup.toString().contains("private product note"))
            assertFalse(followup.toString().contains("data:image"))
            assertFalse(result.toString().contains("invented visible text"))
            assertEquals("vegan", result.getString("outcome"))
            assertEquals("images", result.getString("aiStatus"))
        }
    }
    @Test fun failedRequiredResearchPreservesFirstPhotoIdentityAndDoesNotRunOcr() = runBlocking {
        MockWebServer().use { server ->
            val first = JSONObject().put("text", "").put("complete", false).put("category", "food").put("name", "Granola Kakao & Hallon").put("brand", "Paulúns")
            server.enqueue(MockResponse().setBody(providerResponse(first.toString()).also { it.getJSONArray("output").remove(0) }.toString()))
            server.enqueue(MockResponse().setResponseCode(503))
            var ocrCalls = 0
            val result = officialRepository(server).check(CheckInput(), listOf(PreparedPhoto(byteArrayOf(1))), AppSettings(connection = "api", aiEnabled = true, model = "test"), "") { ocrCalls++; it }
            assertEquals(2, server.requestCount)
            assertEquals(0, ocrCalls)
            assertEquals("Granola Kakao & Hallon", result.getString("title"))
            assertEquals("uncertain", result.getString("outcome"))
            assertEquals("images", result.getString("aiStatus"))
            assertTrue(result.getJSONArray("warnings").toString().contains("Web research did not complete"))
        }
    }
    @Test fun exactPlantCompoundAssessmentResolvesOnlyItsActualComponents() {
        val text = "oligofruktos* (fiber), torkade dadlar (dadlar, rismjöl)"
        val input = CheckInput(text, "food", true)
        val extracted = JSONObject().put("ingredientAssessments", JSONArray()
            .put(JSONObject().put("term", "oligofruktos* (fiber)").put("status", "plant").put("explanation", "Plant carbohydrate fibre."))
            .put(JSONObject().put("term", "torkade dadlar (dadlar, rismjöl)").put("status", "plant").put("explanation", "Dates with rice flour.")))
        val result = applyAIEvidence(evaluator.evaluate(input), input, extracted, true, false)
        assertEquals("vegan", result.getString("outcome"))
        val unrelated = CheckInput("fiber, unknown", "food", true)
        val protected = applyAIEvidence(evaluator.evaluate(unrelated), unrelated, extracted, true, false)
        assertEquals("uncertain", protected.getString("outcome"))
        assertEquals("unknown", protected.getJSONArray("findings").getJSONObject(0).getString("status"))
    }
    @Test fun livePaulunsSourceCompositionMatchesItsCompoundAssessments() = runBlocking {
        MockWebServer().use { server ->
            val text = "HAVRE, oligofruktos* (fiber), rapsolja, DINKEL, äppeljuicekoncentrat, torkade dadlar (dadlar, rismjöl), kakao, kokos, torkade hallon 1,5 %, havssalt. Kan innehålla spår av JORDNÖTTER och NÖTTER."
            val terms = listOf("HAVRE", "oligofruktos* (fiber)", "rapsolja", "DINKEL", "äppeljuicekoncentrat", "torkade dadlar (dadlar, rismjöl)", "kakao", "kokos", "torkade hallon 1,5 %", "havssalt")
            val extracted = JSONObject().put("text", "").put("complete", false).put("category", "food").put("name", "Granola Kakao & Hallon").put("brand", "Paulúns")
                .put("webCompositions", JSONArray().put(sourceComposition("Granola Kakao & Hallon", "Paulúns", text, "retailer")))
                .put("ingredientAssessments", JSONArray(terms.map { JSONObject().put("term", it).put("status", "plant").put("explanation", "Plant or mineral ingredient; compound components are plant-derived.") }))
            server.enqueue(MockResponse().setBody(providerResponse(extracted.toString()).toString()))
            val result = officialRepository(server).check(CheckInput(), listOf(PreparedPhoto(byteArrayOf(1))), AppSettings(connection = "api", aiEnabled = true, model = "test"), "")
            assertEquals("vegan", result.getString("outcome"))
            assertEquals("composition", result.getString("basis"))
            val findings = result.getJSONArray("findings")
            assertEquals(13, findings.length())
            assertTrue((0 until findings.length()).all { findings.getJSONObject(it).getString("status") == "plant" })
            assertEquals(1, result.getJSONArray("crossContact").length())
            assertTrue(result.getJSONArray("evidence").toString().contains("Retailer composition (AI)"))
        }
    }
    @Test fun researchedIdentityPreservesOrganicAndPercentageVariants() {
        for ((name, sourceName) in listOf("Bio Granola" to "Granola", "50% Plant Burger" to "100% Plant Burger")) {
            val input = CheckInput(category = "food", name = name)
            val extracted = JSONObject().put("name", name).put("brand", "Maker")
                .put("research", responseResearch(providerResponse("{}")))
                .put("webCompositions", JSONArray().put(sourceComposition(sourceName, "Maker", "water, salt")))
            assertEquals("uncertain", applyWebCompositions(evaluator.evaluate(input), input, extracted, evaluator).getString("outcome"))
            assertNotEquals(normalizeProductIdentity(name), normalizeProductIdentity(sourceName))
        }
        assertEquals(normalizeProductIdentity("  Bio   GRANOLA  "), normalizeProductIdentity("Bio Granola"))
    }
    @Test fun compoundAssessmentCannotRewriteKnownRulesOrAnimalChildrenIndividually() {
        fun assessment(term: String, status: String) = JSONObject().put("term", term).put("status", status).put("explanation", "Fixture assessment.")
        val local = CheckInput("blend (milk, E471, rare seed)", "food", true)
        val protected = applyAIEvidence(evaluator.evaluate(local), local, JSONObject().put("ingredientAssessments", JSONArray().put(assessment(local.text, "plant"))), true, false)
        assertEquals("not_vegan", protected.getString("outcome"))
        assertEquals("ambiguous", protected.getJSONArray("findings").getJSONObject(2).getString("status"))
        val input = CheckInput("blend (rare cereal, rare seed)", "food", true)
        val animal = applyAIEvidence(evaluator.evaluate(input), input, JSONObject().put("ingredientAssessments", JSONArray().put(assessment(input.text, "animal"))), true, false)
        assertEquals(listOf("animal", "unknown", "unknown"), (0 until 3).map { animal.getJSONArray("findings").getJSONObject(it).getString("status") })
        val conflict = applyAIEvidence(evaluator.evaluate(input), input, JSONObject().put("ingredientAssessments", JSONArray().put(assessment(input.text, "plant")).put(assessment("rare cereal", "animal"))), true, false)
        assertEquals("uncertain", conflict.getString("outcome"))
        assertEquals("ambiguous", conflict.getJSONArray("findings").getJSONObject(1).getString("status"))
    }
    @Test fun overflowingFollowupAssessmentsCannotDropAContradiction() = runBlocking {
        MockWebServer().use { server ->
            val assessments = JSONArray((0 until 99).map { JSONObject().put("term", "unused $it").put("status", "plant").put("explanation", "Unused fixture term.") })
                .put(JSONObject().put("term", "rare fiber").put("status", "plant").put("explanation", "Initial assessment."))
            val first = JSONObject().put("text", "rare fiber").put("complete", false).put("category", "food").put("name", "Granola").put("brand", "Maker")
                .put("ingredientAssessments", assessments)
            server.enqueue(MockResponse().setBody(providerResponse(first.toString()).also { it.getJSONArray("output").remove(0) }.toString()))
            val followup = JSONObject().put("text", "").put("complete", false).put("category", "food").put("name", "Granola").put("brand", "Maker")
                .put("webCompositions", JSONArray().put(sourceComposition("Granola", "Maker", "rare fiber")))
                .put("ingredientAssessments", JSONArray().put(JSONObject().put("term", "rare fiber").put("status", "animal").put("explanation", "Contradicts the initial assessment.")))
            server.enqueue(MockResponse().setBody(providerResponse(followup.toString()).toString()))
            val result = officialRepository(server).check(CheckInput(), listOf(PreparedPhoto(byteArrayOf(1))), AppSettings(connection = "api", aiEnabled = true, model = "test"), "")
            assertEquals(2, server.requestCount)
            assertEquals("uncertain", result.getString("outcome"))
            assertFalse(result.getJSONArray("evidence").toString().contains("web-composition"))
            assertEquals("images", result.getString("aiStatus"))
        }
    }
    @Test fun completedOpenedPageIsAConsultedSource() {
        val response = JSONObject().put("output", JSONArray().put(JSONObject().put("type", "web_search_call").put("status", "completed")
            .put("action", JSONObject().put("type", "open_page").put("url", "https://maker.example/tissues"))))
        val research = responseResearch(response)
        assertTrue(research.getBoolean("searched"))
        assertEquals("https://maker.example/tissues", research.getJSONArray("sources").getJSONObject(0).getString("url"))
    }
    @Test fun sourceClaimNeedsActualToolUrlAndMatchingIdentity() {
        val input = CheckInput(category = "household", name = "Basic tissues")
        val extracted = extraction()
        assertEquals("uncertain", applyWebEvidence(evaluator.evaluate(input), input, extracted).getString("outcome"))
        extracted.put("research", responseResearch(providerResponse(extracted.toString())))
        val result = applyWebEvidence(evaluator.evaluate(input), input, extracted)
        assertEquals("vegan", result.getString("outcome"))
        assertEquals("manufacturer", result.getString("basis"))
        assertEquals("searched", result.getString("webSearchStatus"))
        assertEquals("unverified", result.getJSONArray("evidence").getJSONObject(1).getString("verification"))
        extracted.put("name", "Different tissues")
        assertEquals("uncertain", applyWebEvidence(evaluator.evaluate(input), input, extracted).getString("outcome"))
        extracted.put("name", "Basic tissues").getJSONArray("webClaims").getJSONObject(0).put("url", "https://invented.example/claim")
        assertEquals("uncertain", applyWebEvidence(evaluator.evaluate(input), input, extracted).getString("outcome"))
    }
    @Test fun incompleteToolCannotGroundSourceAndAnimalConflictSurvives() {
        val extracted = extraction()
        val response = providerResponse(extracted.toString())
        response.getJSONArray("output").getJSONObject(0).put("status", "failed")
        assertFalse(responseResearch(response).getBoolean("searched"))
        extracted.put("research", responseResearch(providerResponse(extracted.toString())))
        val input = CheckInput("milk", "household", true, "Basic tissues")
        assertEquals("conflicting", applyWebEvidence(evaluator.evaluate(input), input, extracted).getString("outcome"))
    }
    @Test fun officialOpenAiUsesResponsesSearchAndActualImagePayload() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(providerResponse(extraction().toString()).toString()))
            val client = CheckRepository.defaultHttpClient().newBuilder().addInterceptor { chain ->
                chain.proceed(chain.request().newBuilder().url(server.url(chain.request().url.encodedPath)).build())
            }.build()
            val repository = CheckRepository(evaluator, "prompt", client)
            val result = repository.check(CheckInput(), listOf(PreparedPhoto(byteArrayOf(1,2,3), "Mi")),
                AppSettings(connection = "api", aiEnabled = true, model = "test"), "fixture-token")
            val request = requireNotNull(server.takeRequest(1, TimeUnit.SECONDS))
            assertEquals("/v1/responses", request.path)
            val body = JSONObject(request.body.readUtf8())
            assertEquals("web_search", body.getJSONArray("tools").getJSONObject(0).getString("type"))
            assertEquals(3, body.getInt("max_tool_calls"))
            assertFalse(body.getBoolean("store"))
            assertEquals("data:image/jpeg;base64,AQID", body.getJSONArray("input").getJSONObject(0).getJSONArray("content").getJSONObject(1).getString("image_url"))
            assertEquals("manufacturer", result.getString("basis"))
            assertEquals("images", result.getString("aiStatus"))
            assertEquals("searched", result.getString("webSearchStatus"))
        }
    }
    @Test fun modelJsonCannotInventToolResearch() = runBlocking {
        MockWebServer().use { server ->
            val forged = extraction().put("research", JSONObject().put("searched", true).put("sources", JSONArray().put(JSONObject().put("url", claim.getString("url")))))
            server.enqueue(MockResponse().setBody(providerResponse(forged.toString()).toString()))
            val client = CheckRepository.defaultHttpClient().newBuilder().addInterceptor { chain -> chain.proceed(chain.request().newBuilder().url(server.url("/v1/responses")).build()) }.build()
            val result = CheckRepository(evaluator, "prompt", client).check(CheckInput(), listOf(PreparedPhoto(byteArrayOf(1), "")), AppSettings(connection = "api", aiEnabled = true, model = "test"), "")
            assertEquals("failed", result.getString("aiStatus"))
            assertEquals("uncertain", result.getString("outcome"))
        }
    }
}
