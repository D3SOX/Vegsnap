package app.vegsnapp

import java.time.Instant
import org.json.JSONObject

/** AI company research is optional, separate from reviewed records and the product verdict. */
internal fun safeCompanyAssessment(value: JSONObject?, saved: Boolean = false): JSONObject? {
    value ?: return null
    val allowed = setOf("brand", "company", "scope", "verdict", "summary", "categories", "sources", "ownershipSourceUrl") + if (saved) setOf("assessedAt") else emptySet()
    if (value.keys().asSequence().any { it !in allowed }) return null
    fun text(item: JSONObject, key: String, limit: Int): Boolean {
        val content = item.opt(key) as? String ?: return false
        return content.isNotBlank() && content.length <= limit && content.none { it.isISOControl() && it != '\n' && it != '\t' }
    }
    fun url(item: JSONObject, key: String): Boolean {
        val content = item.opt(key) as? String ?: return false
        return content.none { it.isWhitespace() || it.isISOControl() } && publicEvidenceUrl(content) != null
    }
    if (!text(value, "brand", 300) || !text(value, "company", 300) || !text(value, "summary", 1500)) return null
    if (listOf("brand", "company").any { value.getString(it).any(Char::isISOControl) }) return null
    if (value.optString("scope") !in setOf("direct", "parent")) return null
    val verdict = value.optString("verdict")
    if (verdict !in setOf("concerns_found", "no_concerns_found", "inconclusive")) return null
    val categories = value.optJSONArray("categories") ?: return null
    if (categories.length() > 3) return null
    val unique = mutableSetOf<String>()
    for (index in 0 until categories.length()) {
        val category = categories.opt(index) as? String ?: return null
        if (category !in setOf("animal_testing", "animal_welfare_lobbying", "animal_exploitation") || !unique.add(category)) return null
    }
    if (verdict == "concerns_found" && unique.isEmpty() || verdict == "no_concerns_found" && unique.isNotEmpty()) return null
    val sources = value.optJSONArray("sources") ?: return null
    if (sources.length() !in 1..5) return null
    for (index in 0 until sources.length()) {
        val source = sources.optJSONObject(index) ?: return null
        if (source.keys().asSequence().any { it !in setOf("url", "title", "quote") } || !url(source, "url") || !text(source, "title", 300) || !text(source, "quote", 1000)) return null
    }
    if (value.optString("scope") == "parent" && !value.has("ownershipSourceUrl")) return null
    if (value.has("ownershipSourceUrl") && !url(value, "ownershipSourceUrl")) return null
    if (saved && (value.opt("assessedAt") !is String || runCatching { Instant.parse(value.getString("assessedAt")) }.isFailure)) return null
    return JSONObject(value.toString())
}

internal fun sourcedCompanyAssessment(extracted: JSONObject): JSONObject? {
    val assessment = safeCompanyAssessment(extracted.optJSONObject("companyAssessment")) ?: return null
    if (normalizeProductIdentity(assessment.getString("brand")) != normalizeProductIdentity(extracted.optString("brand"))) return null
    val research = extracted.optJSONObject("research") ?: return null
    if (research.opt("searched") != true) return null
    val sources = research.optJSONArray("sources") ?: return null
    val urls = (0 until sources.length()).mapNotNull { sources.optJSONObject(it)?.optString("url") }.toSet()
    val cited = assessment.getJSONArray("sources")
    if ((0 until cited.length()).any { cited.getJSONObject(it).getString("url") !in urls }) return null
    if (assessment.has("ownershipSourceUrl") && assessment.getString("ownershipSourceUrl") !in urls) return null
    return assessment
}

internal fun applyCompanyAssessment(result: JSONObject, extracted: JSONObject): JSONObject {
    result.remove("companyAssessment")
    val assessment = sourcedCompanyAssessment(extracted) ?: return result
    if (normalizeProductIdentity(assessment.getString("brand")) != normalizeProductIdentity(result.optJSONObject("identity")?.optString("brand").orEmpty())) return result
    assessment.put("assessedAt", result.optString("checkedAt"))
    safeCompanyAssessment(assessment, saved = true)?.let { result.put("companyAssessment", it) }
    return result
}
