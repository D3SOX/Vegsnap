package app.veguide

import java.io.File
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CompanyAssessmentTest {
    private val url = "https://maker.example/policy"
    private val ownership = "https://parent.example/brands"
    private val evaluator = Evaluator(JSONObject(File(requireNotNull(System.getProperty("veguide.repo")), "data/rules.json").readText()))
    private fun assessment() = JSONObject().put("brand", "Maker").put("company", "Maker Ltd").put("scope", "direct")
        .put("verdict", "concerns_found").put("summary", "The company's policy allows testing required by law; this does not establish testing of this product.")
        .put("categories", JSONArray().put("animal_testing"))
        .put("sources", JSONArray().put(JSONObject().put("url", url).put("title", "Animal testing policy").put("quote", "Testing may be required by law.")))
    private fun extraction() = JSONObject().put("text", "").put("complete", false).put("category", "food").put("name", "Soy Drink").put("brand", "Maker")
        .put("companyAssessment", assessment()).put("research", JSONObject().put("searched", true).put("sources", JSONArray().put(JSONObject().put("url", url))))
    private fun result() = evaluator.evaluate(CheckInput("water, salt", "food", true, "Soy Drink")).apply { getJSONObject("identity").put("brand", "Maker") }
    @Test fun companyEvidenceNeverChangesProductVerdictOrCuratedRecords() {
        for (outcome in listOf("vegan", "not_vegan", "uncertain", "conflicting")) {
            val result = result().put("outcome", outcome)
            val before = result.toString()
            applyCompanyAssessment(result, extraction())
            assertEquals("concerns_found", result.getJSONObject("companyAssessment").getString("verdict"))
            assertEquals(result.getString("checkedAt"), result.getJSONObject("companyAssessment").getString("assessedAt"))
            result.remove("companyAssessment")
            assertEquals(before, result.toString())
        }
    }
    @Test fun requiresActualConsultedSourcesAndExactBrand() {
        val changes = listOf<(JSONObject) -> Unit>(
            { it.getJSONObject("research").put("searched", false) },
            { it.getJSONObject("research").put("sources", JSONArray()) },
            { it.getJSONObject("companyAssessment").put("brand", "Other Maker") },
            { it.put("brand", "Organic Maker") },
            { it.getJSONObject("companyAssessment").put("ownershipSourceUrl", ownership) }
        )
        for (change in changes) assertFalse(applyCompanyAssessment(result(), extraction().also(change)).has("companyAssessment"))
        assertFalse(applyCompanyAssessment(result().apply { getJSONObject("identity").put("brand", "Other") }, extraction()).has("companyAssessment"))
        assertTrue(applyCompanyAssessment(result(), extraction().apply { getJSONObject("companyAssessment").put("brand", "  ＭＡＫＥＲ  ") }).has("companyAssessment"))
    }
    @Test fun parentAssessmentNeedsConsultedOwnershipSource() {
        val extraction = extraction()
        val assessment = extraction.getJSONObject("companyAssessment").put("scope", "parent").put("company", "Parent")
        assertFalse(applyCompanyAssessment(result(), extraction).has("companyAssessment"))
        assessment.put("ownershipSourceUrl", ownership)
        assertFalse(applyCompanyAssessment(result(), extraction).has("companyAssessment"))
        extraction.getJSONObject("research").getJSONArray("sources").put(JSONObject().put("url", ownership))
        assertTrue(applyCompanyAssessment(result(), extraction).has("companyAssessment"))
    }
    @Test fun malformedOptionalAssessmentIsDropped() {
        for (value in listOf(
            assessment().put("summary", "x".repeat(1501)), assessment().put("categories", JSONArray()),
            assessment().put("brand", "Maker\n"), assessment().put("summary", "bad\u0085control"),
            assessment().put("categories", JSONArray().put("animal_testing").put("animal_testing")),
            assessment().put("verdict", "no_concerns_found"), assessment().put("extra", "unexpected"),
            assessment().put("sources", JSONArray()), assessment().apply { getJSONArray("sources").getJSONObject(0).put("url", "https://user:password@maker.example") },
            assessment().apply { getJSONArray("sources").getJSONObject(0).put("url", "https://localhost/policy") },
            assessment().put("assessedAt", "2026-10-07T00:00:00Z")
        )) assertNull(safeCompanyAssessment(value))
        assertNotNull(safeCompanyAssessment(assessment().put("verdict", "no_concerns_found").put("categories", JSONArray())))
        assertNotNull(safeCompanyAssessment(assessment().put("verdict", "inconclusive").put("categories", JSONArray())))
    }
    @Test fun historyRetainsAssessmentWithoutTrustingMalformedOrWrongBrandContent() {
        fun roundtrip(value: JSONObject): JSONObject {
            val entry = HistoryEntry(value.getString("id"), value.getString("title"), value.getString("checkedAt"), value.toString())
            return JSONObject(HistoryTransfer.parse(HistoryTransfer.export(listOf(entry))).single().json)
        }
        val result = applyCompanyAssessment(result(), extraction())
        assertEquals(url, roundtrip(result).getJSONObject("companyAssessment").getJSONArray("sources").getJSONObject(0).getString("url"))
        result.getJSONObject("companyAssessment").put("assessedAt", "not a date")
        assertFalse(roundtrip(result).has("companyAssessment"))
        applyCompanyAssessment(result, extraction()).getJSONObject("companyAssessment").put("brand", "Other")
        assertFalse(roundtrip(result).has("companyAssessment"))
    }
    @Test fun importedAssessmentAlwaysCarriesAnUnverifiedNoticeWithoutGrowingOnReimport() {
        for (locale in listOf("en", "de")) {
            val value = applyCompanyAssessment(result(), extraction())
            value.put("warnings", JSONArray((0 until 100).map { "Existing warning $it" }))
            val document = JSONObject().put("schemaVersion", 1).put("results", JSONArray().put(value)).toString()
            val imported = HistoryTransfer.parse(document, locale).single()
            val clean = JSONObject(imported.json)
            val warnings = clean.getJSONArray("warnings")
            assertEquals(100, warnings.length())
            assertTrue(warnings.getString(99).startsWith(if (locale == "de") "Importierte Unternehmensbewertung:" else "Imported company assessment:"))
            assertEquals(value.getString("outcome"), clean.getString("outcome"))
            val again = JSONObject(HistoryTransfer.parse(HistoryTransfer.export(listOf(imported), locale), locale).single().json)
            assertEquals(warnings.toString(), again.getJSONArray("warnings").toString())
        }
    }

    private fun response(extracted: JSONObject, searched: Boolean): JSONObject {
        val output = JSONArray()
        if (searched) output.put(JSONObject().put("type", "web_search_call").put("status", "completed").put("action", JSONObject().put("sources", JSONArray().put(JSONObject().put("url", url)))))
        output.put(JSONObject().put("type", "message").put("content", JSONArray().put(JSONObject().put("type", "output_text").put("text", extracted.toString()))))
        return JSONObject().put("status", "completed").put("output", output)
    }
    private fun repository(server: MockWebServer) = CheckRepository(evaluator, "Extract evidence",
        CheckRepository.defaultHttpClient().newBuilder().addInterceptor { chain -> chain.proceed(chain.request().newBuilder().url(server.url("/v1/responses")).build()) }.build())
    @Test fun malformedModelFieldDoesNotFailProductAnalysis() = runBlocking {
        MockWebServer().use { server ->
            val extracted = extraction().apply { remove("research") }.put("text", "water, salt").put("complete", true).put("companyAssessment", "invalid")
            server.enqueue(MockResponse().setBody(response(extracted, true).toString()))
            val result = repository(server).check(CheckInput(), listOf(PreparedPhoto(byteArrayOf(1))), AppSettings(connection = "api", model = "test", aiEnabled = true), "")
            assertEquals("vegan", result.getString("outcome")); assertEquals("images", result.getString("aiStatus"))
            assertFalse(result.has("companyAssessment")); assertEquals(1, server.requestCount)
        }
    }
    @Test fun followupResearchKeepsCompanyAssessmentAndItsActualProvenance() = runBlocking {
        MockWebServer().use { server ->
            val initial = extraction().apply { remove("research"); remove("companyAssessment") }
            server.enqueue(MockResponse().setBody(response(initial, false).toString()))
            server.enqueue(MockResponse().setBody(response(extraction().apply { remove("research") }, true).toString()))
            val result = repository(server).check(CheckInput(), listOf(PreparedPhoto(byteArrayOf(1))), AppSettings(connection = "api", model = "test", aiEnabled = true), "")
            assertEquals(2, server.requestCount); assertEquals("uncertain", result.getString("outcome"))
            assertEquals("concerns_found", result.getJSONObject("companyAssessment").getString("verdict"))
        }
    }
    @Test fun unsourcedFollowupAssessmentDoesNotEraseSupportedInitialAssessment() = runBlocking {
        MockWebServer().use { server ->
            val initial = extraction().apply { remove("research") }.put("webCompositions", JSONArray().put(JSONObject()
                .put("url", url).put("text", "vitamin D").put("complete", true).put("sourceType", "manufacturer")
                .put("productName", "Soy Drink").put("brand", "Maker")))
            val followup = extraction().apply { remove("research") }
            followup.getJSONObject("companyAssessment").getJSONArray("sources").getJSONObject(0).put("url", "https://invented.example/policy")
            server.enqueue(MockResponse().setBody(response(initial, true).toString()))
            server.enqueue(MockResponse().setBody(response(followup, true).toString()))
            val result = repository(server).check(CheckInput(), listOf(PreparedPhoto(byteArrayOf(1))), AppSettings(connection = "api", model = "test", aiEnabled = true), "")
            assertEquals(2, server.requestCount)
            assertEquals(url, result.getJSONObject("companyAssessment").getJSONArray("sources").getJSONObject(0).getString("url"))
        }
    }

}
