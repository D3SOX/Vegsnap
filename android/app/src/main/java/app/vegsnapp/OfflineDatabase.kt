package app.vegsnapp

import android.content.Context
import java.io.File
import java.io.InputStream
import java.net.URI
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.time.Instant
import java.security.MessageDigest
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

internal const val OFFLINE_PACK_BYTES = 10_000_000
internal const val OFFLINE_INSTALLED_PACKS = 10
internal fun offlineRegionId(region: String): String = MessageDigest.getInstance("SHA-256")
    .digest(region.trim().lowercase(Locale.ROOT).toByteArray()).joinToString("") { "%02x".format(it) }
internal data class OfflinePackInfo(val region: String, val generatedAt: String, val count: Int, val sources: String,
    val bytes: Long, val sha256: String) { val id get() = offlineRegionId(region) }
internal data class OfflineDatabaseState(val bundled: OfflinePackInfo? = null, val installed: List<OfflinePackInfo> = emptyList(), val ready: Boolean = false, val unavailable: Boolean = false)
private data class OfflinePack(val info: OfflinePackInfo, val sources: Map<String, JSONObject>, val products: List<JSONObject>)
private val offlineSources = mapOf("off" to BrowseSource.FOOD, "obf" to BrowseSource.BEAUTY, "opf" to BrowseSource.PRODUCTS)

