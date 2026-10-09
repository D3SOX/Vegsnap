package app.vegsnap

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MatsparCatalogueTest {
    private fun identity() = JSONObject().put("category", "food").put("name", "Hummus med chili").put("brand", "Coop")
        .put("packaging", JSONObject().put("language", "Swedish").put("quantity", "200 g").put("variant", "med chili"))
    private fun product() = JSONObject().put("name", "Hummus chili").put("brand", "Coop").put("weight_pretty", "200g")
        .put("slug", "produkt/hummus-chili-200g-coop")
        .put("ingredients", "INGREDIENSER: Kikärtor* 58%, vatten, rapsolja, SESAMPASTA 5,8%, röd paprika, salt, surhetsreglerande medel (E 330), chili 0,5%, paprikapulver, vitlökspulver, konserveringsmedel (E 202). *Ursprung: Se till vänster.")
    private fun response(payload: JSONObject, type: String = "category") = JSONObject().put("payload", payload).put("type", type).toString()

    @Test fun exactProductIsReadFromCatalogueWithoutWebSearchIndexOrGuessedUrl() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(response(JSONObject().put("products", JSONArray().put(product())))))
            server.enqueue(MockResponse().setBody(response(product(), "product")))
            val result = MatsparCatalogue(endpoint = server.url("/slug")).lookup(identity())!!
            assertEquals(product().getString("ingredients"), result.getString("text"))
            assertEquals("retailer", result.getString("sourceType"))
            val search = server.takeRequest()
            assertEquals("Coop Hummus med chili", JSONObject(search.body.readUtf8()).getJSONObject("query").getString("q"))
            assertEquals("POST", search.method)
            assertNull(search.getHeader("Authorization"))
            assertEquals("/produkt/hummus-chili-200g-coop", JSONObject(server.takeRequest().body.readUtf8()).getString("slug"))
        }
    }

    @Test fun wrongBrandFlavourSizeAndAmbiguousMatchesAreRejected() = runBlocking {
        for (candidates in listOf(
            listOf(product().put("brand", "Lidl")), listOf(product().put("name", "Hummus ingefära chili")),
            listOf(product().put("weight_pretty", "140g")), listOf(product(), product().put("slug", "produkt/another-recipe")),
        )) MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(response(JSONObject().put("products", JSONArray(candidates)))))
            assertNull(MatsparCatalogue(endpoint = server.url("/slug")).lookup(identity()))
            assertEquals(1, server.requestCount)
        }
    }

    @Test fun productPageMustStillMatchTheSearchRecord() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(response(JSONObject().put("products", JSONArray().put(product())))))
            server.enqueue(MockResponse().setBody(response(product().put("weight_pretty", "140g"), "product")))
            assertNull(MatsparCatalogue(endpoint = server.url("/slug")).lookup(identity()))
        }
    }

    @Test fun observedNameCanIncludeTheBrandPrefixWithoutChangingTheVariant() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(response(JSONObject().put("products", JSONArray().put(product())))))
            server.enqueue(MockResponse().setBody(response(product(), "product")))
            val input = identity().put("name", "Coop Hummus Chili")
                .apply { getJSONObject("packaging").put("variant", "Hummus chili") }
            assertNotNull(MatsparCatalogue(endpoint = server.url("/slug")).lookup(input))
        }
    }

    @Test fun unknownQuantityOtherMarketsCategoriesAndUnverifiableBarcodesSkipCatalogue() = runBlocking {
        for (input in listOf(identity().put("category", "cosmetics"), identity().put("barcode", "7340191191914"),
            identity().apply { getJSONObject("packaging").remove("quantity") },
            identity().apply { getJSONObject("packaging").put("language", "German") },
            identity().apply { getJSONObject("packaging").put("country", "Norway") })) {
            MockWebServer().use { server ->
                assertNull(MatsparCatalogue(endpoint = server.url("/slug")).lookup(input))
                assertEquals(0, server.requestCount)
            }
        }
    }

    @Test fun redirectsAndOversizedBodiesAreNotFollowedOrAccepted() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "http://127.0.0.1/private"))
            assertNull(MatsparCatalogue(endpoint = server.url("/slug")).lookup(identity()))
            assertEquals(1, server.requestCount)
            server.enqueue(MockResponse().setBody("x".repeat(256_001)))
            try { MatsparCatalogue(endpoint = server.url("/slug")).lookup(identity()); fail("Oversized page accepted") }
            catch (error: IllegalArgumentException) { assertEquals("Catalogue response too large", error.message) }
        }
    }
}
