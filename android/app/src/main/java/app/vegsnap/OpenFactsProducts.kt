package app.vegsnap

import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject

/** OFF product API allows 15 reads/minute/IP. Shared by passive scans and every queued check. */
class OpenFactsProductRequests(private val now: () -> Long = { System.nanoTime() / 1_000_000 },
    private val wait: suspend (Long) -> Unit = { delay(it) }) {
    private data class Cached(val json: String?, val until: Long)
    private val lock = Mutex()
    private val cache = linkedMapOf<String, Cached>()
    private var lastStarted: Long? = null
    suspend fun product(url: String, fetch: suspend () -> JSONObject?): JSONObject? = lock.withLock {
        val current = now()
        cache.entries.removeAll { it.value.until <= current }
        cache[url]?.let { return@withLock it.json?.let(::JSONObject) }
        lastStarted?.let { started -> val remaining = 4_100 - (current - started); if (remaining > 0) wait(remaining) }
        lastStarted = now()
        val response = fetch()
        cache[url] = Cached(response?.toString(), now() + if (response == null) 60_000 else 5 * 60_000)
        if (cache.size > 80) cache.remove(cache.keys.first())
        response?.let { JSONObject(it.toString()) }
    }
}
internal val openFactsProducts = OpenFactsProductRequests()

/** Open Facts label tags include their parents, so any vegan certification also carries en:vegan. */
internal val veganDatabaseLabels = setOf("en:vegan", "en:vegan-society", "en:vegan-society-approved", "en:v-label-vegan", "en:certified-vegan")

/** A recorded vegan label settles open origins (lecithin, flavourings), but never outweighs animal ingredients. */
internal fun applyDatabaseLabels(result: JSONObject, labels: List<String>, locale: String): JSONObject {
    if (labels.none { it in veganDatabaseLabels }) return result
    val findings = result.optJSONArray("findings") ?: JSONArray()
    val conflict = result.getString("outcome") == "not_vegan" || (0 until findings.length()).any { findings.getJSONObject(it).optString("status") == "animal" }
    result.put("outcome", if (conflict) "conflicting" else "vegan").put("basis", if (conflict) "insufficient" else "packaging")
        .put("summary", if (conflict) ResultStrings.databaseLabelConflictSummary(locale) else ResultStrings.databaseLabelSummary(locale))
    if (!conflict) result.put("questions", JSONArray())
    result.getJSONArray("warnings").put(ResultStrings.databaseLabelCaution(locale))
    return result
}
