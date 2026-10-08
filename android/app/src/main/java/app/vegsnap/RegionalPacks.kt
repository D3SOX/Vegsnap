package app.vegsnap

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.time.Instant
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject

internal const val DEFAULT_REGIONAL_CATALOG = "https://github.com/D3SOX/vegsnap/releases/download/offline-data/catalog.json"
internal const val REGIONAL_CATALOG_BYTES = 256_000
internal data class RegionalPackDescriptor(val id: String, val region: String, val url: String, val bytes: Long,
    val sha256: String, val generatedAt: String, val products: Int)
internal data class RegionalPacksState(val ready: Boolean = false, val catalogUrl: String = DEFAULT_REGIONAL_CATALOG,
    val packs: List<RegionalPackDescriptor> = emptyList(), val loading: Boolean = false, val downloading: String? = null,
    val downloadedBytes: Long = 0)

internal fun validPackUrl(value: String): Boolean {
    val url = value.toHttpUrlOrNull() ?: return false
    return value.length <= 2000 && url.isHttps && url.username.isEmpty() && url.password.isEmpty() && url.fragment == null
}

internal fun parseRegionalCatalog(bytes: ByteArray): List<RegionalPackDescriptor> {
    require(bytes.size <= REGIONAL_CATALOG_BYTES)
    val document = JSONObject(bytes.toString(Charsets.UTF_8))
    require(document.get("schemaVersion") is Number && document.getDouble("schemaVersion") == 1.0)
    val packs = document.getJSONArray("packs")
    require(packs.length() <= 100)
    val ids = mutableSetOf<String>()
    val regions = mutableSetOf<String>()
    return (0 until packs.length()).map { index ->
        val item = packs.getJSONObject(index)
        for (field in listOf("id", "region", "url", "sha256", "generatedAt")) require(item.get(field) is String)
        val id = item.getString("id")
        val region = item.getString("region")
        require(id.matches(Regex("[a-z0-9][a-z0-9-]{0,63}")) && ids.add(id))
        require(region.isNotBlank() && region.length <= 100 && regions.add(offlineRegionId(region)))
        require(validPackUrl(item.getString("url")))
        require(item.getString("sha256").matches(Regex("[a-f0-9]{64}")))
        require(item.getString("generatedAt").length <= 50)
        Instant.parse(item.getString("generatedAt"))
        require(item.get("bytes") is Number && item.getDouble("bytes") == item.getLong("bytes").toDouble() && item.getLong("bytes") in 1..OFFLINE_PACK_BYTES.toLong())
        require(item.get("products") is Number && item.getDouble("products") == item.getInt("products").toDouble() && item.getInt("products") in 0..10_000)
        RegionalPackDescriptor(id, region, item.getString("url"), item.getLong("bytes"), item.getString("sha256"), item.getString("generatedAt"), item.getInt("products"))
    }
}

internal fun interface RegionalPackDownload {
    suspend fun read(url: String, limit: Long, consume: (InputStream) -> Unit)
}

/** GitHub release assets redirect to HTTPS storage; no cookies or credentials are used. */
internal class HttpRegionalPackDownload(private val http: OkHttpClient = OkHttpClient.Builder()
    .followRedirects(false).followSslRedirects(false).connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(20, TimeUnit.SECONDS).callTimeout(3, TimeUnit.MINUTES).build()) : RegionalPackDownload {
    override suspend fun read(url: String, limit: Long, consume: (InputStream) -> Unit) {
        try { readWithTimeout(url, limit, consume) }
        catch (error: TimeoutCancellationException) {
            currentCoroutineContext().ensureActive()
            throw RegionalPackNetworkException()
        }
        catch (error: RegionalPackHttpException) { throw error }
        catch (_: java.io.IOException) {
            currentCoroutineContext().ensureActive()
            throw RegionalPackNetworkException()
        }
    }
    private suspend fun readWithTimeout(url: String, limit: Long, consume: (InputStream) -> Unit) = withTimeout(TimeUnit.MINUTES.toMillis(3)) {
        var location = url
        for (redirect in 0..5) {
            require(validPackUrl(location))
            val request = Request.Builder().url(location).header("Accept", "application/json").header("User-Agent", "Vegsnap/0.1 Android").build()
            val call = http.newCall(request)
            val cancellation = launch(start = CoroutineStart.UNDISPATCHED) { try { awaitCancellation() } finally { call.cancel() } }
            var next: String? = null
            try {
                withContext(Dispatchers.IO) {
                    call.execute().use { response ->
                        if (response.code in setOf(301, 302, 303, 307, 308)) {
                            require(redirect < 5)
                            next = requireNotNull(response.header("Location")?.let { request.url.resolve(it) }).toString()
                            require(validPackUrl(requireNotNull(next)))
                        } else {
                            if (!response.isSuccessful) throw RegionalPackHttpException(response.code)
                            val body = requireNotNull(response.body)
                            require(body.contentLength() == -1L || body.contentLength() <= limit)
                            consume(body.byteStream())
                        }
                    }
                }
            } finally { cancellation.cancel() }
            if (next == null) return@withTimeout
            location = requireNotNull(next)
        }
    }
}

