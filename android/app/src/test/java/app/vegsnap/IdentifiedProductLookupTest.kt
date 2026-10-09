package app.vegsnap

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class IdentifiedProductLookupTest {
    private fun repository(server: MockWebServer): BrowseRepository {
        var now = 0L
        return BrowseRepository(requests = BrowseRequests({ now }, { now += it }), endpoint = { server.url("/${it.name}/") })
    }
    private fun identity(category: String = "food") = JSONObject().put("category", category)
        .put("name", "Coop Hummus med chili").put("brand", "Coop")
        .put("packaging", JSONObject().put("language", "Swedish").put("quantity", "200 g").put("variant", "med chili"))
    private fun product(name: String = "Hummus chili", brand: String = "Coop", quantity: String = "200g", code: String = "4006381333931") =
        JSONObject().put("code", code).put("product_name", name).put("brands", brand)
            .put("ingredients_text", "water, chickpeas").put("quantity", quantity)
    private fun response(vararg products: JSONObject, count: Int = products.size) = MockResponse().setBody(
        JSONObject().put("count", count).put("products", JSONArray(products.toList())).toString())

    @Test fun routesOnlySupportedCategoriesToTheirBrowseDatabases() = runBlocking {
        MockWebServer().use { server ->
            for ((category, source) in listOf("food" to BrowseSource.FOOD, "drink" to BrowseSource.FOOD,
                "cosmetics" to BrowseSource.BEAUTY, "clothing" to BrowseSource.PRODUCTS,
                "shoes" to BrowseSource.PRODUCTS, "household" to BrowseSource.PRODUCTS)) {
                server.enqueue(response(product()))
                assertNotNull(IdentifiedProductLookup(repository(server)).lookup(identity(category)))
                assertTrue(server.takeRequest().path!!.startsWith("/${source.name}/cgi/search.pl"))
            }
            assertNull(IdentifiedProductLookup(repository(server)).lookup(identity("other")))
            assertEquals(6, server.requestCount)
        }
    }

    @Test fun coopBrandPrefixSwedishMedAndWordOrderResolveTheExactRecord() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(response(product(name = "Coop Hummus chili")))
            val found = IdentifiedProductLookup(repository(server)).lookup(identity())
            assertEquals("4006381333931", found?.id)
            val request = server.takeRequest()
            assertEquals("Coop Hummus med chili", request.requestUrl!!.queryParameter("search_terms"))
        }
    }

    @Test fun wrongBrandFlavorQuantityAmbiguityAndMarketMismatchAreRejected() = runBlocking {
        for (candidate in listOf(
            listOf(product(brand = "Other")),
            listOf(product(name = "Hummus ingefära chili")),
            listOf(product(quantity = "140g")),
            listOf(product(), product(code = "7350113940018")),
            listOf(product().put("countries_tags", JSONArray().put("en:norway"))),
        )) MockWebServer().use { server ->
            server.enqueue(response(*candidate.toTypedArray()))
            val input = identity().apply { getJSONObject("packaging").put("country", "Sweden") }
            assertNull(IdentifiedProductLookup(repository(server)).lookup(input))
        }
    }

    @Test fun packagingLanguageMatchesTheSourceNameWhileResultsKeepTheAppLocale() = runBlocking {
        for (language in listOf("Swedish", "sv", "swe", "svenska")) MockWebServer().use { server ->
            server.enqueue(response(product().put("product_name_sv", "Hummus chili").put("product_name_de", "Hummus mit Chili")
                .put("ingredients_text_sv", "vatten, kikärtor").put("ingredients_text_de", "Wasser, Kichererbsen")))
            val input = identity().put("locale", "de").apply { getJSONObject("packaging").put("language", language) }
            val found = IdentifiedProductLookup(repository(server)).lookup(input)
            assertNotNull(found)
            assertEquals("Hummus chili", found?.name)
            assertEquals("vatten, kikärtor", found?.composition)
            assertTrue(server.takeRequest().requestUrl!!.queryParameter("fields")!!.contains("product_name_sv"))
            assertEquals("de", identifiedDatabaseRecord(requireNotNull(found), input).first.locale)
        }
    }

    @Test fun missingIdentityCluesBarcodeUnknownCountryOrMorePagesSkipSelection() = runBlocking {
        for (input in listOf(
            identity().put("name", " "), identity().put("brand", ""),
            identity().apply { getJSONObject("packaging").remove("quantity") },
            identity().put("barcode", "4006381333931"),
        )) MockWebServer().use { server ->
            assertNull(IdentifiedProductLookup(repository(server)).lookup(input))
            assertEquals(0, server.requestCount)
        }
        MockWebServer().use { server ->
            server.enqueue(response(product().put("countries_tags", JSONArray().put("en:germany"))))
            val input = identity().apply { getJSONObject("packaging").put("country", "Atlantis") }
            assertNull(IdentifiedProductLookup(repository(server)).lookup(input))
        }
        MockWebServer().use { server ->
            server.enqueue(response(product(), count = 21))
            assertNull(IdentifiedProductLookup(repository(server)).lookup(identity()))
        }
    }

    @Test fun compositionMustBePresentAndEnglishWithIsTheOnlyEnglishNameFiller() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(response(product(name = "Hummus with chili").put("ingredients_text", " ")))
            val english = identity().put("name", "Hummus with chili")
                .put("packaging", JSONObject().put("language", "English").put("quantity", "200 G").put("variant", "with chili"))
            assertNull(IdentifiedProductLookup(repository(server)).lookup(english))
        }
        MockWebServer().use { server ->
            server.enqueue(response(product(name = "Hummus with chili")))
            val english = identity().put("name", "Hummus with chili")
                .put("packaging", JSONObject().put("language", "English").put("quantity", "200 G").put("variant", "with chili"))
            assertNotNull(IdentifiedProductLookup(repository(server)).lookup(english))
        }
    }

    @Test fun marketMetadataWithoutAnObservedCountryDoesNotInventTheAppMarket() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(response(product().put("countries_tags", JSONArray().put("en:sweden"))))
            assertNotNull(IdentifiedProductLookup(repository(server)).lookup(identity()))
        }
        MockWebServer().use { server ->
            server.enqueue(response(product()))
            assertNull(IdentifiedProductLookup(repository(server)).lookup(identity().apply { getJSONObject("packaging").put("country", "Sweden") }))
        }
    }
    @Test fun manualCountryRequiresMatchingRecordMetadataWithoutAPackagingCountry() = runBlocking {
        for ((country, tag) in mapOf("SE" to "en:sweden", "CZ" to "en:czech-republic", "TR" to "en:turkey")) {
            MockWebServer().use { server ->
                server.enqueue(response(product().put("countries_tags", JSONArray().put(tag))))
                assertNotNull(IdentifiedProductLookup(repository(server)).lookup(identity().put("market", country)))
            }
            for (markets in listOf(JSONArray().put("en:germany"), JSONArray())) MockWebServer().use { server ->
                server.enqueue(response(product().put("countries_tags", markets)))
                assertNull(IdentifiedProductLookup(repository(server)).lookup(identity().put("market", country)))
            }
        }
    }
}
