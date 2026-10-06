package app.veguide

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal enum class BrowseSource(val title: String, val root: String, val license: String) {
    FOOD("Open Food Facts", "https://world.openfoodfacts.org/", "ODbL-1.0"),
    BEAUTY("Open Beauty Facts", "https://world.openbeautyfacts.org/", "ODbL-1.0"),
    PRODUCTS("Open Products Facts", "https://world.openproductsfacts.org/", "ODbL-1.0"),
    BARNIVORE("Barnivore", "https://www.barnivore.com/", "Barnivore terms"),
    WIKIDATA("Wikidata", "https://www.wikidata.org/", "CC0"),
}
internal data class BrowseRecord(val id: String, val source: BrowseSource, val name: String,
    val barcode: String = "", val brand: String = "", val composition: String = "", val markets: String = "",
    val description: String = "", val quantity: String = "", val labels: String = "", val updated: String = "", val url: String, val snapshotDate: String = "")
internal data class BrowsePage(val records: List<BrowseRecord>, val next: Int?, val snapshotInfo: List<OfflinePackInfo>? = null)
internal enum class BrowseFailure { OFFLINE, RATE_LIMITED, TEMPORARILY_UNAVAILABLE, TIMEOUT, CONNECTION, UNAVAILABLE }
internal class BrowseException(val reason: BrowseFailure) : IOException(reason.name)

/** Shared across tab instances. One submitted search at a time, cached briefly, never search-as-you-type. */
internal class BrowseRequests(private val now: () -> Long = { System.nanoTime() / 1_000_000 },
    private val wait: suspend (Long) -> Unit = { delay(it) }) {
    private val lock = Mutex()
    private data class Cached(val until: Long, val json: String)
    private val cache = linkedMapOf<String, Cached>()
    private var started: Long? = null
    suspend fun search(url: String, fetch: suspend () -> JSONObject): JSONObject = lock.withLock {
        cache.entries.removeAll { it.value.until <= now() }
        cache[url]?.let { return@withLock JSONObject(it.json) }
        started?.let { val remaining = 6_100 - (now() - it); if (remaining > 0) wait(remaining) }
        currentCoroutineContext().ensureActive()
        started = now()
        val result = fetch()
        cache[url] = Cached(now() + 5 * 60_000, result.toString())
        if (cache.size > 20) cache.remove(cache.keys.first())
        JSONObject(result.toString())
    }
}
private val browseRequests = BrowseRequests()

