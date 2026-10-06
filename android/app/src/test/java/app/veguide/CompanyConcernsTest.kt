package app.veguide

import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.Protocol
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CompanyConcernsTest {
    private val root = File(requireNotNull(System.getProperty("veguide.repo")))
    private val data get() = JSONObject(File(root, "data/company-concerns.json").readText())
    private val resolver get() = CompanyConcernResolver(data)
    private val evaluator get() = Evaluator(JSONObject(File(root, "data/rules.json").readText()))

    @Test fun exactAliasAndParentAttributionKeepConductSeparateFromProductVerdict() {
        val result = evaluator.evaluate(CheckInput("water, salt", "food", true))
        result.getJSONObject("identity").put("brand", "  HÄLSANS   KÖK ")
        resolver.attach(result, "de")
        assertEquals("vegan", result.getString("outcome"))
        val concern = result.getJSONArray("companyConcerns").getJSONObject(0)
        assertEquals("Nestlé", concern.getString("company"))
        assertEquals("Hälsans Kök", concern.getString("matchedBrand"))
        assertEquals("parent", concern.getString("scope"))
        assertEquals("2017-02", concern.getString("sourceDate"))
        assertTrue(concern.getString("description").contains("Tierversuche"))
        assertTrue(concern.getString("ownershipSourceUrl").startsWith("https://www.nestle.dk/"))
        assertEquals("2026-10-06T00:00:00Z", concern.getString("ownershipReviewedAt"))
        assertEquals("direct", resolver.resolve("Nestle", "en").getJSONObject(0).getString("scope"))
    }

    @Test fun productNamesPartialMatchesAndUnknownBrandsNeverBecomeAccusations() {
        for (brand in listOf("", "Not Nestlé", "Nestlé alternative", "Hälsans", "Unknown")) assertEquals(brand, 0, resolver.resolve(brand, "en").length())
        val result = evaluator.evaluate(CheckInput(name = "Nestlé product"))
        assertEquals(0, resolver.attach(result, "en").getJSONArray("companyConcerns").length())
        assertEquals(1, resolver.resolve("Unknown, Garden Gourmet, Garden Gourmet", "en").length())
        assertEquals(0, resolver.resolve(List(9) { "Garden Gourmet" }.joinToString(","), "en").length())
        val invalid = data
        invalid.getJSONArray("entities").getJSONObject(1).getJSONObject("parent").put("sourceUrl", "http://unsafe.example/")
        assertEquals(0, CompanyConcernResolver(invalid).resolve("Hälsans Kök", "en").length())
    }

    @Test fun onlineBarcodeLookupRetainsPublicBrandAndAppliesConcernsBeforeAnyAi() = runBlocking {
        var requests = 0
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            requests++
            val product = JSONObject().put("code", "4006381333931").put("product_name", "Sample")
                .put("brands", "Garden Gourmet").put("ingredients_text", "water, salt")
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body(JSONObject().put("product", product).toString().toResponseBody("application/json".toMediaType())).build()
        }.build()
        val repo = CheckRepository(evaluator, "unused", http = http, companyConcerns = resolver)
        val result = repo.check(CheckInput(barcode = "4006381333931", category = "food"), emptyList(), AppSettings(aiEnabled = false), "")
        assertEquals(1, requests)
        assertEquals(false, result.getBoolean("usedAI"))
        assertEquals("Garden Gourmet", result.getJSONObject("identity").getString("brand"))
        assertEquals(1, result.getJSONArray("companyConcerns").length())
        assertFalse(result.toString().contains("databaseBrand"))
    }

    @Test fun resolvedAndDisputedRecordsRemainExplicitAndAmbiguousAliasesDoNotMatch() {
        val document = data
        val record = document.getJSONArray("records").getJSONObject(0)
        for (status in listOf("resolved", "disputed")) {
            record.put("status", status)
            assertEquals(status, CompanyConcernResolver(document).resolve("Nestle", "en").getJSONObject(0).getString("status"))
        }
        document.getJSONArray("entities").put(JSONObject().put("id", "unrelated").put("name", "Nestle").put("kind", "company"))
        assertEquals(0, CompanyConcernResolver(document).resolve("Nestle", "en").length())
    }

    @Test fun successfulAiIdentityAttachesReviewedRecordsWithoutAcceptingModelAccusations() = runBlocking {
        MockWebServer().use { server ->
            val extraction = JSONObject().put("text", "water, salt").put("complete", true).put("category", "food")
                .put("name", "Sample").put("brand", "Garden Gourmet")
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(JSONObject().put("choices", JSONArray().put(
                JSONObject().put("finish_reason", "stop").put("message", JSONObject().put("content", extraction.toString())))).toString()))
            val repo = CheckRepository(evaluator, "Extract composition", companyConcerns = resolver)
            val result = repo.check(CheckInput(), listOf(PreparedPhoto(byteArrayOf(1))),
                AppSettings(connection = "api", aiEnabled = true, model = "vision", baseUrl = server.url("/v1").toString()), "")
            assertEquals("vegan", result.getString("outcome"))
            assertEquals("Garden Gourmet", result.getJSONObject("identity").getString("brand"))
            assertEquals(1, result.getJSONArray("companyConcerns").length())
        }
    }

    @Test fun passiveAndExplicitOfflineBarcodePathsRetainBrandAndResolveConcernsWithoutNetwork() = runBlocking {
        val pack = JSONObject(File(root, "data/offline/bundle.json").readText())
        val product = pack.getJSONArray("products").getJSONObject(0)
        product.put("brands", "Garden Gourmet")
        val folder = Files.createTempDirectory("company-offline").toFile()
        try {
            val database = OfflineDatabase({ pack.toString().byteInputStream() }, folder)
            val http = OkHttpClient.Builder().addInterceptor { error("No network allowed") }.build()
            val repo = CheckRepository(evaluator, "unused", http = http, offlineDatabase = database, companyConcerns = resolver)
            val input = CheckInput(barcode = product.getString("code"))
            val passive = requireNotNull(repo.lookupBarcode(input, offline = true))
            val explicit = repo.check(input, emptyList(), AppSettings(offline = true), "")
            for (result in listOf(passive, explicit)) {
                assertEquals("Garden Gourmet", result.getJSONObject("identity").getString("brand"))
                assertEquals(1, result.getJSONArray("companyConcerns").length())
                assertFalse(result.toString().contains("databaseBrand"))
            }
        } finally { folder.deleteRecursively() }
    }
}
