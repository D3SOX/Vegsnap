package org.veguide.android

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class IngredientTranslationsTest {
    private val root = File(requireNotNull(System.getProperty("veguide.repo")))
    private val translations = IngredientTranslations(JSONObject(File(root, "data/ingredient-translations.json").readText()))
    private val evaluator = Evaluator(JSONObject(File(root, "data/rules.json").readText()))
    @Test fun `saved Swedish findings and origin questions translate without reclassification or source mutation`() {
        val result = evaluator.evaluate(CheckInput("äppelsyra, naturlig arom, sötningsmedel", "food", true))
        val saved = result.toString()
        val english = translations.localize(result, "en")
        val german = translations.localize(result, "de")
        assertEquals(listOf("malic acid", "natural flavouring", "sweetener"), (0..2).map { english.getJSONArray("findings").getJSONObject(it).getString("displayTerm") })
        assertEquals(listOf("Äpfelsäure", "natürliches Aroma", "Süßungsmittel"), (0..2).map { german.getJSONArray("findings").getJSONObject(it).getString("displayTerm") })
        assertTrue(english.getJSONArray("questions").toString().contains("natural flavouring"))
        assertFalse(english.getJSONArray("questions").toString().contains("naturlig arom"))
        assertEquals(result.getString("outcome"), english.getString("outcome"))
        assertEquals(result.getJSONArray("evidence").toString(), english.getJSONArray("evidence").toString())
        for (index in 0..2) for (field in listOf("term", "status", "evidenceId")) assertEquals(result.getJSONArray("findings").getJSONObject(index).getString(field), english.getJSONArray("findings").getJSONObject(index).getString(field))
        assertEquals(saved, result.toString())
    }
    @Test fun `common condiments translate offline with source evidence and classification unchanged`() {
        val result = evaluator.evaluate(CheckInput("branntweinessig, gurken, knoblauch, zwiebeln, kräuter, chilis, zitronensaft aus zitronensaftkonzentrat, xanthan", "food", true))
        val shown = translations.localize(result, "en")
        assertEquals(listOf("spirit vinegar", "cucumbers", "garlic", "onions", "herbs", "chillies", "lemon juice from concentrate", "xanthan gum"),
            (0 until shown.getJSONArray("findings").length()).map { shown.getJSONArray("findings").getJSONObject(it).getString("displayTerm") })
        assertEquals(result.getString("outcome"), shown.getString("outcome"))
        assertEquals(result.getJSONArray("evidence").toString(), shown.getJSONArray("evidence").toString())
        for (index in 0 until result.getJSONArray("findings").length()) for (field in listOf("term", "status", "evidenceId")) {
            assertEquals(result.getJSONArray("findings").getJSONObject(index).getString(field), shown.getJSONArray("findings").getJSONObject(index).getString(field))
        }
        assertEquals("garlic", translations.translated("vitlök", "en"))
        assertEquals("Knoblauch", translations.translated("vitlök", "de"))
        assertEquals("Zitronensaft aus Konzentrat", translations.translated("citronjuice från koncentrat", "de"))
    }
    @Test fun `AI translation stays optional locale specific and cannot overwrite known animal origin`() {
        val input = CheckInput("milk, unfamiliar ingredient", "food", true)
        val extracted = JSONObject().put("text", input.text).put("complete", true).put("category", "food").put("ingredientAssessments", JSONArray()
            .put(JSONObject().put("term", "milk").put("translatedTerm", "oat drink").put("status", "plant").put("explanation", "Untrusted claim"))
            .put(JSONObject().put("term", "unfamiliar ingredient").put("translatedTerm", "translated ingredient").put("status", "unknown").put("explanation", "Unresolved")))
        validateAIEvidence(extracted)
        val result = applyAIEvidence(evaluator.evaluate(input), input, extracted, true, false)
        assertEquals("not_vegan", result.getString("outcome"))
        assertEquals("animal", result.getJSONArray("findings").getJSONObject(0).getString("status"))
        assertEquals("translated ingredient", result.getJSONArray("findings").getJSONObject(1).getString("displayTerm"))
        assertFalse(translations.localize(result, "en").getJSONArray("findings").getJSONObject(0).has("displayTerm"))
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