/** Explicit, cancellable downloads. A verified pack is installed atomically by OfflineDatabase. */
internal class RegionalPacks(private val directory: File, private val database: OfflineDatabase,
    private val download: RegionalPackDownload = HttpRegionalPackDownload()) {
    private val lock = Mutex()
    @Volatile private var job: Job? = null
    private val mutableState = MutableStateFlow(RegionalPacksState())
    val state = mutableState.asStateFlow()
    private val settingsFile get() = File(directory, "catalog-source")
    private val catalogFile get() = File(directory, "catalog.json")

    suspend fun initialize() = withContext(Dispatchers.IO) { lock.withLock { initializeLocked() } }
    private fun initializeLocked() {
        if (state.value.ready) return
        val source = settingsFile.takeIf { it.isFile && it.length() <= 2000 }?.readText()?.takeIf(::validPackUrl) ?: DEFAULT_REGIONAL_CATALOG
        val packs = runCatching {
            if (!catalogFile.isFile || catalogFile.length() > REGIONAL_CATALOG_BYTES) emptyList() else parseRegionalCatalog(catalogFile.readBytes())
        }.getOrDefault(emptyList())
        mutableState.value = RegionalPacksState(ready = true, catalogUrl = source, packs = packs)
    }
    suspend fun refresh(url: String, offline: Boolean) = withContext(Dispatchers.IO) { lock.withLock {
        require(!offline && validPackUrl(url))
        initializeLocked()
        check(directory.isDirectory || directory.mkdirs())
        if (state.value.catalogUrl != url) {
            // Clear old-source entries before saving the new recipient, including across process restarts.
            check(!catalogFile.exists() || catalogFile.delete())
            atomicWrite(settingsFile, url.toByteArray())
            mutableState.update { it.copy(catalogUrl = url, packs = emptyList()) }
        }
        mutableState.update { it.copy(loading = true) }
        val context = currentCoroutineContext()
        job = context.job
        try {
            var bytes = ByteArray(0)
            download.read(url, REGIONAL_CATALOG_BYTES.toLong()) { bytes = readBounded(it, REGIONAL_CATALOG_BYTES.toLong()) { context.ensureActive() } }
            val parsed = parseRegionalCatalog(bytes)
            context.ensureActive()
            atomicWrite(catalogFile, bytes)
            mutableState.update { it.copy(packs = parsed) }
        } finally { job = null; mutableState.update { it.copy(loading = false) } }
    } }
    suspend fun install(id: String, offline: Boolean) = withContext(Dispatchers.IO) { lock.withLock {
        require(!offline)
        initializeLocked()
        val pack = state.value.packs.single { it.id == id }
        database.initialize()
        val installed = database.state.value.installed.firstOrNull { it.id == offlineRegionId(pack.region) }
        if (installed?.sha256 == pack.sha256) return@withLock
        require(installed != null || database.state.value.installed.size < OFFLINE_INSTALLED_PACKS)
        require(installed == null || Instant.parse(pack.generatedAt) >= Instant.parse(installed.generatedAt)) { "Installed snapshot is newer" }
        mutableState.update { it.copy(downloading = id, downloadedBytes = 0) }
        val context = currentCoroutineContext()
        job = context.job
        try {
            var bytes = ByteArray(0)
            download.read(pack.url, pack.bytes) { source ->
                bytes = readBounded(source, pack.bytes) { count -> context.ensureActive(); mutableState.update { it.copy(downloadedBytes = count) } }
            }
            require(bytes.size.toLong() == pack.bytes)
            require(MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) } == pack.sha256)
            context.ensureActive()
            database.import(bytes.inputStream(), pack)
        } finally { job = null; mutableState.update { it.copy(downloading = null, downloadedBytes = 0) } }
    } }
    fun cancel() { job?.cancel() }
    suspend fun cancelAndJoin() { job?.cancelAndJoin() }
    private fun readBounded(stream: InputStream, limit: Long, progress: (Long) -> Unit): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (true) {
            progress(output.size().toLong())
            val count = stream.read(buffer)
            if (count < 0) break
            require(output.size().toLong() + count <= limit)
            output.write(buffer, 0, count)
        }
        progress(output.size().toLong())
        return output.toByteArray()
    }
    private fun atomicWrite(target: File, bytes: ByteArray) {
        check(directory.isDirectory || directory.mkdirs())
        val temporary = File(directory, target.name + ".pending")
        try {
            temporary.outputStream().use { it.write(bytes); it.fd.sync() }
            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally { temporary.delete() }
    }
}
