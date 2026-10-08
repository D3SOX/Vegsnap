package app.vegsnap

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class IngredientTranslationsTest {
    private val root = File(requireNotNull(System.getProperty("vegsnap.repo")))
    private val translations = IngredientTranslations()
    private val evaluator = Evaluator(JSONObject(File(root, "data/rules.json").readText()))
    @Test fun `display uses AI translations for their saved locale and keeps original evidence`() {
        val result = evaluator.evaluate(CheckInput("äppelsyra, naturlig arom", "food", true))
        assertFalse(translations.localize(result, "en").getJSONArray("findings").getJSONObject(0).has("displayTerm"))
        result.getJSONArray("findings").getJSONObject(1).put("displayTerm", "natural flavouring").put("displayLocale", "en")
        val saved = result.toString()
        val shown = translations.localize(result, "en")
        assertEquals("natural flavouring", shown.getJSONArray("findings").getJSONObject(1).getString("displayTerm"))
        assertTrue(shown.getJSONArray("questions").toString().contains("natural flavouring"))
        assertFalse(translations.localize(result, "de").getJSONArray("findings").getJSONObject(1).has("displayTerm"))
        assertEquals(result.getString("outcome"), shown.getString("outcome"))
        assertEquals(result.getJSONArray("evidence").toString(), shown.getJSONArray("evidence").toString())
        assertEquals(saved, result.toString())
    }
    @Test fun `AI translation stays optional locale specific and cannot overwrite known animal origin`() {
        val input = CheckInput("milk, unfamiliar ingredient", "food", true)
        val extracted = JSONObject().put("text", input.text).put("complete", true).put("category", "food").put("ingredientAssessments", JSONArray()
            .put(JSONObject().put("term", "milk").put("translatedTerm", "milk").put("status", "plant").put("explanation", "Untrusted claim"))
            .put(JSONObject().put("term", "unfamiliar ingredient").put("translatedTerm", "translated ingredient").put("status", "unknown").put("explanation", "Unresolved")))
        validateAIEvidence(extracted)
        val result = applyAIEvidence(evaluator.evaluate(input), input, extracted, true, false)
        assertEquals("not_vegan", result.getString("outcome"))
        assertEquals("animal", result.getJSONArray("findings").getJSONObject(0).getString("status"))
        assertEquals("translated ingredient", result.getJSONArray("findings").getJSONObject(1).getString("displayTerm"))
        assertEquals("milk", result.getJSONArray("findings").getJSONObject(0).getString("term"))
        assertFalse(translations.localize(result, "de").getJSONArray("findings").getJSONObject(1).has("displayTerm"))
        for (bad in listOf<Any>(7, "", " ", "x".repeat(301))) {
            val invalid = JSONObject(extracted.toString())
            invalid.getJSONArray("ingredientAssessments").getJSONObject(0).put("translatedTerm", bad)
            try { validateAIEvidence(invalid); fail("Invalid translation must be rejected") } catch (_: IllegalArgumentException) { }
        }
    }
    @Test fun `parent ingredient translation is never copied to split components`() {
        val input = CheckInput("mystery blend (cotton)", "clothing", true)
        val extracted = JSONObject().put("text", input.text).put("ingredientAssessments", JSONArray().put(JSONObject()
            .put("term", input.text).put("translatedTerm", "translated whole blend").put("status", "plant").put("explanation", "Plant fibres")))
        val result = applyAIEvidence(evaluator.evaluate(input), input, extracted, true, false).getJSONArray("findings")
        for (index in 0 until result.length()) assertFalse(result.getJSONObject(index).has("displayTerm"))
    }
    @Test fun `database duplicate keeps translation without altering its status or evidence`() {
        val current = evaluator.evaluate(CheckInput("unfamiliar ingredient", "food", true))
        current.getJSONArray("findings").getJSONObject(0).put("displayTerm", "translated ingredient").put("displayLocale", "en")
        val database = evaluator.evaluate(CheckInput("unfamiliar ingredient", "food", true))
        database.getJSONArray("findings").getJSONObject(0).put("evidenceId", "database-source")
        val result = mergeResults(current, database)
        assertEquals("translated ingredient", result.getJSONArray("findings").getJSONObject(0).getString("displayTerm"))
        assertEquals("database-source", result.getJSONArray("findings").getJSONObject(0).getString("evidenceId"))
        assertEquals("unknown", result.getJSONArray("findings").getJSONObject(0).getString("status"))
        assertEquals(current.getString("outcome"), result.getString("outcome"))
    }

}
