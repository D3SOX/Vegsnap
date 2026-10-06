package app.veguide

import java.io.File
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AIIngredientsTest {
    private val root = File(requireNotNull(System.getProperty("veguide.repo")))
    private val evaluator = Evaluator(JSONObject(File(root, "data/rules.json").readText()))
    private val text = "Der Wirkstoff ist: Venlafaxin.\nDie sonstigen Bestandteile sind:\nKapselhülle: Gelatine, Eisen(III)-oxid (E172)\nDrucktinte: Schellack"
    private val terms = listOf("Venlafaxin", "Gelatine", "Eisen(III)-oxid (E172)", "Schellack")
    private val translations = listOf("Venlafaxine", "Gelatin", "Iron(III) oxide (E172)", "Shellac")
    private fun extraction(locale: String = "en") = JSONObject().put("text", text).put("complete", true).put("category", "other")
        .put("ingredients", JSONArray(terms)).put("ingredientAssessments", JSONArray(terms.mapIndexed { index, term ->
            JSONObject().put("term", term).put("translatedTerm", if (locale == "de") term else translations[index])
                .put("status", if (index in listOf(1, 3)) "animal" else "plant")
                .put("explanation", if (locale == "de") "Herkunft dieser Zutat bewertet." else "Origin of this ingredient assessed.")
        }))
    private fun findings(result: JSONObject) = result.getJSONArray("findings").let { array -> (0 until array.length()).map { array.getJSONObject(it) } }

    @Test fun `web medicine uses AI split ingredients and translations without headings or chemical fragments`() {
        for (locale in listOf("en", "de")) {
            val input = CheckInput(locale = locale)
            val extracted = extraction(locale).put("text", "").put("complete", false).put("name", "Venlafaxin Aurobindo 75 mg").put("brand", "Aurobindo")
                .put("research", JSONObject().put("searched", true).put("sources", JSONArray().put(JSONObject().put("url", "https://example.org/product"))))
                .put("webCompositions", JSONArray().put(JSONObject().put("url", "https://example.org/product").put("text", text).put("complete", true)
                    .put("productName", "Venlafaxin Aurobindo 75 mg").put("brand", "Aurobindo").put("sourceType", "retailer").put("ingredients", JSONArray(terms))))
            val result = applyWebCompositions(evaluator.evaluate(input), input, extracted, evaluator)
            assertEquals("not_vegan", result.getString("outcome"))
            assertEquals(terms.map(::normalizeCompositionTerm), findings(result).map { it.getString("term") })
            for (index in terms.indices) assertEquals(if (locale == "de") terms[index] else translations[index], findings(result)[index].getString("displayTerm"))
            assertTrue(result.getJSONArray("evidence").toString().contains(text.replace("\n", "\\n")))
        }
    }

    @Test fun `explicit text check replaces same source fragments and applies AI ingredient names`() = runBlocking {
        MockWebServer().use { server ->
            val body = JSONObject().put("choices", JSONArray().put(JSONObject().put("finish_reason", "stop")
                .put("message", JSONObject().put("content", extraction().toString()))))
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(body.toString()))
            val repository = CheckRepository(evaluator, "Extract ingredients")
            val result = repository.check(CheckInput(text, "other", true), emptyList(),
                AppSettings(connection = "api", aiEnabled = true, baseUrl = server.url("/v1").toString(), model = "test"), "")
            assertEquals("not_vegan", result.getString("outcome"))
            assertEquals(terms.map(::normalizeCompositionTerm), findings(result).map { it.getString("term") })
            assertTrue(result.getBoolean("usedAI"))
            assertEquals("Shellac", findings(result)[3].getString("displayTerm"))
        }
    }

    @Test fun `model omissions cannot erase known animal or ambiguous ingredients`() {
        for ((source, status) in listOf("water, milk" to "animal", "water, glycerin" to "ambiguous", "water\nKapselhülle: Gelatine" to "animal", "water\nDrucktinte: Schellack" to "animal")) {
            val result = evaluator.evaluate(CheckInput(source, "food", true), listOf("water"))
            assertTrue(source, findings(result).any { it.getString("status") == status })
            assertEquals(if (status == "animal") "not_vegan" else "uncertain", result.getString("outcome"))
        }
    }

    @Test fun `source grounding rejects invented partial words and precaution only ingredients`() {
        assertEquals(listOf("eisen(iii)-oxid (e172)"), parseSourceIngredients("Eisen(III)-oxid (E172)", JSONArray().put("eisen(III)-oxid (E172)")))
        assertEquals(listOf("water", "salt"), parseSourceIngredients("Water,\n  SALT", JSONArray().put("water").put("Salt")))
        assertNull(parseSourceIngredients("water", JSONArray().put("milk")))
        assertNull(parseSourceIngredients("peanut", JSONArray().put("nut")))
        assertNull(parseSourceIngredients("water, salt. May contain milk", JSONArray().put("water").put("milk")))
        assertNull(parseSourceIngredients("water, salt. Kann Spuren von Milch enthalten", JSONArray().put("water").put("Milch")))
        assertNull(parseSourceIngredients("water", JSONArray().put("")))
        assertNull(parseSourceIngredients("water", JSONArray()))
        assertEquals(0, evaluator.evaluate(CheckInput(), emptyList()).getJSONArray("warnings").length())
        val fallback = evaluator.evaluate(CheckInput("water, mystery", "food", true), listOf("invented"))
        assertEquals(listOf("water", "mystery"), findings(fallback).map { it.getString("term") })
        assertEquals("uncertain", fallback.getString("outcome"))
        assertTrue(fallback.getJSONArray("warnings").toString().contains("local splitting was used"))
    }

    @Test fun `missing AI assessment stays unknown and names the AI limitation`() {
        for (locale in listOf("en", "de")) {
            val input = CheckInput("Kapselinhalt: mystery", "food", true, locale = locale)
            val extracted = JSONObject().put("ingredients", JSONArray().put("mystery"))
            val result = applyAIEvidence(evaluator.evaluate(input, listOf("mystery")), input, extracted, true, false)
            assertEquals("uncertain", result.getString("outcome"))
            assertEquals("unknown", findings(result).single().getString("status"))
            assertEquals(if (locale == "de") "Die KI konnte die Herkunft dieser Zutat nicht feststellen." else "The AI did not establish the origin of this ingredient.", findings(result).single().getString("explanation"))
        }
    }

    @Test fun `replacing a split keeps independent database evidence`() {
        val initial = evaluator.evaluate(CheckInput("mystery", "food", true))
        val database = evaluator.evaluate(CheckInput("mystery", "food", true))
        database.getJSONArray("evidence").getJSONObject(0).put("id", "openfoodfacts")
        findings(database).forEach { it.put("evidenceId", "openfoodfacts") }
        val result = withoutCompositionFindings(mergeResults(initial, database), "mystery")
        assertEquals("openfoodfacts", findings(result).single().getString("evidenceId"))
        assertEquals(2, result.getJSONArray("evidence").length())
    }

    @Test fun `parsed list bounds apply to direct and web extractions`() {
        for (invalid in listOf(JSONArray().put(7), JSONArray().put(" "), JSONArray().put("x".repeat(301)), JSONArray(List(101) { "water" }))) {
            try { validateAIEvidence(JSONObject().put("ingredients", invalid)); fail("Invalid direct ingredient list") } catch (_: IllegalArgumentException) { }
            val composition = JSONObject().put("url", "https://example.org/product").put("text", "water").put("complete", true)
                .put("sourceType", "manufacturer").put("productName", "Product").put("brand", "Maker").put("ingredients", invalid)
            try { validateWebCompositions(JSONObject().put("webCompositions", JSONArray().put(composition))); fail("Invalid web ingredient list") } catch (_: IllegalArgumentException) { }
        }
    }

    @Test fun `research enriches the same source split without duplicating composition or losing valid parsing`() {
        val first = JSONObject().put("url", "https://example.org/product").put("text", "water, salt").put("complete", true)
            .put("sourceType", "manufacturer").put("productName", "Product").put("brand", "Maker")
        val parsed = JSONObject(first.toString()).put("ingredients", JSONArray().put("water").put("salt"))
        val invalid = JSONObject(first.toString()).put("ingredients", JSONArray().put("invented"))
        val merged = mergeSourceCompositions(listOf(first, parsed, invalid, first))
        assertEquals(1, merged.size)
        assertEquals(listOf("water", "salt"), parseSourceIngredients(merged.single().getString("text"), merged.single().getJSONArray("ingredients")))
        val otherRecipe = JSONObject(parsed.toString()).put("text", "water, milk").put("ingredients", JSONArray().put("water").put("milk"))
        assertEquals(2, mergeSourceCompositions(listOf(parsed, otherRecipe)).size)
    }

    @Test fun `fixed AI fallback copy follows later app language changes without translating source ingredients`() {
        val source = evaluator.evaluate(CheckInput("mystery", "food", true), listOf("invented"))
        findings(source).single().put("explanation", "The AI did not establish the origin of this ingredient.")
        val translations = ResultTextTranslations(JSONObject(File(root, "data/result-translations.json").readText()), JSONObject(File(root, "data/rules.json").readText()))
        val shown = translations.localize(source, "de")
        assertEquals("Die KI konnte die Herkunft dieser Zutat nicht feststellen.", findings(shown).single().getString("explanation"))
        assertTrue(shown.getJSONArray("warnings").toString().contains("die lokale Aufteilung wurde verwendet"))
        assertEquals("mystery", findings(shown).single().getString("term"))
        assertEquals(source.getJSONArray("evidence").toString(), shown.getJSONArray("evidence").toString())
    }

    @Test fun `missing assessment wording does not relabel an independent database finding for the same term`() {
        val input = CheckInput("mystery", "food", true)
        val extracted = JSONObject().put("ingredients", JSONArray().put("mystery"))
        val database = evaluator.evaluate(input)
        database.getJSONArray("evidence").getJSONObject(0).put("id", "database")
        findings(database).forEach { it.put("evidenceId", "database") }
        val result = applyAIEvidence(mergeResults(evaluator.evaluate(input, listOf("mystery")), database), input, extracted, true, false)
        assertEquals("database", findings(result).single().getString("evidenceId"))
        assertEquals("Origin is not established by the bundled rules.", findings(result).single().getString("explanation"))
    }
}
