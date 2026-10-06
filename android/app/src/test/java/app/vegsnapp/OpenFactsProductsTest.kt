package app.vegsnapp

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class OpenFactsProductsTest {
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
