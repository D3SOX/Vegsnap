package app.vegsnap

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class OpenFactsProductsTest {
    private val evaluator = Evaluator(JSONObject(File(requireNotNull(System.getProperty("vegsnap.repo")), "data/rules.json").readText()))

    @Test fun recordedVeganLabelSettlesOpenOriginsButNeverOutweighsAnimalIngredients() {
        val labels = listOf("en:vegetarian", "en:vegan", "en:v-label-international-vegan")
        fun check(text: String, tags: List<String> = labels) =
            applyDatabaseLabels(evaluator.evaluate(CheckInput(text, "food", locale = "de")), tags, "de")
        val vegan = check("Zucker, Kakaomasse, Aprikosenkerne, natürliches Orangen-Aroma, Emulgator: Lecithine")
        assertEquals("vegan", vegan.getString("outcome"))
        assertEquals("packaging", vegan.getString("basis"))
        assertEquals(0, vegan.getJSONArray("questions").length())
        assertTrue(vegan.getJSONArray("warnings").toString().contains(ResultStrings.databaseLabelCaution("de")))
        assertEquals("conflicting", check("Zucker, Magermilchpulver, Lecithine").getString("outcome"))
        assertEquals("uncertain", check("Zucker, Lecithine", listOf("en:vegetarian", "en:organic")).getString("outcome"))
    }

    @Test fun sharedGateSpacesDistinctRequestsAndCachesDefensiveCopies() = runBlocking {
        var clock = 0L
        val starts = mutableListOf<Long>()
        val requests = OpenFactsProductRequests(now = { clock }, wait = { clock += it })
        suspend fun load(key: String) = requests.product(key) { starts += clock; JSONObject().put("code", key) }
        val first = requireNotNull(load("food/first"))
        first.put("code", "mutated")
        assertEquals("food/first", requireNotNull(load("food/first")).getString("code"))
        load("beauty/second")
        load("products/third")
        assertEquals(listOf(0L, 4_100L, 8_200L), starts)
    }

    @Test fun simultaneousMatchingLookupsShareOneFetchAndMissesExpire() = runBlocking {
        var clock = 0L
        var calls = 0
        val requests = OpenFactsProductRequests(now = { clock }, wait = { clock += it })
        val results = List(5) { async { requests.product("missing") { calls++; delay(1); null } } }.awaitAll()
        assertTrue(results.all { it == null })
        assertEquals(1, calls)
        clock = 60_001
        requests.product("missing") { calls++; null }
        assertEquals(2, calls)
    }
}
