package app.vegsnapp

import java.io.IOException
import java.io.InterruptedIOException
import java.time.Instant
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

private val barnivoreRequests = BrowseRequests()

/** Explicit, bounded search of Barnivore's public result page; no crawling or inferred matches. */
internal class BarnivoreRepository(
    private val http: OkHttpClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).callTimeout(30, TimeUnit.SECONDS).build(),
    private val root: HttpUrl = "https://www.barnivore.com/".toHttpUrl(),
) {
    suspend fun search(query: String, cursor: Int = 0, locale: String = "en"): BrowsePage {
        require(query.trim().length in 2..200 && cursor == 0)
        val url = root.newBuilder().addPathSegment("search").addQueryParameter("q", query.trim()).build()
        val document = barnivoreRequests.search(url.toString()) {
            val html = fetch(url)
            val copiedAt = Instant.now().toString()
            parseBarnivoreSearch(html, locale, copiedAt)
            JSONObject().put("html", html).put("copiedAt", copiedAt)
        }
        return parseBarnivoreSearch(document.getString("html"), locale, document.getString("copiedAt"))
    }
    private suspend fun fetch(url: HttpUrl): String = suspendCancellableCoroutine<String> { continuation ->
            val call = http.newCall(Request.Builder().url(url).header("User-Agent", "Vegsnap/0.1 (explicit beverage lookup)").build())
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (continuation.isActive) continuation.resumeWithException(BrowseException(
                        if (e is InterruptedIOException) BrowseFailure.TIMEOUT else BrowseFailure.CONNECTION))
                }
                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        try {
                            if (!it.isSuccessful) throw BrowseException(when (it.code) {
                                429 -> BrowseFailure.RATE_LIMITED
                                408, 504 -> BrowseFailure.TIMEOUT
                                in 500..599 -> BrowseFailure.TEMPORARILY_UNAVAILABLE
                                else -> BrowseFailure.UNAVAILABLE
                            })
                            val bytes = it.body.byteStream().use { stream ->
                                val output = java.io.ByteArrayOutputStream()
                                val buffer = ByteArray(8192)
                                while (true) {
                                    val size = stream.read(buffer)
                                    if (size < 0) break
                                    if (output.size() + size > 1_000_000) throw BrowseException(BrowseFailure.UNAVAILABLE)
                                    output.write(buffer, 0, size)
                                }
                                output.toByteArray()
                            }
                            if (bytes.size > 1_000_000) throw BrowseException(BrowseFailure.UNAVAILABLE)
                            if (continuation.isActive) continuation.resume(bytes.toString(Charsets.UTF_8))
                        } catch (error: Exception) {
                            if (continuation.isActive) continuation.resumeWithException(
                                error as? BrowseException ?: BrowseException(BrowseFailure.CONNECTION))
                        }
                    }
                }
            })
        }
}

internal fun parseBarnivoreSearch(html: String, locale: String, retrievedAt: String): BrowsePage {
    // Only parse known result markup. A site redesign/challenge must not become an empty success.
    val count = Regex("id=\"result-count\"[^>]*>\\s*([0-9,]+) products? found").find(html)
        ?.groupValues?.get(1)?.replace(",", "")?.toIntOrNull()
    if (html.contains("id=\"search-form\"") && Regex("<p[^>]*>Yikes, no matches found!</p>").containsMatchIn(html)) return BrowsePage(emptyList(), null)
    val results = Regex("<ul[^>]*id=\"results\"[^>]*>([\\s\\S]*?)</ul>").find(html)?.groupValues?.get(1)
    if (results == null && count != 0) throw BrowseException(BrowseFailure.UNAVAILABLE)
    val rows = Regex("<a\\s+[^>]*href=\"(/products/[0-9]+-[a-zA-Z0-9-]+)\"[^>]*>([\\s\\S]*?)</a>")
        .findAll(results.orEmpty()).take(100).mapNotNull { match ->
            val body = match.groupValues[2]
            fun span(css: String) = Regex("<span[^>]*class=\"$css\"[^>]*>([\\s\\S]*?)</span>")
                .find(body)?.groupValues?.get(1)?.let(::barnivoreText).orEmpty()
            val name = span("result-name").take(300)
            if (name.isBlank()) return@mapNotNull null
            val meta = span("result-meta").take(500)
            val status = when {
                Regex("class=\"[^\"]*\\bbadge-not-vegan\\b").containsMatchIn(body) -> if (locale == "de") "Laut Barnivore nicht vegan" else "Not vegan according to Barnivore"
                Regex("class=\"[^\"]*\\bbadge-vegan\\b").containsMatchIn(body) -> if (locale == "de") "Laut Barnivore vegan" else "Vegan according to Barnivore"
                else -> if (locale == "de") "Status unklar – Originaleintrag prüfen" else "Status unclear — check the original record"
            }
            BrowseRecord(match.groupValues[1].substringAfterLast('/'), BrowseSource.BARNIVORE, name,
                brand = meta.substringBefore(" · "), description = meta, labels = status,
                updated = retrievedAt, url = "https://www.barnivore.com${match.groupValues[1]}")
        }.toList()
    if (rows.isEmpty() && count != 0) throw BrowseException(BrowseFailure.UNAVAILABLE)
    return BrowsePage(rows, null)
}
private fun barnivoreText(value: String): String = value.replace(Regex("<[^>]*>"), " ")
    .replace(Regex("&#(x[0-9a-fA-F]+|[0-9]+);")) { match ->
        val raw = match.groupValues[1]
        val code = if (raw.startsWith("x")) raw.drop(1).toIntOrNull(16) else raw.toIntOrNull()
        if (code != null && Character.isValidCodePoint(code)) String(Character.toChars(code)) else match.value
    }.replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'")
    .replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ").replace("&amp;", "&")
    .replace(Regex("\\s+"), " ").trim()
