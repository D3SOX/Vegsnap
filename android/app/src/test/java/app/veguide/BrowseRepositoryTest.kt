package app.veguide

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class BrowseRepositoryTest {
    private fun repository(server: MockWebServer): BrowseRepository {
        var time = 0L
        return BrowseRepository(requests = BrowseRequests({ time }, { time += it }), endpoint = { server.url("/${it.name}/") })
    }
    private fun facts(count: Int = 1, ingredients: String = "water, oats") = JSONObject().put("count", count).put("products", JSONArray().put(
        JSONObject().put("code", "4006381333931").put("product_name", "Oat drink").put("product_name_de", "Haferdrink")
            .put("brands", "Brand").put("ingredients_text", ingredients).put("countries_tags", JSONArray().put("en:germany"))
            .put("labels", "Vegan").put("image_url", "https://private.invalid/pixel.jpg").put("url", "https://wrong.invalid/")
            .put("last_modified_t", 1_700_000_000)))
    private fun response(body: JSONObject) = MockResponse().setHeader("Content-Type", "application/json").setBody(body.toString())

    @Test fun `temporary upstream failure is identified and the same pomme query can recover`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(503).setHeader("Content-Type", "text/html")
                .setBody("<!DOCTYPE html><title>Page temporarily unavailable - Open Food Facts</title>"))
            server.enqueue(response(facts()))
            val repository = repository(server)
            try { repository.search(BrowseSource.FOOD, "pomme"); fail("must reject upstream outage") }
            catch (error: BrowseException) { assertEquals("TEMPORARILY_UNAVAILABLE", error.reason.name) }
            assertEquals(1, repository.search(BrowseSource.FOOD, "pomme").records.size)
            assertEquals(2, server.requestCount)
            assertEquals(server.takeRequest().path, server.takeRequest().path)
        }
    }

    @Test fun `JSON service errors are not cached and the same query can recover`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(response(JSONObject().put("error", JSONObject().put("code", "unavailable"))))
            server.enqueue(response(facts()))
            val repository = repository(server)
            try { repository.search(BrowseSource.FOOD, "oat"); fail("must reject error response") }
            catch (error: BrowseException) { assertEquals(BrowseFailure.UNAVAILABLE, error.reason) }
            assertEquals(1, repository.search(BrowseSource.FOOD, "oat").records.size)
            assertEquals(2, server.requestCount)
        }
    }

    @Test fun `food beauty and products use explicit keyword endpoint with attributed native details`() = runBlocking {
        MockWebServer().use { server ->
            val repository = repository(server)
            for (source in listOf(BrowseSource.FOOD, BrowseSource.BEAUTY, BrowseSource.PRODUCTS)) {
                server.enqueue(response(facts(21)))
                val page = repository.search(source, "Hafer & Bio", locale = "de")
                val request = server.takeRequest(5, TimeUnit.SECONDS)!!
                assertEquals("/${source.name}/cgi/search.pl", request.requestUrl!!.encodedPath)
                assertEquals("Hafer & Bio", request.requestUrl!!.queryParameter("search_terms"))
                assertEquals("20", request.requestUrl!!.queryParameter("page_size"))
                assertEquals("1", request.requestUrl!!.queryParameter("page"))
                assertTrue(request.getHeader("User-Agent")!!.contains("Veguide"))
                assertNull(request.getHeader("Authorization"))
                val record = page.records.single()
                assertEquals("Haferdrink", record.name)
                assertEquals("water, oats", record.composition)
                assertEquals("germany", record.markets)
                assertEquals("Brand", record.brand)
                assertEquals(source.root + "product/4006381333931", record.url)
                assertEquals(1, page.next)
                assertFalse(request.requestUrl!!.queryParameter("fields")!!.contains("image"))
                val manual = record.manualInput("other")
                assertEquals(false, manual.complete)
                assertEquals("other", manual.category)
                assertEquals("4006381333931", manual.barcode)
            }
            assertEquals(3, server.requestCount) // no thumbnail or detail prefetch
        }
    }

    @Test fun `facts pagination advances pages without dropping the submitted query`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(response(facts(21)))
            server.enqueue(response(facts(21)))
            val repository = repository(server)
            val first = repository.search(BrowseSource.FOOD, "oat")
            val second = repository.search(BrowseSource.FOOD, "oat", cursor = first.next!!)
            server.takeRequest()
            val next = server.takeRequest()
            assertEquals("2", next.requestUrl!!.queryParameter("page"))
            assertEquals("oat", next.requestUrl!!.queryParameter("search_terms"))
            assertNull(second.next)
        }
    }

    @Test fun `Wikidata uses continuation and identity never becomes composition or certification`() = runBlocking {
        MockWebServer().use { server ->
            val body = JSONObject().put("search", JSONArray().put(JSONObject().put("id", "Q123").put("label", "Brand")
                .put("description", "vegan products company").put("concepturi", "https://wrong.invalid/")))
                .put("search-continue", 20)
            server.enqueue(response(body)); server.enqueue(response(JSONObject().put("search", JSONArray())))
            val repository = repository(server)
            val page = repository.search(BrowseSource.WIKIDATA, "Brand", locale = "sv")
            val request = server.takeRequest()
            assertEquals("wbsearchentities", request.requestUrl!!.queryParameter("action"))
            assertEquals("sv", request.requestUrl!!.queryParameter("language"))
            val identity = page.records.single()
            assertEquals("CC0", identity.source.license)
            assertEquals("https://www.wikidata.org/wiki/Q123", identity.url)
            assertEquals("", identity.manualInput("other").text)
            assertEquals("", identity.barcode)
            assertEquals(false, identity.manualInput("other").complete)
            repository.search(BrowseSource.WIKIDATA, "Brand", cursor = page.next!!)
            assertEquals("20", server.takeRequest().requestUrl!!.queryParameter("continue"))
        }
    }

    @Test fun `offline search makes no request and cancellation stops the active call`() = runBlocking {
        MockWebServer().use { server ->
            val repository = repository(server)
            try { repository.search(BrowseSource.FOOD, "oat", offline = true); fail("offline") }
            catch (error: BrowseException) { assertEquals(BrowseFailure.OFFLINE, error.reason) }
            assertEquals(0, server.requestCount)
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            val job = launch { repository.search(BrowseSource.FOOD, "oat") }
            assertNotNull(withContext(Dispatchers.IO) { server.takeRequest(5, TimeUnit.SECONDS) })
            withTimeout(5_000) { job.cancelAndJoin() }
            assertTrue(job.isCancelled)
        }
    }

    @Test fun `search limiter spaces submissions and caches without leaking mutable response objects`() = runBlocking {
        var now = 0L
        val waits = mutableListOf<Long>()
        val requests = BrowseRequests({ now }, { waits += it; now += it })
        var calls = 0
        val first = requests.search("one") { calls++; JSONObject().put("name", "original") }
        first.put("name", "mutated")
        assertEquals("original", requests.search("one") { error("cache must be reused") }.getString("name"))
        requests.search("two") { calls++; JSONObject() }
        requests.search("three") { calls++; JSONObject() }
        assertEquals(listOf(6_100L, 6_100L), waits)
        assertEquals(3, calls)
    }

    @Test fun `slow responses report a timeout instead of an unreadable database`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            val http = okhttp3.OkHttpClient.Builder().readTimeout(100, TimeUnit.MILLISECONDS)
                .callTimeout(500, TimeUnit.MILLISECONDS).build()
            val repository = BrowseRepository(http = http, requests = BrowseRequests(), endpoint = { server.url("/") })
            try { repository.search(BrowseSource.FOOD, "pomme"); fail("must time out") }
            catch (error: BrowseException) { assertEquals(BrowseFailure.TIMEOUT, error.reason) }
        }
    }

    @Test fun `rate limits and malformed responses return errors without arbitrary redirects`() = runBlocking {
        MockWebServer().use { server ->
            val repository = repository(server)
            for ((status, expected) in listOf(429 to BrowseFailure.RATE_LIMITED, 302 to BrowseFailure.UNAVAILABLE,
                503 to BrowseFailure.TEMPORARILY_UNAVAILABLE, 502 to BrowseFailure.TEMPORARILY_UNAVAILABLE, 504 to BrowseFailure.TIMEOUT)) {
                server.enqueue(MockResponse().setResponseCode(status).setHeader("Location", "https://private.invalid/"))
                try { repository.search(BrowseSource.FOOD, "oat$status"); fail("must reject") }
                catch (error: BrowseException) { assertEquals(expected, error.reason) }
            }
            server.enqueue(MockResponse().setBody("not JSON"))
            try { repository.search(BrowseSource.FOOD, "bad JSON"); fail("must reject") }
            catch (error: BrowseException) { assertEquals(BrowseFailure.UNAVAILABLE, error.reason) }
            assertEquals(6, server.requestCount)
        }
    }

    @Test fun `invalid source ids and barcode checks do not become invented identifiers`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(response(JSONObject().put("products", JSONArray()
                .put(JSONObject().put("code", "../../secret").put("product_name", "bad"))
                .put(JSONObject().put("code", "1234567890123").put("product_name", "record with invalid GTIN")))))
            val record = repository(server).search(BrowseSource.PRODUCTS, "item").records.single()
            assertEquals("", record.barcode)
            assertEquals("https://world.openproductsfacts.org/product/1234567890123", record.url)
        }
    }
}