internal class BrowseRepository(
    private val http: OkHttpClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).callTimeout(35, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build(),
    private val requests: BrowseRequests = browseRequests,
    private val endpoint: (BrowseSource) -> HttpUrl = { it.root.toHttpUrl() },
    private val offlineDatabase: OfflineDatabase? = null,
) {
    suspend fun search(source: BrowseSource, query: String, cursor: Int = 0, locale: String = "en", offline: Boolean = false): BrowsePage = withContext(Dispatchers.IO) {
        val term = query.trim()
        require(term.length in 2..200 && cursor in 0..10_000)
        if (offline) return@withContext offlineDatabase?.search(source, term, cursor, locale) ?: throw BrowseException(BrowseFailure.OFFLINE)
        if (source == BrowseSource.BARNIVORE) return@withContext BarnivoreRepository().search(term, cursor, locale)
        val language = locale.lowercase(Locale.ROOT).takeIf { it.matches(Regex("[a-z]{2,3}")) } ?: "en"
        val root = endpoint(source)
        val url = if (source == BrowseSource.WIKIDATA) root.newBuilder().addPathSegments("w/api.php")
            .addQueryParameter("action", "wbsearchentities").addQueryParameter("format", "json")
            .addQueryParameter("search", term).addQueryParameter("language", language).addQueryParameter("uselang", language)
            .addQueryParameter("type", "item").addQueryParameter("limit", "20").addQueryParameter("continue", cursor.toString()).build()
        else root.newBuilder().addPathSegments("cgi/search.pl").addQueryParameter("search_terms", term)
            .addQueryParameter("search_simple", "1").addQueryParameter("action", "process").addQueryParameter("json", "1")
            .addQueryParameter("page", (cursor + 1).toString()).addQueryParameter("page_size", "20")
            .addQueryParameter("fields", "code,product_name,product_name_$language,brands,ingredients_text,ingredients_text_$language,countries,countries_tags,quantity,labels,last_modified_t")
            .addQueryParameter("lc", language).build()
        val document = requests.search(url.toString()) {
            request(url).also { response ->
                if (response.has("error") || response.has("errors") ||
                    response.optJSONArray(if (source == BrowseSource.WIKIDATA) "search" else "products") == null) {
                    throw BrowseException(BrowseFailure.UNAVAILABLE)
                }
            }
        }
        if (source == BrowseSource.WIKIDATA) parseWikidata(document, cursor) else parseFacts(document, source, cursor, language)
    }

    private fun parseFacts(document: JSONObject, source: BrowseSource, cursor: Int, language: String): BrowsePage {
        val products = document.optJSONArray("products") ?: throw BrowseException(BrowseFailure.UNAVAILABLE)
        val records = (0 until minOf(products.length(), 20)).mapNotNull { index ->
            val product = products.optJSONObject(index) ?: return@mapNotNull null
            val code = product.text("code", 30).takeIf { it.matches(Regex("[0-9]{4,30}")) } ?: return@mapNotNull null
            val markets = product.text("countries", 1000).ifBlank {
                val tags = product.optJSONArray("countries_tags")
                (0 until minOf(tags?.length() ?: 0, 30)).map { tags!!.optString(it).take(100).substringAfter(':').replace('-', ' ') }.joinToString(", ")
            }
            val changed = product.optLong("last_modified_t", 0)
            BrowseRecord(code, source, product.text("product_name_$language", 300).ifBlank { product.text("product_name", 300) }.ifBlank { code },
                barcode = code.takeIf(::validGtin).orEmpty(), brand = product.text("brands", 300),
                composition = product.text("ingredients_text_$language", 20_000).ifBlank { product.text("ingredients_text", 20_000) },
                markets = markets, quantity = product.text("quantity", 100), labels = product.text("labels", 1000),
                updated = if (changed > 0) runCatching { java.time.Instant.ofEpochSecond(changed).toString().take(10) }.getOrDefault("") else "",
                url = source.root + "product/" + code)
        }.distinctBy { it.id }
        val count = document.optLong("count", -1)
        val more = if (count >= 0) (cursor + 1L) * 20 < count else products.length() >= 20
        return BrowsePage(records, (cursor + 1).takeIf { more && cursor < 99 })
    }
    private fun parseWikidata(document: JSONObject, cursor: Int): BrowsePage {
        val items = document.optJSONArray("search") ?: throw BrowseException(BrowseFailure.UNAVAILABLE)
        val records = (0 until minOf(items.length(), 20)).mapNotNull { index ->
            val item = items.optJSONObject(index) ?: return@mapNotNull null
            val id = item.text("id", 30).takeIf { it.matches(Regex("Q[1-9][0-9]*")) } ?: return@mapNotNull null
            BrowseRecord(id, BrowseSource.WIKIDATA, item.text("label", 300).ifBlank { id },
                description = item.text("description", 1500), url = "https://www.wikidata.org/wiki/$id")
        }.distinctBy { it.id }
        val next = document.optInt("search-continue", -1).takeIf { it > cursor && it <= 10_000 }
        return BrowsePage(records, next)
    }
    private suspend fun request(url: HttpUrl): JSONObject = suspendCancellableCoroutine { continuation ->
        val request = Request.Builder().url(url).header("User-Agent", "Veguide/0.1 (Android; explicit database browsing)")
            .header("Accept", "application/json").build()
        val call = http.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (continuation.isActive) continuation.resumeWithException(browseNetworkFailure(e))
            }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    try {
                        if (it.code == 429) throw BrowseException(BrowseFailure.RATE_LIMITED)
                        if (it.code in setOf(408, 504)) throw BrowseException(BrowseFailure.TIMEOUT)
                        if (it.code in 500..599) throw BrowseException(BrowseFailure.TEMPORARILY_UNAVAILABLE)
                        if (!it.isSuccessful) throw BrowseException(BrowseFailure.UNAVAILABLE)
                        val body = it.body
                        if (body.contentLength() > 2_000_000) throw BrowseException(BrowseFailure.UNAVAILABLE)
                        val bytes = ByteArrayOutputStream()
                        body.byteStream().use { stream ->
                            val buffer = ByteArray(8192)
                            while (true) {
                                if (!continuation.isActive) return
                                val size = stream.read(buffer)
                                if (size < 0) break
                                if (bytes.size() + size > 2_000_000) throw BrowseException(BrowseFailure.UNAVAILABLE)
                                bytes.write(buffer, 0, size)
                            }
                        }
                        val result = JSONObject(bytes.toString(Charsets.UTF_8.name()))
                        if (continuation.isActive) continuation.resume(result)
                    } catch (error: Exception) {
                        if (continuation.isActive) continuation.resumeWithException(when (error) {
                            is BrowseException -> error
                            is IOException -> browseNetworkFailure(error)
                            else -> BrowseException(BrowseFailure.UNAVAILABLE)
                        })
                    }
                }
            }
        })
    }
}
private fun browseNetworkFailure(error: IOException) = BrowseException(
    if (error is InterruptedIOException) BrowseFailure.TIMEOUT else BrowseFailure.CONNECTION)
private fun JSONObject.text(key: String, limit: Int): String = if (isNull(key)) "" else optString(key).take(limit).trim()

/** A selected public record is a draft, not an automatically trusted complete label or vegan result. */
internal fun BrowseRecord.manualInput(defaultCategory: String): CheckInput = CheckInput(
    text = if (source in setOf(BrowseSource.WIKIDATA, BrowseSource.BARNIVORE)) "" else composition, name = name, barcode = barcode,
    category = if (source == BrowseSource.BARNIVORE) "drink" else defaultCategory, complete = false,
)
