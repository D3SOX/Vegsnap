package app.vegsnap

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Public catalogue lookup when web search misses a Swedish product. Never guesses product URLs. */
internal class MatsparCatalogue(
    private val http: OkHttpClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .callTimeout(10, TimeUnit.SECONDS).connectTimeout(5, TimeUnit.SECONDS).build(),
    private val endpoint: HttpUrl = "https://api.matspar.se/slug".toHttpUrl(),
) {
    suspend fun lookup(identity: JSONObject): JSONObject? {
        val packaging = identity.optJSONObject("packaging") ?: return null
        if (identity.optString("category") !in setOf("food", "drink") ||
            normalizeProductIdentity(packaging.optString("language")) !in setOf("sv", "swedish", "svenska") ||
            packaging.has("country") && normalizeProductIdentity(packaging.optString("country")) !in setOf("se", "sweden", "sverige") ||
            identity.optString("barcode").let(::validGtin)) return null
        val name = identity.optString("name")
        val brand = identity.optString("brand")
        val quantity = packaging.optString("quantity")
        if (name.isBlank() || brand.isBlank() || quantity.isBlank()) return null
        val query = "$brand $name".take(601)
        val result = page("/kategori", JSONObject().put("q", query), "category") ?: return null
        val products = result.optJSONArray("products") ?: return null
        if (products.length() > 100) return null
        val matches = (0 until products.length()).mapNotNull { products.optJSONObject(it) }
            .filter { matches(it, name, brand, quantity, packaging.optString("variant")) }
        val candidate = matches.singleOrNull() ?: return null
        val slug = candidate.optString("slug")
        if (!slug.matches(Regex("produkt/[a-z0-9-]{1,300}"))) return null
        val url = "https://www.matspar.se/$slug"
        val product = page("/$slug", JSONObject(), "product") ?: return null
        if (product.optString("slug") != slug || !matches(product, name, brand, quantity, packaging.optString("variant"))) return null
        val text = product.optString("ingredients")
        if (text.isBlank() || text.length > 20_000) return null
        return JSONObject().put("url", url.toString()).put("productName", product.getString("name"))
            .put("brand", product.getString("brand")).put("quantity", product.getString("weight_pretty"))
            .put("text", text).put("sourceType", "retailer")
    }

    private fun matches(product: JSONObject, name: String, brand: String, quantity: String, variant: String): Boolean =
        normalizeProductIdentity(product.optString("brand")) == normalizeProductIdentity(brand) &&
            nameWords(product.optString("name"), brand) == nameWords(name, brand) &&
            quantityKey(product.optString("weight_pretty")) == quantityKey(quantity) &&
            nameWords(variant, brand).all { it in nameWords(product.optString("name"), brand) }

    // Swedish "med" is grammatical; preserve every other word, including recipe/variant qualifiers.
    private fun nameWords(value: String, brand: String): List<String> = normalizeProductIdentity(value)
        .removePrefix(normalizeProductIdentity(brand) + " ").split(Regex("\\s+"))
        .filter { it.isNotBlank() && it != "med" }.sorted()
    private fun quantityKey(value: String): String = normalizeProductIdentity(value).replace(Regex("\\s+"), "")

    private suspend fun page(slug: String, query: JSONObject, type: String): JSONObject? = suspendCancellableCoroutine { continuation ->
        val body = JSONObject().put("slug", slug).put("query", query).toString()
        val call = http.newCall(Request.Builder().url(endpoint).post(body.toRequestBody("application/json".toMediaType())).build())
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { if (continuation.isActive) continuation.resumeWithException(e) }
            override fun onResponse(call: Call, response: Response) {
                try {
                    val result = response.use {
                        if (!it.isSuccessful) return@use null
                        val output = java.io.ByteArrayOutputStream()
                        val buffer = ByteArray(8192)
                        val stream = it.body.byteStream()
                        while (output.size() <= 256_000) {
                            val count = stream.read(buffer, 0, minOf(buffer.size, 256_001 - output.size()))
                            if (count < 0) break
                            output.write(buffer, 0, count)
                        }
                        val body = output.toByteArray()
                        require(body.size <= 256_000) { "Catalogue response too large" }
                        val document = JSONObject(body.toString(Charsets.UTF_8))
                        if (document.optString("type") == type) document.optJSONObject("payload") else null
                    }
                    if (continuation.isActive) continuation.resume(result)
                } catch (error: Exception) { if (continuation.isActive) continuation.resumeWithException(error) }
            }
        })
    }
}
