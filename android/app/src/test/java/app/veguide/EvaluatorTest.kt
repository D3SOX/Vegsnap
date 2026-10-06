package app.veguide

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class EvaluatorTest {
    private val root = File(requireNotNull(System.getProperty("veguide.repo")))
    private val evaluator = Evaluator(JSONObject(File(root, "data/rules.json").readText()))
    @Test fun footwearRolesAndBlendsIdentifyLeatherWithoutTreatingThePageTitleAsMaterial() {
        val title = "adidas originals aspyre - trainers - cloud white/grey one/white - zalando"
        val result = evaluator.evaluate(CheckInput("$title\nObermaterial: Leder/Synthetik\nInnenmaterial: Textil\nInnensohle: Kunststoff", "shoes"))
        assertEquals("not_vegan", result.getString("outcome"))
        val findings = result.getJSONArray("findings")
        assertEquals(listOf("leder", "synthetik", "textil", "kunststoff"), (0 until findings.length()).map { findings.getJSONObject(it).getString("term") })
        assertEquals(listOf("animal", "plant", "ambiguous", "plant"), (0 until findings.length()).map { findings.getJSONObject(it).getString("status") })
        assertEquals(0, evaluator.evaluate(CheckInput(title, "shoes", name = title)).getJSONArray("findings").length())
        assertEquals("not_vegan", evaluator.evaluate(CheckInput("Milk", "food", name = "Milk")).getString("outcome"))
    }
    @Test fun footwearKeepsUnknownFibresAndTextileAmbiguitySeparateFromSynthetics() {
        val result = evaluator.evaluate(CheckInput("Upper: synthetic leather/plastic\nLining: textile\nInsole: mysterious fibre", "shoes", true))
        val findings = result.getJSONArray("findings")
        assertEquals(listOf("plant", "plant", "ambiguous", "unknown"), (0 until findings.length()).map { findings.getJSONObject(it).getString("status") })
        assertEquals("uncertain", result.getString("outcome"))
        assertEquals("not_vegan", evaluator.evaluate(CheckInput("echtes Leder", "shoes")).getString("outcome"))
    }
    @Test fun aiMaterialAssessmentsUseTheSameRoleAndBlendTokenizerWithoutOverridingAmbiguousTextile() {
        val text = "Obermaterial: novel polymer/another polymer\nInnenmaterial: Textil"
        val input = CheckInput(text, "shoes", true)
        val extracted = JSONObject().put("ingredientAssessments", JSONArray()
            .put(JSONObject().put("term", "Obermaterial: novel polymer/another polymer").put("status", "plant").put("explanation", "Both named materials are synthetic polymers."))
            .put(JSONObject().put("term", "Innenmaterial: Textil").put("status", "plant").put("explanation", "Unsupported claim that all textile is plant-based.")))
        val result = applyAIEvidence(evaluator.evaluate(input), input, extracted, true, false)
        val findings = result.getJSONArray("findings")
        assertEquals(listOf("plant", "plant", "ambiguous"), (0 until findings.length()).map { findings.getJSONObject(it).getString("status") })
        assertEquals("uncertain", result.getString("outcome"))
    }
    @Test fun animalMaterialRoleAppliesToOneMaterialWithoutAssigningEveryBlendComponent() {
        val input = CheckInput("Upper: unfamiliar hide\nLining: novel fibre/another fibre", "shoes", true)
        val extracted = JSONObject().put("ingredientAssessments", JSONArray()
            .put(JSONObject().put("term", "Upper: unfamiliar hide").put("status", "animal").put("explanation", "This named material is animal hide."))
            .put(JSONObject().put("term", "Lining: novel fibre/another fibre").put("status", "animal").put("explanation", "The blend includes animal content, without identifying which fibre.")))
        val result = applyAIEvidence(evaluator.evaluate(input), input, extracted, true, false)
        val findings = result.getJSONArray("findings")
        assertEquals(listOf("animal", "unknown", "unknown"), (0 until findings.length()).map { findings.getJSONObject(it).getString("status") })
        assertEquals("not_vegan", result.getString("outcome"))
    }
    @Test fun barcodeIsIdentityNotAnIngredientOrCompleteVeganList() {
        val code = "7311041068182"
        val result = evaluator.evaluate(CheckInput(code, "food", true, barcode = code))
        assertEquals(0, result.getJSONArray("findings").length())
        assertEquals("uncertain", result.getString("outcome"))
        assertEquals(code, result.getJSONObject("identity").getString("barcode"))
        assertEquals("not_vegan", evaluator.evaluate(CheckInput("$code, milk", "food", true)).getString("outcome"))
    }
    @Test fun sharedCompositionFixtures() {
        val fixtures = JSONArray(File(root, "fixtures/composition.json").readText())
        for (index in 0 until fixtures.length()) {
            val case = fixtures.getJSONObject(index)
            val input = case.getJSONObject("input")
            val actual = evaluator.evaluate(CheckInput(input.optString("text"), input.optString("category", "other"),
                if (input.has("complete")) input.getBoolean("complete") else null, name = input.optString("name"), locale = input.optString("locale", "en")))
            val expected = case.getJSONObject("expected")
            assertEquals(case.getString("id"), expected.getString("outcome"), actual.getString("outcome"))
            assertEquals(case.getString("id"), expected.getString("basis"), actual.getString("basis"))
        }
    }
    @Test fun completeAutoPlantListAsksForCategoryInsteadOfEmptyIngredientOrigin() {
        for ((locale, question) in listOf("en" to "Identify the product category to assess its ingredients and production requirements.", "de" to "Die Produktkategorie bestimmen, um Zutaten und Herstellungsverfahren zu bewerten.")) {
            val result = evaluator.evaluate(CheckInput("water, salt", "other", true, locale = locale))
            assertEquals("uncertain", result.getString("outcome"))
            assertEquals(question, result.getJSONArray("questions").getString(0))
        }
    }
    @Test fun precautionaryAllergenDoesNotBecomeIngredient() {
        val result = evaluator.evaluate(CheckInput("Zutaten: Wasser, Salz. Kann Spuren von Milch enthalten.", "food"))
        assertEquals("vegan", result.getString("outcome"))
        assertEquals(1, result.getJSONArray("crossContact").length())
    }
    @Test fun swedishPrecautionAndPlantCompoundsUseWholeTerms() {
        val result = evaluator.evaluate(CheckInput("Ingredienser: havremjölk, kakaosmör, salt. Kan innehålla spår av mjölk och ägg.", "food"))
        assertEquals("vegan", result.getString("outcome"))
        assertEquals("Kan innehålla spår av mjölk och ägg.", result.getJSONArray("crossContact").getString(0))
        val findings = result.getJSONArray("findings")
        assertEquals(listOf("oat", "cocoa-butter", "salt"), (0 until findings.length()).map { findings.getJSONObject(it).getString("ruleId") })
        val unknown = evaluator.evaluate(CheckInput("Ingredienser: vatten, okänd tillsats", "food"))
        assertEquals("uncertain", unknown.getString("outcome"))
        assertEquals("unknown", unknown.getJSONArray("findings").getJSONObject(1).getString("status"))
    }
    @Test fun extractedPartialListStaysUncertain() {
        assertEquals("uncertain", evaluator.evaluate(CheckInput("Ingredients: water, salt", "food", false)).getString("outcome"))
    }
    @Test fun textAiCannotDropUnknownOrAnimalIngredients() {
        assertTrue(validTextExtraction("Ingredients: water, unknown additive", "water, unknown additive"))
        assertFalse(validTextExtraction("Ingredients: water, unknown additive", "water"))
        assertFalse(validTextExtraction("milk, water", "water"))
        assertTrue(validTextExtraction("Ingredienser: vatten, okänd tillsats", "vatten, okänd tillsats"))
        assertFalse(validTextExtraction("Ingredienser: vatten, mjölk", "vatten"))
    }
    @Test fun gtinRejectsSimilarButDifferentBarcode() {
        assertTrue(validGtin("4006381333931"))
        assertFalse(validGtin("4006381333932"))
        assertFalse(validGtin("123"))
    }
    @Test fun credentialEndpointsCannotEmbedSecretsOrUseUnencryptedRemoteHost() {
        assertTrue(validEndpoint("https://api.openai.com/v1"))
        assertTrue(validEndpoint("http://127.0.0.1:11434/v1"))
        assertFalse(validEndpoint("https://user:key@example.org/v1"))
        assertFalse(validEndpoint("http://192.168.1.3:11434/v1"))
        assertFalse(validEndpoint("https://api.example.org/v1?token=secret"))
    }
    @Test fun historyRoundTripExcludesNonResultFields() {
        val result = evaluator.evaluate(CheckInput("Ingredients: milk", "food"))
        result.put("apiKey", "do-not-import")
        val text = JSONObject().put("schemaVersion", 1).put("results", JSONArray().put(result)).toString()
        val imported = HistoryTransfer.parse(text)
        assertEquals(1, imported.size)
        assertFalse(imported.single().json.contains("do-not-import"))
        assertEquals(result.getString("id"), JSONObject(HistoryTransfer.export(imported)).getJSONArray("results").getJSONObject(0).getString("id"))
    }
    @Test fun historyPreservesTranslationsAndRegeneratesSafeErrorsInAppLanguage() {
        val result = evaluator.evaluate(CheckInput("milk", "food"))
        result.getJSONArray("findings").getJSONObject(0).put("displayTerm", "Milch").put("displayLocale", "de")
        result.put("aiStatus", "failed").put("aiError", JSONObject().put("code", "quota").put("message", "raw private-token").put("secret", "extra"))
        val document = JSONObject().put("schemaVersion", 1).put("results", JSONArray().put(result)).toString()
        val imported = HistoryTransfer.parse(document, "de")
        val clean = JSONObject(imported.single().json)
        assertEquals("Milch", clean.getJSONArray("findings").getJSONObject(0).getString("displayTerm"))
        assertEquals("milk", clean.getJSONArray("findings").getJSONObject(0).getString("term"))
        assertEquals("quota", clean.getJSONObject("aiError").getString("code"))
        assertTrue(clean.getJSONObject("aiError").getString("message").contains("Nutzungslimit"))
        assertEquals(2, clean.getJSONObject("aiError").length())
        assertFalse(clean.toString().contains("private-token"))
        val exported = JSONObject(HistoryTransfer.export(imported, "en"))
        java.time.Instant.parse(exported.getString("exportedAt"))
        assertTrue(exported.getJSONArray("results").getJSONObject(0).getJSONObject("aiError").getString("message").contains("usage limit"))
        result.getJSONObject("aiError").put("code", "unrecognized-secret")
        val unknown = HistoryTransfer.parse(JSONObject().put("schemaVersion", 1).put("results", JSONArray().put(result)).toString())
        assertFalse(JSONObject(unknown.single().json).has("aiError"))
    }
    @Test fun historyRejectsUnboundedOrUnpairedTranslationMetadata() {
        for (translation in listOf(JSONObject().put("displayTerm", "Milch"), JSONObject().put("displayTerm", "x".repeat(301)).put("displayLocale", "de"))) {
            val result = evaluator.evaluate(CheckInput("milk", "food"))
            val finding = result.getJSONArray("findings").getJSONObject(0)
            translation.keys().forEach { finding.put(it, translation.get(it)) }
            val document = JSONObject().put("schemaVersion", 1).put("results", JSONArray().put(result)).toString()
            assertThrows(IllegalArgumentException::class.java) { HistoryTransfer.parse(document) }
        }
    }
    @Test(expected = IllegalArgumentException::class) fun historyRejectsUnknownOutcome() {
        val result = evaluator.evaluate(CheckInput()).put("outcome", "definitely_vegan")
        HistoryTransfer.parse(JSONObject().put("schemaVersion", 1).put("results", JSONArray().put(result)).toString())
    }
}
