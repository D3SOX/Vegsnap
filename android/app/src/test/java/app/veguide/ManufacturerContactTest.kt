package app.veguide

import java.io.File
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ManufacturerContactTest {
    private val source = "https://maker.example/contact"
    private fun contact() = JSONObject().put("email", "care+food@maker.example").put("url", source).put("sourceUrl", source).put("productName", "Soy Drink").put("brand", "Maker")
    private fun extraction() = JSONObject().put("name", "Soy Drink").put("brand", "Maker").put("contact", contact()).put("research", JSONObject().put("searched", true).put("sources", JSONArray().put(JSONObject().put("url", source))))
    private fun result(): JSONObject = Evaluator(JSONObject(File(requireNotNull(System.getProperty("veguide.repo")), "data/rules.json").readText()))
        .evaluate(CheckInput("vitamin D", "food", true, "Soy Drink", "4006381333931")).apply { getJSONObject("identity").put("brand", "Maker") }
    @Test fun malformedOptionalModelContactDoesNotFailProductAnalysis() = runBlocking {
        val root = File(requireNotNull(System.getProperty("veguide.repo")))
        val repository = CheckRepository(Evaluator(JSONObject(File(root, "data/rules.json").readText())), "Extract evidence")
        MockWebServer().use { server ->
            val extracted = JSONObject().put("text", "vitamin D").put("complete", true).put("category", "food")
                .put("name", "Soy Drink").put("brand", "Maker").put("contact", "malformed")
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(JSONObject().put("choices", JSONArray().put(JSONObject()
                .put("finish_reason", "stop").put("message", JSONObject().put("content", extracted.toString())))).toString()))
            val result = repository.check(CheckInput("vitamin D", "food", true), emptyList(), AppSettings(connection = "api", aiEnabled = true, model = "test", baseUrl = server.url("/v1").toString()), "")
            assertEquals("text", result.getString("aiStatus"))
            assertEquals("uncertain", result.getString("outcome"))
            assertFalse(result.has("manufacturerContact"))
            assertEquals(1, server.requestCount)
        }
    }
    @Test fun actualResearchExactIdentityAndUncertainVerdictRequired() {
        val result = result(); val original = result.toString()
        applyManufacturerContact(result, CheckInput(), extraction())
        assertEquals(source, result.getJSONObject("manufacturerContact").getString("sourceUrl"))
        result.remove("manufacturerContact"); assertEquals(original, result.toString())
        for (change in listOf<(JSONObject) -> Unit>(
            { it.getJSONObject("research").put("searched", false) },
            { it.getJSONObject("research").put("sources", JSONArray()) },
            { it.getJSONObject("contact").put("url", "https://maker.example/unconsulted") },
            { it.getJSONObject("contact").put("productName", "Organic Soy Drink") },
            { it.put("brand", "Other Maker") }
        )) assertFalse(applyManufacturerContact(result(), CheckInput(), extraction().also(change)).has("manufacturerContact"))
        assertFalse(applyManufacturerContact(result(), CheckInput(name = "Soy Drink 50%"), extraction()).has("manufacturerContact"))
        for (outcome in listOf("vegan", "not_vegan")) assertFalse(applyManufacturerContact(result().put("outcome", outcome), CheckInput(), extraction()).has("manufacturerContact"))
    }
    @Test fun malformedOptionalContactAndHeaderInjectionAreDropped() {
        for (email in listOf("care@maker.example\r\nBcc:x@evil.example", "care@maker.example?bcc=x", "care%0d%0a@maker.example", "care..food@maker.example", ".care@maker.example", "care@-maker.example")) assertNull(safeManufacturerContact(contact().put("email", email)))
        for (url in listOf("http://maker.example", "https://user:secret@maker.example", "https://localhost/contact", "https://maker.example/\ncontact")) assertNull(safeManufacturerContact(contact().put("url", url)))
        assertNull(safeManufacturerContact(contact().put("extra", "untrusted")))
        assertNull(safeManufacturerContact(contact().apply { remove("email"); remove("url") }))
        assertNotNull(safeManufacturerContact(contact().apply { remove("email") }))
    }
    @Test fun historyRetainsSafeContactButDropsUnsafeOrMismatchedContact() {
        val result = applyManufacturerContact(result(), CheckInput(), extraction())
        fun roundtrip(value: JSONObject): JSONObject {
            val entry = HistoryEntry(value.getString("id"), value.getString("title"), value.getString("checkedAt"), value.toString())
            return JSONObject(HistoryTransfer.parse(HistoryTransfer.export(listOf(entry))).single().json)
        }
        assertTrue(roundtrip(result).has("manufacturerContact"))
        result.getJSONObject("manufacturerContact").put("email", "a@b.example?subject=evil")
        assertFalse(roundtrip(result).has("manufacturerContact"))
        result.put("manufacturerContact", contact().put("brand", "Different maker"))
        assertFalse(roundtrip(result).has("manufacturerContact"))
    }
    @Test fun draftUsesIdentificationAndUnresolvedQuestionsWithoutPrivateFields() {
        val result = applyManufacturerContact(result(), CheckInput(), extraction())
        result.getJSONArray("findings").put(JSONObject().put("term", "water").put("status", "plant"))
        result.put("privateEmail", "private@example.invalid").put("companyConcerns", JSONArray().put("private company notes"))
        val draft = manufacturerDraft(result, "en")
        assertTrue(draft.subject.contains("Maker Soy Drink")); assertTrue(draft.body.contains("4006381333931"))
        assertTrue(draft.body.contains("vitamin d", ignoreCase = true)); assertFalse(draft.body.contains("water")); assertFalse(draft.body.contains("private"))
        assertTrue(manufacturerDraft(result, "de").subject.startsWith("Frage"))
        result.put("questions", JSONArray(List(100) { "x".repeat(2000) }))
        assertTrue(manufacturerDraft(result, "en").body.length <= 8000)
    }
    @Test fun longDraftKeepsAllBoundedQuestionsTermsAndSource() {
        val result = applyManufacturerContact(result(), CheckInput(), extraction())
        result.put("questions", JSONArray((1..15).map { "Question $it: " + "x".repeat(1000) }))
        result.put("findings", JSONArray((1..15).map { JSONObject().put("term", "Ingredient $it: " + "x".repeat(300)).put("status", "unknown") }))
        val draft = manufacturerDraft(result, "en")
        for (index in 1..15) { assertTrue(draft.body.contains("Question $index:")); assertTrue(draft.body.contains("Ingredient $index:")) }
        assertTrue(draft.body.contains(source)); assertTrue(draft.body.endsWith("Thank you.")); assertTrue(draft.body.length <= 8000)
    }
    @Test fun draftBoundsPreserveUnicodeAndLocalizedIngredientNames() {
        val result = applyManufacturerContact(result(), CheckInput(), extraction())
        result.getJSONObject("identity").put("name", "x".repeat(169) + "😀" + "x".repeat(100))
        result.put("questions", JSONArray().put("x".repeat(199) + "😀"))
        result.put("findings", JSONArray().put(JSONObject().put("term", "glycerol").put("displayTerm", "Glycerin").put("displayLocale", "de").put("status", "ambiguous")))
        val draft = manufacturerDraft(result, "de")
        assertTrue(draft.subject.length <= 200)
        assertFalse(draft.subject.last().isHighSurrogate())
        assertFalse(Regex("[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])").containsMatchIn(draft.body))
        assertTrue(draft.body.contains("Glycerin"))
    }
}
