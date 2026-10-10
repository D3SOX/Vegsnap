package app.vegsnap

import java.io.File
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import okhttp3.HttpUrl.Companion.toHttpUrl

class VeganAlternativesTest {
    private val root = File(requireNotNull(System.getProperty("vegsnap.repo")))
    private val evaluator = Evaluator(JSONObject(File(root, "data/rules.json").readText()))
    private val input = AlternativeQuery("chocolate", "REWE", "food", "DE", "en", "4006381333931")
    @Test fun queryKeepsTheProductTypeInsteadOfTheAnimalIngredient() {
        assertEquals("granola", alternativeQueryForProduct("Maker Honey granola", "Maker", listOf("honey")))
        assertEquals("Milk", alternativeQueryForProduct("Milk", "", listOf("milk")))
    }
    @Test fun publicRecordsShareCoreRankingAndSafetyRules() {
        val fixture = JSONObject(File(root, "contracts/alternatives-fixtures.json").readText())
        val items = parsePublicAlternatives(fixture.getJSONObject("document"), input, evaluator)
        assertEquals(fixture.getJSONArray("expectedCodes").stringValues(), items.map { it.barcode })
        assertTrue(items.first().storeMatch)
        val taggedOnly = JSONObject(fixture.getJSONObject("document").toString())
        val product = taggedOnly.getJSONArray("products").getJSONObject(0).put("stores", "").put("stores_tags", org.json.JSONArray().put("rewe"))
        assertEquals(listOf("REWE"), parsePublicAlternatives(taggedOnly, input, evaluator).first { it.barcode == product.getString("code") }.stores)
        assertFalse(items.last().storeMatch)
        assertFalse(items.last().marketListed)
        val url = alternativeUrl(input.copy(query = "chocolate & nuts", store = "A&B"), BrowseSource.FOOD.root.toHttpUrl(), true)
        assertEquals("chocolate & nuts", url.queryParameter("search_terms"))
        assertEquals("A&B", url.queryParameter("tag_1"))
        assertEquals("vegan", url.queryParameter("tag_0"))
    }
    @Test fun veganEvidenceHandlesContractedAndNonAdjacentNegations() {
        val cases = JSONObject(File(root, "contracts/alternatives-fixtures.json").readText()).getJSONArray("veganEvidence")
        val extraction = JSONObject("""{"alternatives":[{"name":"Chocolate","brand":"Plant","url":"https://maker.example/product","quote":""}],"research":{"searched":true,"sources":[{"url":"https://maker.example/product"}]}}""")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val quote = case.getString("quote")
            extraction.getJSONArray("alternatives").getJSONObject(0).put("quote", quote)
            assertEquals(quote, if (case.getBoolean("accepted")) 1 else 0, parseAIAlternatives(extraction, input).size)
        }
    }
    @Test fun aiRequiresIndependentSearchAndStoreProvenance() {
        val extraction = JSONObject("""{"alternatives":[{"name":"Chocolate","brand":"Plant","url":"https://maker.example/product","quote":"Our chocolate is vegan.","store":"REWE","storeUrl":"https://store.example/product","storeQuote":"Plant chocolate at REWE"}],"research":{"searched":true,"sources":[{"url":"https://maker.example/product"}]}}""")
        assertFalse(parseAIAlternatives(extraction, input).first().storeMatch)
        extraction.getJSONObject("research").getJSONArray("sources").put(JSONObject().put("url", "https://store.example/product"))
        assertTrue(parseAIAlternatives(extraction, input).first().storeMatch)
        extraction.getJSONArray("alternatives").getJSONObject(0).put("quote", "Not vegan.")
        assertTrue(parseAIAlternatives(extraction, input).isEmpty())
        extraction.getJSONArray("alternatives").getJSONObject(0).put("quote", "Vegane Schokolade mit Haferdrink.")
        assertEquals(1, parseAIAlternatives(extraction, input).size)
        extraction.getJSONArray("alternatives").getJSONObject(0).put("quote", "Nicht vegane Schokolade.")
        assertTrue(parseAIAlternatives(extraction, input).isEmpty())
        extraction.remove("research")
        assertTrue(parseAIAlternatives(extraction, input).isEmpty())
    }
}