/** Product snapshots are community evidence, never complete-label or certification assertions. */
class OfflineDatabase(private val bundled: () -> InputStream, private val directory: File) {
    private val lock = Mutex()
    private var bundle: OfflinePack? = null
    private val regional = linkedMapOf<String, OfflinePack>()
    private val mutableState = MutableStateFlow(OfflineDatabaseState())
    internal val state = mutableState.asStateFlow()
    private val regionsDirectory get() = File(directory, "regions")
    private fun regionalFile(id: String): File {
        require(id.matches(Regex("[a-f0-9]{64}")))
        return File(regionsDirectory, "$id.json")
    }
    private fun orderedPacks() = (regional.values + listOfNotNull(bundle)).sortedByDescending { Instant.parse(it.info.generatedAt) }
    private fun publish(unavailable: Boolean = false) {
        mutableState.value = OfflineDatabaseState(bundle?.info, regional.values.map { it.info }.sortedBy { it.region }, true, unavailable || bundle == null)
    }
    internal suspend fun initialize() = withContext(Dispatchers.IO) { lock.withLock {
        if (mutableState.value.ready) return@withLock
        var unavailable = false
        bundle = try { bundled().use { parse(readBounded(it)) } } catch (_: Exception) { unavailable = true; null }
        val files = regionsDirectory.listFiles()?.filter { it.extension == "json" }?.sortedBy { it.name }.orEmpty()
        if (files.size > OFFLINE_INSTALLED_PACKS) unavailable = true
        for (file in files.take(OFFLINE_INSTALLED_PACKS)) {
            currentCoroutineContext().ensureActive()
            try {
                val pack = file.inputStream().use { parse(readBounded(it)) }
                require(file.name == "${pack.info.id}.json")
                regional[pack.info.id] = pack
            } catch (error: kotlinx.coroutines.CancellationException) { throw error }
            catch (_: Exception) { unavailable = true }
        }
        publish(unavailable)
    } }
    internal suspend fun import(stream: InputStream, expected: RegionalPackDescriptor? = null) = withContext(Dispatchers.IO) {
        val bytes = stream.use(::readBounded)
        val parsed = parse(bytes)
        if (expected != null) {
            require(parsed.info.region == expected.region && parsed.info.generatedAt == expected.generatedAt && parsed.info.count == expected.products)
            require(parsed.info.bytes == expected.bytes && parsed.info.sha256 == expected.sha256)
        }
        currentCoroutineContext().ensureActive()
        initialize()
        lock.withLock {
            require(parsed.info.id in regional || regional.size < OFFLINE_INSTALLED_PACKS) { "Installed pack limit reached" }
            check(regionsDirectory.isDirectory || regionsDirectory.mkdirs())
            val target = regionalFile(parsed.info.id)
            val temporary = File(regionsDirectory, "${parsed.info.id}.pending")
            try {
                temporary.outputStream().use { it.write(bytes); it.fd.sync() }
                currentCoroutineContext().ensureActive()
                Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
                regional[parsed.info.id] = parsed
                publish()
            } finally { temporary.delete() }
        }
    }
    internal suspend fun removeImported(id: String) = withContext(Dispatchers.IO) { initialize(); lock.withLock {
        val target = regionalFile(id)
        check(!target.exists() || target.delete())
        regional.remove(id)
        publish()
    } }
    internal suspend fun lookup(input: CheckInput): Pair<CheckInput, JSONObject>? = withContext(Dispatchers.IO) {
        initialize()
        if (!validGtin(input.barcode)) return@withContext null
        val allowed = when (input.category) { "food", "drink" -> setOf("off"); "cosmetics" -> setOf("obf"); "clothing", "shoes", "household" -> setOf("opf"); else -> offlineSources.keys }
        lock.withLock {
            for (pack in orderedPacks()) {
                val product = pack.products.firstOrNull { it.getString("source") in allowed && it.getString("code").padStart(14, '0') == input.barcode.padStart(14, '0') } ?: continue
                val id = product.getString("source")
                val source = offlineSources.getValue(id)
                val text = localized(product, "ingredients", input.locale)
                val name = localized(product, "name", input.locale)
                val category = if (input.category != "other") input.category else when (id) { "off" -> "food"; "obf" -> "cosmetics"; else -> "other" }
                val markets = product.getJSONArray("countries_tags")
                val differentMarket = markets.length() > 0 && (0 until markets.length()).none { markets.getString(it) == "en:germany" }
                val evidence = JSONObject().put("id", "offline:$id:${product.getString("code")}").put("kind", "database")
                    .put("title", source.title + if (input.locale == "de") " · Offline-Datenstand" else " · Offline snapshot")
                    .put("url", source.root + "product/" + product.getString("code")).put("excerpt", text)
                    .put("retrievedAt", pack.sources.getValue(id).getString("retrievedAt")).put("license", "ODbL-1.0")
                    .put("offlineSnapshotDate", pack.info.generatedAt).put("differentMarket", differentMarket)
                    .put("databaseBrand", product.getString("brands"))
                if (product.getLong("last_modified_t") > 0) evidence.put("sourceDate", Instant.ofEpochSecond(product.getLong("last_modified_t")).toString())
                return@withLock input.copy(text = text, name = name, complete = false, category = category) to evidence
            }
            null
        }
    }
    internal suspend fun search(source: BrowseSource, query: String, cursor: Int, locale: String): BrowsePage = withContext(Dispatchers.IO) {
        initialize()
        val id = offlineSources.entries.firstOrNull { it.value == source }?.key ?: throw BrowseException(BrowseFailure.OFFLINE)
        val words = query.trim().lowercase(Locale.ROOT).split(Regex("\\s+"))
        lock.withLock {
            val packs = orderedPacks()
            val products = packs.flatMap { pack -> pack.products.filter { it.getString("source") == id }.map { pack to it } }
                .distinctBy { it.second.getString("code").padStart(14, '0') }
            val matches = products.filter { (_, product) ->
                val text = listOf("name", "name_de", "name_en", "brands", "code").joinToString(" ") { product.optString(it) }.lowercase(Locale.ROOT)
                words.all(text::contains)
            }
            val records = matches.drop(cursor * 20).take(20).map { (pack, product) ->
                val code = product.getString("code")
                BrowseRecord(code, source, localized(product, "name", locale).ifBlank { code }, barcode = code,
                    brand = product.getString("brands"), composition = localized(product, "ingredients", locale),
                    markets = product.getJSONArray("countries_tags").let { tags -> (0 until tags.length()).joinToString(", ") { tags.getString(it).substringAfter(':').replace('-', ' ') } },
                    updated = product.getLong("last_modified_t").takeIf { it > 0 }?.let { Instant.ofEpochSecond(it).toString().take(10) }.orEmpty(),
                    url = source.root + "product/" + code, snapshotDate = pack.info.generatedAt)
            }
            BrowsePage(records, (cursor + 1).takeIf { (cursor + 1L) * 20 < matches.size },
                snapshotInfo = packs.map { it.info }.distinct())
        }
    }
    private fun localized(product: JSONObject, field: String, locale: String): String = product.optString("${field}_${if (locale == "de") "de" else "en"}").ifBlank { product.getString(field) }
    private fun readBounded(stream: InputStream): ByteArray {
        val bytes = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) { val count = stream.read(buffer); if (count < 0) break; require(bytes.size() + count <= OFFLINE_PACK_BYTES); bytes.write(buffer, 0, count) }
        return bytes.toByteArray()
    }
    private fun parse(bytes: ByteArray): OfflinePack {
        val document = JSONObject(bytes.toString(Charsets.UTF_8))
        require(document.get("schemaVersion") is Number && document.getDouble("schemaVersion") == 1.0)
        fun text(value: JSONObject, key: String, max: Int): String { require(value.get(key) is String); return value.getString(key).also { require(it.length <= max) } }
        val region = text(document, "region", 100).also { require(it.isNotBlank()) }
        val generated = text(document, "generatedAt", 50).also { Instant.parse(it) }
        val sourceValues = document.getJSONArray("sources")
        require(sourceValues.length() in 1..3)
        val sources = linkedMapOf<String, JSONObject>()
        for (index in 0 until sourceValues.length()) {
            val source = sourceValues.getJSONObject(index)
            val id = text(source, "id", 3)
            val expected = offlineSources[id] ?: error("Unsupported product database")
            require(id !in sources && source.getString("license") == "ODbL-1.0")
            val url = URI(text(source, "url", 2000))
            require(url.scheme == "https" && url.host == URI(expected.root).host && url.userInfo == null && url.fragment == null)
            Instant.parse(text(source, "retrievedAt", 50))
            sources[id] = source
        }
        val values = document.getJSONArray("products")
        require(values.length() <= 10_000)
        val seen = mutableSetOf<String>()
        val products = (0 until values.length()).map { index ->
            values.getJSONObject(index).also { p ->
                val id = text(p, "source", 3); val code = text(p, "code", 14)
                require(id in sources && validGtin(code) && seen.add("$id:${code.padStart(14, '0')}"))
                for (field in listOf("name", "brands", "ingredients")) text(p, field, if (field == "ingredients") 12_000 else 500)
                for (field in listOf("name_de", "name_en", "ingredients_de", "ingredients_en")) if (p.has(field)) text(p, field, if (field.startsWith("ingredients")) 12_000 else 500)
                val tags = p.getJSONArray("countries_tags"); require(tags.length() <= 64)
                for (i in 0 until tags.length()) require(tags.get(i) is String && tags.getString(i).length <= 80)
                val changed = p.get("last_modified_t"); require(changed is Number && changed.toDouble().isFinite() && changed.toDouble() == changed.toLong().toDouble() && changed.toLong() in 0..253402300799L)
            }
        }
        return OfflinePack(OfflinePackInfo(region, generated, products.size, sources.keys.joinToString(" · ") { offlineSources.getValue(it).title },
            bytes.size.toLong(), MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }), sources, products)
    }
}
internal object ApplicationOfflineDatabase {
    private var instance: OfflineDatabase? = null
    @Synchronized fun get(context: Context): OfflineDatabase = instance ?: OfflineDatabase(
        { context.applicationContext.assets.open("offline/bundle.json") }, File(context.applicationContext.noBackupFilesDir, "offline-database"),
    ).also { instance = it }
}
