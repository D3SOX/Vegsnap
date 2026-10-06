package app.vegsnapp

import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RegionalPacksTest {
    private val source = "https://packs.example/catalog.json"
    private val packUrl = "https://packs.example/sweden.json"
    private fun snapshot(region: String, code: String = "4006381333931", ingredients: String = "water", date: String = "2026-10-06T12:00:00Z"): ByteArray = JSONObject()
        .put("schemaVersion", 1).put("generatedAt", date).put("region", region)
        .put("sources", JSONArray().put(JSONObject().put("id", "off").put("url", "https://world.openfoodfacts.org/")
            .put("license", "ODbL-1.0").put("retrievedAt", date)))
        .put("products", JSONArray().put(JSONObject().put("source", "off").put("code", code)
            .put("name", "$region product").put("brands", "Example").put("ingredients", ingredients)
            .put("countries_tags", JSONArray().put("en:germany")).put("last_modified_t", 1700000000))).toString().toByteArray()
    private fun descriptor(bytes: ByteArray, region: String = "Sweden", id: String = "sweden", url: String = packUrl): JSONObject = JSONObject()
        .put("id", id).put("region", region).put("url", url).put("bytes", bytes.size)
        .put("sha256", MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
        .put("generatedAt", JSONObject(bytes.toString(Charsets.UTF_8)).getString("generatedAt")).put("products", 1)
    private fun catalog(vararg entries: JSONObject) = JSONObject().put("schemaVersion", 1).put("packs", JSONArray(entries.toList())).toString().toByteArray()
    private fun withDatabase(block: suspend CoroutineScope.(OfflineDatabase, File) -> Unit) = runBlocking {
        val folder = Files.createTempDirectory("vegsnap-region-test").toFile()
        try {
            val database = OfflineDatabase({ snapshot("Bundle", code = "7311041068182", date = "2026-10-01T12:00:00Z").inputStream() }, File(folder, "database"))
            block(database, folder)
        } finally { folder.deleteRecursively() }
    }
    private class FakeDownload(val values: MutableMap<String, ByteArray>) : RegionalPackDownload {
        var requests = 0
        override suspend fun read(url: String, limit: Long, consume: (java.io.InputStream) -> Unit) {
            requests++
            consume(values.getValue(url).inputStream())
        }
    }
    @Test fun `verified download installs and remains available after process restart`() = withDatabase { database, folder ->
        val bytes = snapshot("Sweden")
        val download = FakeDownload(mutableMapOf(source to catalog(descriptor(bytes)), packUrl to bytes))
        val packs = RegionalPacks(File(folder, "downloads"), database, download)
        packs.initialize()
        assertEquals(0, download.requests)
        packs.refresh(source, offline = false)
        packs.install("sweden", offline = false)
        assertEquals(2, download.requests)
        assertEquals("Sweden", database.state.value.installed.single().region)
        assertNull(packs.state.value.downloading)
        val reload = OfflineDatabase({ snapshot("Bundle").inputStream() }, File(folder, "database"))
        reload.initialize()
        assertEquals("Sweden", reload.state.value.installed.single().region)
        assertEquals("water", reload.lookup(CheckInput(barcode = "4006381333931"))?.first?.text)
        val manager = RegionalPacks(File(folder, "downloads"), reload, download)
        manager.initialize()
        assertEquals(source, manager.state.value.catalogUrl)
        assertEquals("sweden", manager.state.value.packs.single().id)
        assertEquals(2, download.requests)
        manager.install("sweden", false)
        assertEquals(2, download.requests)
    }
    @Test fun `multiple regions are independently persisted updated searched and removed`() = withDatabase { database, folder ->
        database.import(snapshot("Sweden").inputStream())
        database.import(snapshot("Denmark", "5901234123457").inputStream())
        assertEquals(2, database.state.value.installed.size)
        assertEquals(3, database.search(BrowseSource.FOOD, "product", 0, "en").records.size)
        database.import(snapshot("Sweden", ingredients = "milk", date = "2026-10-07T12:00:00Z").inputStream())
        assertEquals(2, database.state.value.installed.size)
        assertEquals("milk", database.lookup(CheckInput(barcode = "4006381333931"))?.first?.text)
        database.removeImported(offlineRegionId("Sweden"))
        assertEquals("Denmark", database.state.value.installed.single().region)
        assertNotNull(database.lookup(CheckInput(barcode = "5901234123457")))
        assertFalse(File(folder, "database/regions/${offlineRegionId("Sweden")}.json").exists())
    }
    @Test fun `freshest dated snapshot wins duplicate product across regions`() = withDatabase { database, _ ->
        database.import(snapshot("Sweden", ingredients = "milk", date = "2026-10-07T12:00:00Z").inputStream())
        database.import(snapshot("Denmark", ingredients = "water", date = "2026-10-06T12:00:00Z").inputStream())
        assertEquals("milk", database.lookup(CheckInput(barcode = "4006381333931"))?.first?.text)
        assertEquals(2, database.search(BrowseSource.FOOD, "product", 0, "en").records.size)
    }
    @Test fun `invalid catalog and corrupt or truncated download cannot replace installed region`() = withDatabase { database, folder ->
        val original = snapshot("Sweden", ingredients = "milk")
        database.import(original.inputStream())
        val update = snapshot("Sweden", ingredients = "water", date = "2026-10-07T12:00:00Z")
        val download = FakeDownload(mutableMapOf(source to catalog(descriptor(update)), packUrl to update))
        val packs = RegionalPacks(File(folder, "downloads"), database, download)
        packs.refresh(source, false)
        for (invalid in listOf(update.copyOf(update.size - 1), update.clone().also { it[it.lastIndex] = 0 }, update + byteArrayOf(1))) {
            download.values[packUrl] = invalid
            try { packs.install("sweden", false); fail("Invalid download accepted") } catch (_: IllegalArgumentException) { }
            assertEquals("milk", database.lookup(CheckInput(barcode = "4006381333931"))?.first?.text)
            assertNull(packs.state.value.downloading)
        }
        download.values[source] = "broken".toByteArray()
        try { packs.refresh(source, false); fail("Malformed catalog accepted") } catch (_: org.json.JSONException) { }
        assertEquals("sweden", packs.state.value.packs.single().id)
    }
    @Test fun `valid hash cannot disguise mismatched regional metadata or invalid snapshot`() = withDatabase { database, folder ->
        val cases = listOf(snapshot("Denmark"), snapshot("Sweden", code = "4006381333932"))
        for (bytes in cases) {
            val download = FakeDownload(mutableMapOf(source to catalog(descriptor(bytes)), packUrl to bytes))
            val packs = RegionalPacks(File(folder, "downloads"), database, download)
            packs.refresh(source, false)
            try { packs.install("sweden", false); fail("Invalid snapshot accepted") } catch (_: IllegalArgumentException) { }
            assertTrue(database.state.value.installed.isEmpty())
        }
    }
    @Test fun `offline mode makes zero catalog and pack requests`() = withDatabase { database, folder ->
        val bytes = snapshot("Sweden")
        val download = FakeDownload(mutableMapOf(source to catalog(descriptor(bytes)), packUrl to bytes))
        val packs = RegionalPacks(File(folder, "downloads"), database, download)
        try { packs.refresh(source, true); fail("Offline catalog request accepted") } catch (_: IllegalArgumentException) { }
        assertEquals(0, download.requests)
        packs.refresh(source, false)
        try { packs.install("sweden", true); fail("Offline pack request accepted") } catch (_: IllegalArgumentException) { }
        assertEquals(1, download.requests)
    }
    @Test fun `cancelled transfer preserves existing pack and clears progress`() = withDatabase { database, folder ->
        val bytes = snapshot("Sweden")
        database.import(bytes.inputStream())
        val update = snapshot("Sweden", date = "2026-10-07T12:00:00Z")
        val began = CompletableDeferred<Unit>()
        val download = RegionalPackDownload { url, _, consume ->
            if (url == source) consume(catalog(descriptor(update)).inputStream())
            else { began.complete(Unit); awaitCancellation() }
        }
        val packs = RegionalPacks(File(folder, "downloads"), database, download)
        packs.refresh(source, false)
        val active = launch { packs.install("sweden", false) }
        began.await()
        packs.cancelAndJoin()
        active.join()
        assertEquals("2026-10-06T12:00:00Z", database.state.value.installed.single().generatedAt)
        assertNull(packs.state.value.downloading)
    }
    @Test fun `older catalog cannot replace newer installed data`() = withDatabase { database, folder ->
        database.import(snapshot("Sweden", date = "2026-10-07T12:00:00Z").inputStream())
        val bytes = snapshot("Sweden")
        val download = FakeDownload(mutableMapOf(source to catalog(descriptor(bytes)), packUrl to bytes))
        val packs = RegionalPacks(File(folder, "downloads"), database, download)
        packs.refresh(source, false)
        try { packs.install("sweden", false); fail("Downgrade accepted") } catch (_: IllegalArgumentException) { }
        assertEquals(1, download.requests)
    }
    @Test fun `catalog rejects ambiguous regions unsafe URLs and unbounded descriptors`() {
        val bytes = snapshot("Sweden")
        for (bad in listOf(
            descriptor(bytes).put("url", "http://packs.example/file.json"),
            descriptor(bytes).put("url", "https://user:key@packs.example/file.json"),
            descriptor(bytes).put("url", "https://packs.example/file.json#fragment"),
            descriptor(bytes).put("id", "../outside"), descriptor(bytes).put("bytes", OFFLINE_PACK_BYTES + 1),
            descriptor(bytes).put("products", 10001), descriptor(bytes).put("sha256", "bad"),
        )) {
            try { parseRegionalCatalog(catalog(bad)); fail("Unsafe manifest accepted") } catch (_: IllegalArgumentException) { }
        }
        try { parseRegionalCatalog(catalog(descriptor(bytes), descriptor(bytes, region = "sweden", id = "other"))); fail("Duplicate region accepted") } catch (_: IllegalArgumentException) { }
    }
    @Test fun `changing catalog source cannot reuse entries from previous source`() = withDatabase { database, folder ->
        val bytes = snapshot("Sweden")
        val download = FakeDownload(mutableMapOf(source to catalog(descriptor(bytes))))
        val packs = RegionalPacks(File(folder, "downloads"), database, download)
        packs.refresh(source, false)
        try { packs.refresh("https://other.example/catalog.json", false); fail("Missing source should fail") } catch (_: NoSuchElementException) { }
        assertTrue(packs.state.value.packs.isEmpty())
        val reloaded = RegionalPacks(File(folder, "downloads"), database, download)
        reloaded.initialize()
        assertEquals("https://other.example/catalog.json", reloaded.state.value.catalogUrl)
        assertTrue(reloaded.state.value.packs.isEmpty())
    }
    @Test fun `HTTPS release redirect follows without credentials and HTTP downgrade is rejected`() = runBlocking {
        MockWebServer().use { server ->
            val http = OkHttpClient.Builder().followRedirects(false).addInterceptor { chain ->
                chain.proceed(chain.request().newBuilder().url(server.url(chain.request().url.encodedPath)).build())
            }.build()
            val download = HttpRegionalPackDownload(http)
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "https://storage.example/pack.json"))
            server.enqueue(MockResponse().setBody("{}"))
            var text = ""
            download.read("https://release.example/file.json", 100) { text = it.bufferedReader().readText() }
            assertEquals("{}", text)
            repeat(2) {
                val request = requireNotNull(server.takeRequest(1, TimeUnit.SECONDS))
                assertNull(request.getHeader("Authorization")); assertNull(request.getHeader("Cookie"))
            }
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "http://storage.example/pack.json"))
            try { download.read("https://release.example/file.json", 100) { fail("Downgrade body reached") }; fail("HTTP downgrade accepted") } catch (_: IllegalArgumentException) { }
            assertEquals(3, server.requestCount)
        }
    }
    @Test fun `unpublished catalog retains HTTP 404 instead of a generic verification failure`() = runBlocking {
        MockWebServer().use { server ->
            val http = OkHttpClient.Builder().followRedirects(false).addInterceptor { chain ->
                chain.proceed(chain.request().newBuilder().url(server.url("/catalog.json")).build())
            }.build()
            server.enqueue(MockResponse().setResponseCode(404).setBody("Not found"))
            val failure = runCatching {
                HttpRegionalPackDownload(http).read("https://release.example/catalog.json?private=never-display", 256_000) { fail("404 body must not be consumed") }
            }.exceptionOrNull()
            assertNotNull(failure)
            assertEquals("RegionalPackHttpException", failure!!.javaClass.simpleName)
            assertEquals("HTTP 404", failure.message)
            assertEquals(R.string.offline_catalog_not_available, regionalPackErrorMessage(failure as Exception, catalog = true))
            assertEquals(R.string.offline_region_not_available, regionalPackErrorMessage(failure, catalog = false))
        }
    }
    @Test fun `HTTP rate limits and server failures reach separate localized actions`() = runBlocking {
        MockWebServer().use { server ->
            val http = OkHttpClient.Builder().followRedirects(false).addInterceptor { chain ->
                chain.proceed(chain.request().newBuilder().url(server.url("/catalog.json")).build())
            }.build()
            for ((status, message) in listOf(429 to R.string.offline_download_rate_limited, 503 to R.string.offline_download_server_error, 403 to R.string.offline_download_rejected)) {
                server.enqueue(MockResponse().setResponseCode(status).setBody("sensitive server body must not be shown"))
                val failure = requireNotNull(runCatching {
                    HttpRegionalPackDownload(http).read("https://release.example/catalog.json?token=private", 1000) { fail("Error body must not be consumed") }
                }.exceptionOrNull()) as Exception
                assertEquals(message, regionalPackErrorMessage(failure, catalog = true))
                assertEquals("HTTP $status", failure.message)
                assertNull(failure.cause)
            }
        }
    }
    @Test fun `network failures do not leak transport URLs or look like corrupt catalogs`() = runBlocking {
        val http = OkHttpClient.Builder().addInterceptor { throw java.net.UnknownHostException("https://private.example/?token=secret") }.build()
        val failure = requireNotNull(runCatching {
            HttpRegionalPackDownload(http).read("https://release.example/catalog.json", 1000) { fail("No response exists") }
        }.exceptionOrNull()) as Exception
        assertTrue(failure is RegionalPackNetworkException)
        assertEquals(R.string.offline_download_network_error, regionalPackErrorMessage(failure, catalog = true))
        assertFalse(failure.toString().contains("secret"))
        assertNull(failure.cause)
    }
    @Test fun `bad catalog and failed pack verification are distinguished from HTTP failures`() = withDatabase { database, folder ->
        val bytes = snapshot("Sweden")
        val download = FakeDownload(mutableMapOf(source to "not a catalog".toByteArray(), packUrl to bytes))
        val packs = RegionalPacks(File(folder, "downloads"), database, download)
        val catalogFailure = requireNotNull(runCatching { packs.refresh(source, false) }.exceptionOrNull()) as Exception
        assertEquals(R.string.offline_catalog_invalid, regionalPackErrorMessage(catalogFailure, catalog = true))
        download.values[source] = catalog(descriptor(bytes))
        packs.refresh(source, false)
        download.values[packUrl] = bytes.clone().also { it[it.lastIndex] = 0 }
        val verificationFailure = requireNotNull(runCatching { packs.install("sweden", false) }.exceptionOrNull()) as Exception
        assertEquals(R.string.offline_download_invalid, regionalPackErrorMessage(verificationFailure, catalog = false))
        assertTrue(database.state.value.installed.isEmpty())
    }
}
