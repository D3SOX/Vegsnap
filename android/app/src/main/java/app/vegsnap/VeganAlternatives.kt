package app.vegsnap

import java.text.Normalizer
import java.util.Locale
import okhttp3.HttpUrl
import org.json.JSONObject

internal data class AlternativeQuery(val query: String, val store: String = "", val category: String = "food", val market: String = "DE", val locale: String = "en", val excludeBarcode: String = "")
internal data class VeganAlternative(val id: String, val name: String, val brand: String, val url: String, val source: String,
    val evidence: String, val storeMatch: Boolean, val stores: List<String>, val marketListed: Boolean, val barcode: String = "", val storeUrl: String = "")
private fun alternativeKey(value: String) = Normalizer.normalize(value, Normalizer.Form.NFKD).replace(Regex("\\p{M}"), "")
    .lowercase(Locale.ROOT).replace(Regex("[^\\p{L}\\p{N}]+"), " ").trim()
internal fun alternativeQueryForProduct(name: String, brand: String, animalTerms: List<String>): String {
    val omit = (listOf(brand) + animalTerms).flatMap { alternativeKey(it).split(' ') }.filter { it.isNotBlank() }.toSet()
    val query = Regex("[\\p{L}\\p{N}]+").findAll(name).map { it.value }.filter { alternativeKey(it) !in omit }.joinToString(" ")
    return (query.takeIf { it.length >= 2 } ?: name).take(200)
}
internal fun validateAlternativeQuery(input: AlternativeQuery) {
    require(input.query.trim().length in 2..200 && input.store.length <= 100 && validProductMarket(input.market) &&
        input.category in setOf("food", "drink", "cosmetics", "household", "clothing", "shoes", "other") && input.locale in setOf("en", "de"))
}
internal fun alternativeSource(category: String) = when (category) { "food", "drink" -> BrowseSource.FOOD; "cosmetics" -> BrowseSource.BEAUTY; else -> BrowseSource.PRODUCTS }
internal fun alternativeUrl(input: AlternativeQuery, root: HttpUrl, storeOnly: Boolean): HttpUrl {
    validateAlternativeQuery(input)
    return root.newBuilder().addPathSegments("cgi/search.pl").addQueryParameter("search_terms", input.query.trim())
        .addQueryParameter("search_simple", "1").addQueryParameter("action", "process").addQueryParameter("json", "1").addQueryParameter("page_size", "40")
        .addQueryParameter("tagtype_0", "labels").addQueryParameter("tag_contains_0", "contains").addQueryParameter("tag_0", "vegan")
        .addQueryParameter("fields", "code,product_name,product_name_de,brands,ingredients_text,ingredients_text_de,labels_tags,ingredients_analysis_tags,countries_tags,stores,stores_tags,categories_tags")
        .addQueryParameter("lc", input.locale).apply { if (storeOnly && input.store.isNotBlank()) {
            addQueryParameter("tagtype_1", "stores"); addQueryParameter("tag_contains_1", "contains"); addQueryParameter("tag_1", input.store.trim())
        } }.build()
}
private val veganLabels = setOf("en:vegan", "en:vegan-society", "en:vegan-society-approved", "en:v-label-vegan", "en:certified-vegan")
internal fun parsePublicAlternatives(document: JSONObject, input: AlternativeQuery, evaluator: Evaluator): List<VeganAlternative> {
    val products = document.optJSONArray("products") ?: throw BrowseException(BrowseFailure.UNAVAILABLE)
    if (document.has("error") || document.has("errors")) throw BrowseException(BrowseFailure.UNAVAILABLE)
    val source = alternativeSource(input.category)
    val items = (0 until minOf(products.length(), 40)).mapNotNull { index ->
        val product = products.optJSONObject(index) ?: return@mapNotNull null
        val code = product.optString("code")
        val name = (if (input.locale == "de") product.optString("product_name_de").ifBlank { product.optString("product_name") }
            else product.optString("product_name").ifBlank { product.optString("product_name_de") }).trim().take(300)
        val labels = product.optJSONArray("labels_tags").stringValues()
        if (!code.matches(Regex("[0-9]{8,14}")) || name.isBlank() || code.padStart(14, '0') == input.excludeBarcode.padStart(14, '0') ||
            labels.none { it in veganLabels } || "en:non-vegan" in product.optJSONArray("ingredients_analysis_tags").stringValues()) return@mapNotNull null
        val composition = product.optString("ingredients_text").ifBlank { product.optString("ingredients_text_de") }.take(20000)
        if (composition.isNotBlank() && evaluator.evaluate(CheckInput(text = composition, category = input.category)).optString("outcome") == "not_vegan") return@mapNotNull null
        val countries = product.optJSONArray("countries_tags").stringValues().mapNotNull(::productCountryCode)
        if (countries.isNotEmpty() && input.market !in countries) return@mapNotNull null
        val stores = product.optString("stores").take(1000).split(Regex("[,;]")).map { it.trim() }.filter { it.isNotBlank() }
        val storeMatch = input.store.isNotBlank() && (stores + product.optJSONArray("stores_tags").stringValues()).any { alternativeKey(it) == alternativeKey(input.store) }
        VeganAlternative("${source.name}:$code", name, product.optString("brands").take(300), source.root + "product/" + code,
            source.title, labels.filter { it in veganLabels }.joinToString(", "), storeMatch, stores.ifEmpty { if (storeMatch) listOf(input.store) else emptyList() }, input.market in countries, code)
    }
    return rankAlternatives(items, input)
}
internal fun rankAlternatives(items: List<VeganAlternative>, input: AlternativeQuery): List<VeganAlternative> {
    val words = alternativeKey(input.query).split(' ').filter { it.length > 1 }
    fun score(item: VeganAlternative) = (if (item.storeMatch) 1000 else 0) + (if (item.marketListed) 100 else 0) + words.count { it in alternativeKey(item.name).split(' ') }
    return items.sortedWith(compareByDescending<VeganAlternative> { score(it) }.thenBy { it.name })
        .distinctBy { it.barcode.takeIf { code -> code.isNotBlank() }?.padStart(14, '0') ?: "${alternativeKey(it.brand)}:${alternativeKey(it.name)}" }.take(20)
}
internal fun parseAIAlternatives(extraction: JSONObject, input: AlternativeQuery): List<VeganAlternative> {
    val research = extraction.optJSONObject("research") ?: return emptyList()
    if (!research.optBoolean("searched")) return emptyList()
    val sources = research.optJSONArray("sources") ?: return emptyList()
    val consulted = (0 until sources.length()).mapNotNull { sources.optJSONObject(it)?.optString("url") }.toSet()
    fun supported(url: String) = url in consulted && publicEvidenceUrl(url) != null && url.startsWith("https://")
    val alternatives = extraction.optJSONArray("alternatives") ?: return emptyList()
    return (0 until minOf(alternatives.length(), 5)).mapNotNull { index ->
        val item = alternatives.optJSONObject(index) ?: return@mapNotNull null
        val name = item.optString("name"); val brand = item.optString("brand"); val url = item.optString("url"); val quote = item.optString("quote")
        if (name.isBlank() || name.length > 300 || brand.isBlank() || brand.length > 300 || url.length > 2000 || quote.length > 1000 ||
            !supported(url) || !Regex("\\bvegan(?:e[nmrs]?)?\\b", RegexOption.IGNORE_CASE).containsMatchIn(quote) ||
            Regex("\\b(?:not|non|nicht|kein\\w*)[\\s-]+vegan(?:e[nmrs]?)?\\b", RegexOption.IGNORE_CASE).containsMatchIn(quote)) return@mapNotNull null
        val storeUrl = item.optString("storeUrl")
        val storeMatch = input.store.isNotBlank() && alternativeKey(item.optString("store")) == alternativeKey(input.store) && supported(storeUrl) && item.optString("storeQuote").isNotBlank()
        VeganAlternative(url, name, brand, url, "AI", quote, storeMatch, if (storeMatch) listOf(input.store) else emptyList(), false, storeUrl = if (storeMatch) storeUrl else "")
    }
}
