package org.veguide.android

import java.text.Normalizer
import java.time.LocalDate
import java.time.Instant
import java.time.YearMonth
import java.util.Locale
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
import org.json.JSONObject

/** Reviewed local records only. Product titles and model-authored accusations are never matched. */
class CompanyConcernResolver(document: JSONObject = JSONObject()) {
    private val entities = document.optJSONArray("entities").objects().associateBy { it.optString("id") }
    private val records = document.optJSONArray("records").objects()
    private val aliases = entities.values.flatMap { entity ->
        (listOf(entity.optString("name")) + entity.optJSONArray("aliases").strings()).map { key(it) to entity }
    }.filter { it.first.isNotEmpty() }.groupBy({ it.first }, { it.second }).mapValues { (_, values) -> values.distinctBy { it.optString("id") } }

    fun attach(result: JSONObject, locale: String): JSONObject = result.put("companyConcerns", resolve(result.optJSONObject("identity")?.optString("brand").orEmpty(), locale))

    fun resolve(brand: String, locale: String): JSONArray {
        if (brand.length > 1000 || aliases[key(brand)]?.size?.let { it > 1 } == true) return JSONArray()
        fun exact(value: String) = aliases[key(value)]?.singleOrNull()
        val whole = exact(brand)
        val segments = if (whole == null) brand.split(',') else listOf(brand)
        if (segments.size > 8) return JSONArray()
        val matched = whole?.let(::listOf) ?: segments.mapNotNull(::exact).distinctBy { it.optString("id") }
        val concerns = JSONArray()
        for (entity in matched) {
            val parentLink = entity.optJSONObject("parent")
            val parent = parentLink?.takeIf { validUrl(it.optString("sourceUrl")) && reviewDate(it.optString("reviewedAt")) != null }
                ?.let { entities[it.optString("id")] }?.takeIf { it.optString("kind") == "company" && it.optString("id") != entity.optString("id") }
            for ((target, scope) in listOfNotNull(entity to "direct", parent?.let { it to "parent" })) {
                for (record in records.filter { it.optString("companyId") == target.optString("id") }) {
                    if (record.optString("category") !in setOf("animal_testing", "animal_welfare_lobbying", "animal_exploitation") ||
                        record.optString("status") !in setOf("current", "resolved", "disputed") ||
                        !validUrl(record.optString("sourceUrl")) || reviewDate(record.optString("reviewedAt")) == null) continue
                    val description = record.optJSONObject("description")?.optString(if (locale == "de") "de" else "en").orEmpty()
                    if (description.isBlank()) continue
                    val concern = JSONObject().put("id", record.getString("id")).put("company", target.getString("name"))
                        .put("matchedBrand", entity.getString("name")).put("scope", scope)
                        .put("category", record.getString("category")).put("description", description)
                        .put("sourceUrl", record.getString("sourceUrl")).put("reviewedAt", reviewDate(record.getString("reviewedAt")))
                        .put("status", record.getString("status"))
                    if (sourceDate(record.optString("sourceDate"))) concern.put("sourceDate", record.getString("sourceDate"))
                    if (scope == "parent") concern.put("ownershipSourceUrl", parentLink!!.getString("sourceUrl"))
                        .put("ownershipReviewedAt", reviewDate(parentLink.getString("reviewedAt")))
                    concerns.put(concern)
                }
            }
        }
        return concerns
    }

    private fun key(value: String) = Normalizer.normalize(value, Normalizer.Form.NFKC).trim().replace(Regex("\\s+"), " ").lowercase(Locale.ROOT)
    private fun validUrl(value: String) = value.toHttpUrlOrNull()?.let { it.isHttps && it.username.isEmpty() && it.password.isEmpty() } == true
    private fun reviewDate(value: String): String? = runCatching { Instant.parse(value).toString() }.getOrNull()
        ?: runCatching { LocalDate.parse(value).toString() + "T00:00:00Z" }.getOrNull()
    private fun sourceDate(value: String) = reviewDate(value) != null || runCatching { YearMonth.parse(value) }.isSuccess
    private fun JSONArray?.objects() = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
    private fun JSONArray?.strings() = if (this == null) emptyList() else (0 until length()).mapNotNull { opt(it) as? String }
}
