package app.vegsnap

import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.util.Locale

/** Selects one public database record only when the packaging identifies it unambiguously. */
internal class IdentifiedProductLookup(private val browse: BrowseRepository = BrowseRepository()) {
    suspend fun lookup(identity: JSONObject): BrowseRecord? = withTimeoutOrNull(8_000) {
        val source = when (identity.optString("category")) {
            "food", "drink" -> BrowseSource.FOOD
            "cosmetics" -> BrowseSource.BEAUTY
            "clothing", "shoes", "household" -> BrowseSource.PRODUCTS
            else -> return@withTimeoutOrNull null
        }
        val name = identity.optString("name").trim()
        val brand = identity.optString("brand").trim()
        val packaging = identity.optJSONObject("packaging") ?: return@withTimeoutOrNull null
        val quantity = identityNormalize(packaging.optString("quantity"))
        if (name.isBlank() || brand.isBlank() || quantity.isBlank() || validGtin(identity.optString("barcode"))) return@withTimeoutOrNull null

        val queryName = stripBrandPrefix(name, brand)
        val query = "$brand $queryName".trim()
        if (query.length !in 2..200) return@withTimeoutOrNull null
        val language = identityNormalize(packaging.optString("language"))
        val lookupLocale = Locale.getISOLanguages().firstOrNull { code ->
            val locale = Locale.forLanguageTag(code)
            language in listOf(code, locale.getISO3Language(), identityNormalize(locale.getDisplayLanguage(Locale.ENGLISH)),
                identityNormalize(locale.getDisplayLanguage(locale)))
        } ?: "en"
        val page = browse.search(source, query, locale = lookupLocale)
        if (page.next != null) return@withTimeoutOrNull null

        val ignored = when (lookupLocale) {
            "sv" -> "med"
            "en" -> "with"
            else -> ""
        }
        val identityWords = nameWords(stripBrandPrefix(name, brand), ignored)
        if (identityWords.isEmpty()) return@withTimeoutOrNull null
        val variantWords = nameWords(stripBrandPrefix(packaging.optString("variant"), brand), ignored)
        val candidateRecords = page.records.filter { record ->
            record.composition.isNotBlank() &&
                identityNormalize(record.brand) == identityNormalize(brand) &&
                nameWords(stripBrandPrefix(record.name, brand), ignored) == identityWords &&
                identityNormalize(record.quantity).replace(Regex("\\s+"), "") == quantity.replace(Regex("\\s+"), "") &&
                variantWords.all { it in nameWords(record.name, ignored) } &&
                marketMatches(packaging.optString("country").ifBlank { identity.optString("market") }, record.markets)
        }
        candidateRecords.singleOrNull()
    }

    private fun stripBrandPrefix(value: String, brand: String): String {
        var result = value.trim()
        val prefix = Regex("^${Regex.escape(brand.trim())}(?:\\s+|$)", RegexOption.IGNORE_CASE)
        while (prefix.containsMatchIn(result)) result = result.replaceFirst(prefix, "").trim()
        return result
    }

    private fun identityNormalize(value: String): String = normalizeProductIdentity(value)
    private fun nameWords(value: String, ignored: String = ""): List<String> = identityNormalize(value)
        .split(Regex("\\s+"))
        .filter { it.isNotBlank() && (ignored.isBlank() || it != ignored) }
        .sorted()

    private fun marketMatches(country: String, markets: String): Boolean {
        if (country.isBlank()) return true
        if (markets.isBlank()) return false
        val expected = productCountryCode(country) ?: return false
        return markets.split(Regex("[,;|]")).any { productCountryCode(it) == expected }
    }
}

/** Name matches remain unconfirmed and community compositions remain potentially incomplete. */
internal fun identifiedDatabaseRecord(record: BrowseRecord, identity: JSONObject): Pair<CheckInput, JSONObject> {
    val input = CheckInput(text = record.composition, category = identity.getString("category"), complete = false,
        name = identity.getString("name"), locale = identity.optString("locale", "en"))
    val evidence = JSONObject().put("id", "${record.source.name.lowercase()}:${record.id}").put("kind", "database")
        .put("title", record.source.title).put("url", record.url).put("excerpt", record.composition)
        .put("databaseBrand", record.brand).put("retrievedAt", java.time.Instant.now().toString()).put("license", record.source.license)
    if (record.updated.isNotBlank()) evidence.put("sourceDate", record.updated + "T00:00:00Z")
    return input to evidence
}
