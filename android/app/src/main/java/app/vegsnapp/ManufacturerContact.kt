package app.vegsnapp

import org.json.JSONObject

/** Optional model content is never allowed to invalidate otherwise useful product evidence. */
internal fun safeManufacturerContact(value: JSONObject?): JSONObject? {
    value ?: return null
    val allowed = setOf("email", "url", "sourceUrl", "productName", "brand")
    if (value.keys().asSequence().any { it !in allowed }) return null
    for (field in listOf("productName", "brand")) {
        if (value.opt(field) !is String || value.getString(field).isBlank() || value.getString(field).length > 300 || value.getString(field).any { it.code < 32 }) return null
    }
    if (value.opt("sourceUrl") !is String || publicEvidenceUrl(value.getString("sourceUrl")) == null || value.getString("sourceUrl").any { it.isWhitespace() || it.code < 32 }) return null
    if (!value.has("email") && !value.has("url")) return null
    if (value.has("email")) {
        val email = value.opt("email") as? String ?: return null
        if (email.length > 254 || !Regex("[A-Za-z0-9](?:[A-Za-z0-9._+\\-]{0,62}[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9\\-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9\\-]*[A-Za-z0-9])?)+").matches(email) ||
            email.contains("..") || email.substringAfter('@').split('.').any { it.length > 63 }) return null
    }
    if (value.has("url") && (value.opt("url") !is String || publicEvidenceUrl(value.getString("url")) == null || value.getString("url").any { it.isWhitespace() || it.code < 32 })) return null
    return JSONObject(value.toString())
}

internal fun applyManufacturerContact(result: JSONObject, input: CheckInput, extracted: JSONObject): JSONObject {
    result.remove("manufacturerContact")
    if (result.optString("outcome") !in setOf("uncertain", "conflicting")) return result
    val contact = safeManufacturerContact(extracted.optJSONObject("contact")) ?: return result
    val research = extracted.optJSONObject("research") ?: return result
    if (!research.optBoolean("searched")) return result
    val sources = research.optJSONArray("sources") ?: return result
    val urls = (0 until sources.length()).mapNotNull { sources.optJSONObject(it)?.optString("url") }.toSet()
    if (contact.getString("sourceUrl") !in urls || contact.has("url") && contact.getString("url") !in urls) return result
    val name = normalizeProductIdentity(contact.getString("productName"))
    val brand = normalizeProductIdentity(contact.getString("brand"))
    val identity = result.optJSONObject("identity") ?: return result
    if (name != normalizeProductIdentity(extracted.optString("name")) || brand != normalizeProductIdentity(extracted.optString("brand")) ||
        name != normalizeProductIdentity(identity.optString("name")) || brand != normalizeProductIdentity(identity.optString("brand")) ||
        input.name.isNotBlank() && name != normalizeProductIdentity(input.name)) return result
    return result.put("manufacturerContact", contact)
}

private fun boundedContactText(value: String, limit: Int): String {
    var end = minOf(value.length, limit)
    if (end > 0 && end < value.length && value[end - 1].isHighSurrogate() && value[end].isLowSurrogate()) end--
    return value.substring(0, end)
}

internal data class ManufacturerDraft(val subject: String, val body: String)
internal fun manufacturerDraft(result: JSONObject, locale: String, messages: JSONObject): ManufacturerDraft {
    val copy = messages.getJSONObject("templates").getJSONObject(locale)
    val identity = result.optJSONObject("identity") ?: JSONObject()
    fun clean(value: String, limit: Int = 300) = boundedContactText(value.replace(Regex("[\\p{Cc}\\p{Cf}]"), " ").replace(Regex("\\s+"), " ").trim(), limit)
    val product = listOf(clean(identity.optString("brand")), clean(identity.optString("name"))).filter { it.isNotBlank() }.joinToString(" ")
        .ifBlank { copy.getString("thisProduct") }
    val findings = result.optJSONArray("findings")
    val terms = if (findings == null) emptyList() else (0 until findings.length()).mapNotNull { index ->
        findings.optJSONObject(index)?.takeIf { it.optString("status") in setOf("ambiguous", "unknown") }?.let { clean(if (it.optString("displayLocale") == locale) it.optString("displayTerm").ifBlank { it.optString("term") } else it.optString("term"), 100) }
    }.filter { it.isNotBlank() }.distinct().take(15)
    val translations = messages.getJSONArray("questions")
    val originQuestion = Regex("^(?:Confirm the origin of:|Die Herkunft dieser Zutaten klären:|Bekräfta ursprunget för:)\\s*(.+?)\\.?$")
    val termKeys = terms.map { it.lowercase(java.util.Locale.ROOT) }.toSet()
    val questions = result.optJSONArray("questions")
    val lines = (if (questions == null) emptyList() else (0 until questions.length()).mapNotNull { index ->
        val question = questions.getString(index)
        val translation = (0 until translations.length()).map { translations.getJSONObject(it) }
            .firstOrNull { pair -> listOf("en", "de", "sv", "sourceEn", "sourceDe", "sourceSv").any { pair.optString(it) == question } }
        val originTerms = originQuestion.matchEntire(question)?.groupValues?.get(1)?.split(",")
        val redundantOrigin = originTerms?.all { clean(it).lowercase(java.util.Locale.ROOT) in termKeys } == true
        if (terms.isNotEmpty() && (redundantOrigin || translation?.optString("en") == "Confirm the source of the ambiguous or unrecognized ingredients/materials.")) return@mapNotNull null
        clean(translation?.getString(locale) ?: question, 200)
    }.filter { it.isNotBlank() }.distinct().take(15)) +
        if (terms.isNotEmpty()) listOf(copy.getString("originQuestion") + " " + terms.joinToString(", ") + ".") else emptyList()
    val barcode = clean(identity.optString("barcode"))
    val source = safeManufacturerContact(result.optJSONObject("manufacturerContact"))?.getString("sourceUrl")
    val subject = clean(copy.getString("subject") + ": " + product, 200)
    val body = buildString {
        append(copy.getString("greeting") + "\n\n" + copy.getString("request").replace("{product}", product) + "\n")
        if (barcode.isNotBlank()) append("\n" + copy.getString("barcode") + ": " + barcode + "\n")
        if (result.optString("outcome") == "conflicting") append("\n" + copy.getString("conflict") + "\n")
        if (lines.isNotEmpty()) { append("\n" + copy.getString("questions") + "\n"); lines.forEach { append("- $it\n") } }
        if (source != null) append("\n" + copy.getString("source") + ": " + source + "\n")
        append("\n" + copy.getString("thanks"))
    }
    return ManufacturerDraft(subject, boundedContactText(body, 8000))
}
