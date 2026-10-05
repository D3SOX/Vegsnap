package org.veguide.android

import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class OfflineDatabaseTest {
    private val root = File(requireNotNull(System.getProperty("veguide.repo")))
    private fun document(region: String = "Germany/EU", ingredients: String = "water"): JSONObject = JSONObject()
        .put("schemaVersion", 1).put("generatedAt", "2026-10-05T12:00:00Z").put("region", region)
        .put("sources", JSONArray().put(JSONObject().put("id", "off").put("url", "https://world.openfoodfacts.org/")
            .put("license", "ODbL-1.0").put("retrievedAt", "2026-10-04T12:00:00Z")))
        .put("products", JSONArray().put(JSONObject().put("source", "off").put("code", "4006381333931")
            .put("name", "Sample drink").put("name_de", "Beispielgetränk").put("brands", "Example")
            .put("ingredients", ingredients).put("countries_tags", JSONArray().put("en:germany")).put("last_modified_t", 1700000000)))
    private fun withDatabase(test: suspend (OfflineDatabase, File) -> Unit) = runBlocking {
        val folder = Files.createTempDirectory("veguide-offline-test").toFile()
        try { test(OfflineDatabase({ document().toString().byteInputStream() }, folder), folder) }
        finally { folder.deleteRecursively() }
    }
    private fun repository(database: OfflineDatabase, network: () -> Unit = {}): CheckRepository = CheckRepository(
        Evaluator(JSONObject(File(root, "data/rules.json").readText())), "unused", http = OkHttpClient.Builder().addInterceptor {
            network(); error("Offline lookup must never access the network")
        }.build(), offlineDatabase = database)

    @Test fun `generated bundled snapshot parses and serves all three public sources`() = runBlocking {
        val file = File(root, "data/offline/bundle.json")
        val document = JSONObject(file.readText())
        val folder = Files.createTempDirectory("veguide-bundled-snapshot-test").toFile()
        try {
            val database = OfflineDatabase({ file.inputStream() }, folder)
            database.initialize()
            assertFalse(database.state.value.unavailable)
            assertEquals(document.getJSONArray("products").length(), database.state.value.bundled?.count)
            val products = document.getJSONArray("products")
            for ((source, category) in mapOf("off" to "food", "obf" to "cosmetics", "opf" to "household")) {
                val sample = (0 until products.length()).map { products.getJSONObject(it) }.first { it.getString("source") == source }
                val found = requireNotNull(database.lookup(CheckInput(barcode = sample.getString("code"), category = category)))
                assertEquals(false, found.first.complete)
                assertEquals("ODbL-1.0", found.second.getString("license"))
                assertEquals("offline:$source:${sample.getString("code")}", found.second.getString("id"))
            }
        } finally { folder.deleteRecursively() }
    }

    @Test fun `offline explicit barcode checks use exact local evidence with dates and no invented completeness`() = withDatabase { database, _ ->
        var requests = 0
        val result = repository(database) { requests++ }.check(CheckInput(barcode = "4006381333931", locale = "de"), emptyList(), AppSettings(offline = true), "")
        assertEquals(0, requests)
        assertEquals("Beispielgetränk", result.getString("title"))
        assertEquals("exact_barcode", result.getJSONObject("identity").getString("match"))
        assertEquals("uncertain", result.getString("outcome"))
        assertEquals("offline", result.getString("aiStatus"))
        val evidence = result.getJSONArray("evidence")
        val snapshot = (0 until evidence.length()).map { evidence.getJSONObject(it) }.single { it.getString("kind") == "database" }
        assertEquals("2026-10-04T12:00:00Z", snapshot.getString("retrievedAt"))
        assertEquals("ODbL-1.0", snapshot.getString("license"))
        assertEquals("water", snapshot.getString("excerpt"))
        assertFalse(snapshot.has("offlineSnapshotDate"))
        assertTrue(result.getJSONArray("warnings").toString().contains("2026-10-05"))
    }
    @Test fun `online checks consult snapshots before making public requests`() = withDatabase { database, _ ->
        var requests = 0
        val result = repository(database) { requests++ }.check(CheckInput(barcode = "4006381333931"), emptyList(), AppSettings(aiEnabled = false), "")
        assertEquals(0, requests)
        assertEquals("Sample drink", result.getString("title"))
    }
    @Test fun `offline absence remains unknown and identity-only records still match`() = withDatabase { database, _ ->
        val repository = repository(database)
        val absent = repository.check(CheckInput(barcode = "7311041068182"), emptyList(), AppSettings(offline = true), "")
        assertEquals("uncertain", absent.getString("outcome"))
        assertTrue(absent.getJSONArray("warnings").toString().contains("limited offline"))
        database.import(document("Sweden", "").toString().byteInputStream())
        val identity = requireNotNull(repository.lookupBarcode(CheckInput(barcode = "4006381333931"), offline = true))
        assertEquals("uncertain", identity.getString("outcome"))
        assertEquals("exact_barcode", identity.getJSONObject("identity").getString("match"))
        assertEquals(0, identity.getJSONArray("findings").length())
    }
    @Test fun `invalid regional replacement cannot overwrite installed data`() = withDatabase { database, folder ->
        database.import(document("Sweden", "milk").toString().byteInputStream())
        val original = File(folder, "regions/${offlineRegionId("Sweden")}.json").readText()
        for (bad in listOf(
            document().apply { getJSONArray("products").getJSONObject(0).put("code", "4006381333932") },
            document().apply { getJSONArray("products").getJSONObject(0).put("ingredients", "x".repeat(12001)) },
            document().apply { getJSONArray("sources").getJSONObject(0).put("url", "https://untrusted.example/") },
            document().put("generatedAt", "not-a-date"),
        )) {
            try { database.import(bad.toString().byteInputStream()); fail("Invalid pack accepted") } catch (_: Exception) { }
            assertEquals(original, File(folder, "regions/${offlineRegionId("Sweden")}.json").readText())
            assertEquals("Sweden", database.state.value.installed.singleOrNull()?.region)
        }
        assertEquals("not_vegan", repository(database).lookupBarcode(CheckInput(barcode = "4006381333931"), true)?.getString("outcome"))
        database.removeImported(offlineRegionId("Sweden"))
        assertTrue(database.state.value.installed.isEmpty())
        assertEquals("uncertain", repository(database).lookupBarcode(CheckInput(barcode = "4006381333931"), true)?.getString("outcome"))
        assertFalse(File(folder, "regions/${offlineRegionId("Sweden")}.json").exists())
    }
    @Test fun `Swedish regional record keeps exact barcode match while warning about market`() = withDatabase { database, _ ->
        val pack = document("Sweden", "vatten")
        pack.getJSONArray("products").getJSONObject(0).put("countries_tags", JSONArray().put("en:sweden"))
        database.import(pack.toString().byteInputStream())
        val result = requireNotNull(repository(database).lookupBarcode(CheckInput(barcode = "4006381333931"), true))
        assertEquals("exact_barcode", result.getJSONObject("identity").getString("match"))
        assertTrue(result.getJSONArray("warnings").toString().contains("other markets"))
        assertFalse(result.getJSONArray("evidence").getJSONObject(0).has("differentMarket"))
    }
    @Test fun `Barnivore imported draft keeps status separate from composition`() {
        val record = BrowseRecord("fixture", BrowseSource.BARNIVORE, "Example wine", composition = "vegan friendly", description = "Manufacturer response", url = "https://www.barnivore.com/wine/1/")
        val input = record.manualInput("other")
        assertEquals("drink", input.category)
        assertEquals("", input.text)
        assertEquals(false, input.complete)
    }
    @Test fun `oversized import is bounded and does not replace existing snapshot`() = withDatabase { database, folder ->
        database.import(document("Sweden").toString().byteInputStream())
        val original = File(folder, "regions/${offlineRegionId("Sweden")}.json").readText()
        try { database.import("x".repeat(OFFLINE_PACK_BYTES + 1).byteInputStream()); fail("Oversized import accepted") } catch (_: IllegalArgumentException) { }
        assertEquals(original, File(folder, "regions/${offlineRegionId("Sweden")}.json").readText())
    }
    @Test fun `offline browse searches local names and brands and retains attribution`() = withDatabase { database, _ ->
        var network = 0
        val repository = BrowseRepository(http = OkHttpClient.Builder().addInterceptor { network++; error("Network forbidden") }.build(), offlineDatabase = database)
        val page = repository.search(BrowseSource.FOOD, "beispiel", locale = "de", offline = true)
        assertEquals(0, network)
        assertEquals("Beispielgetränk", page.records.single().name)
        assertEquals("water", page.records.single().composition)
        assertEquals("2026-10-05T12:00:00Z", page.records.single().snapshotDate)
        assertEquals("Germany/EU", page.snapshotInfo?.single()?.region)
        assertTrue(repository.search(BrowseSource.FOOD, "absent product", offline = true).records.isEmpty())
        for (source in listOf(BrowseSource.WIKIDATA, BrowseSource.BARNIVORE)) {
            try { repository.search(source, "example", offline = true); fail("Unsupported offline source") } catch (e: BrowseException) { assertEquals(BrowseFailure.OFFLINE, e.reason) }
        }
        assertEquals(0, network)
    }
    @Test fun `offline camera can request a local lookup without enabling network policy`() {
        val scanner = BarcodeScanCoordinator()
        scanner.configure(true, offline = true, allowOfflineLookup = true)
        val observation = requireNotNull(scanner.observe("4006381333931"))
        assertTrue(observation.lookup)
        assertTrue(scanner.accepts(observation))
        scanner.configure(false, offline = true, allowOfflineLookup = true)
        assertFalse(scanner.accepts(observation))
    }
}
