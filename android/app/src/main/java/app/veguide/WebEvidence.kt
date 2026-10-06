package app.veguide

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
import org.json.JSONObject

/** Product identity must preserve recipe/variant distinctions such as percentages and Organic. */
internal fun normalizeProductIdentity(value: String): String = java.text.Normalizer.normalize(value, java.text.Normalizer.Form.NFKC)
    .lowercase(java.util.Locale.ROOT).trim().replace(Regex("\\s+"), " ")

internal fun publicEvidenceUrl(value: String): String? {
    val url = value.toHttpUrlOrNull() ?: return null
    if (!url.isHttps || url.username.isNotEmpty() || url.password.isNotEmpty() || value.length > 2000) return null
    if (url.host == "localhost" || url.host.endsWith(".local") || url.host.contains(':') || url.host.matches(Regex("[0-9.]+"))) return null
    return value
}

/** Only provider tool output supplies research metadata; model-authored JSON never does. */
internal fun responseResearch(response: JSONObject): JSONObject {
    val sources = linkedMapOf<String, JSONObject>()
    var searched = false
    fun source(item: JSONObject) {
        val url = publicEvidenceUrl(item.optString("url")) ?: return
        if (sources.size < 50) sources[url] = JSONObject().put("url", url).put("title", item.optString("title").take(300))
    }
    val output = response.optJSONArray("output") ?: JSONArray()
    for (index in 0 until output.length()) {
        val item = output.optJSONObject(index) ?: continue
        if (item.optString("type") == "web_search_call" && item.optString("status") == "completed") {
            searched = true
            val action = item.optJSONObject("action")
            action?.let(::source)
            val items = action?.optJSONArray("sources") ?: JSONArray()
            for (i in 0 until items.length()) items.optJSONObject(i)?.let(::source)
        }
        if (item.optString("type") == "message") {
            val content = item.optJSONArray("content") ?: JSONArray()
            for (i in 0 until content.length()) {
                val annotations = content.optJSONObject(i)?.optJSONArray("annotations") ?: JSONArray()
                for (j in 0 until annotations.length()) {
                    val annotation = annotations.optJSONObject(j) ?: continue
                    if (annotation.optString("type") == "url_citation") source(annotation)
                }
            }
        }
    }
    return JSONObject().put("searched", searched).put("sources", JSONArray(sources.values.toList()))
}

internal fun validateWebCompositions(extracted: JSONObject) {
    if (!extracted.has("webCompositions")) return
    val items = extracted.getJSONArray("webCompositions")
    require(items.length() <= 3)
    for (index in 0 until items.length()) {
        val item = items.getJSONObject(index)
        require(item.get("complete") is Boolean)
        require(item.optString("sourceType") in setOf("manufacturer", "retailer"))
        for ((field, limit) in mapOf("url" to 2000, "text" to 20_000, "productName" to 300, "brand" to 300)) {
            require(item.get(field) is String && item.getString(field).length in 1..limit)
        }
    }
}

/** Researched composition is a separate source, never invented photo transcription. */
internal fun applyWebCompositions(initial: JSONObject, input: CheckInput, extracted: JSONObject, evaluator: Evaluator): JSONObject {
    val research = extracted.optJSONObject("research") ?: return initial
    if (!research.optBoolean("searched")) return initial
    val sources = research.optJSONArray("sources") ?: JSONArray()
    val urls = (0 until sources.length()).map { sources.getJSONObject(it).getString("url") }.toSet()
    val name = normalizeProductIdentity(extracted.optString("name", input.name))
    val brand = normalizeProductIdentity(extracted.optString("brand"))
    if (name.isBlank() || brand.isBlank() || input.name.isNotBlank() && normalizeProductIdentity(input.name) != name) return initial
    var result = initial
    val items = extracted.optJSONArray("webCompositions") ?: JSONArray()
    val order = (0 until items.length()).sortedBy { if (items.getJSONObject(it).getString("sourceType") == "manufacturer") 0 else 1 }
    for (index in order) {
        val item = items.getJSONObject(index)
        val url = publicEvidenceUrl(item.getString("url")) ?: continue
        if (url !in urls || normalizeProductIdentity(item.getString("productName")) != name || normalizeProductIdentity(item.getString("brand")) != brand) continue
        val sourceInput = input.copy(text = item.getString("text"), complete = item.getBoolean("complete"))
        val composition = evaluator.evaluate(sourceInput).put("usedAI", true)
        val id = "web-composition-$index"
        val de = input.locale == "de"
        composition.put("evidence", JSONArray().put(JSONObject().put("id", id).put("kind", "ai_extraction")
            .put("title", if (item.getString("sourceType") == "manufacturer") { if (de) "Zusammensetzung laut Hersteller (KI)" else "Manufacturer composition (AI)" }
                else { if (de) "Zusammensetzung laut Händler (KI)" else "Retailer composition (AI)" })
            .put("excerpt", item.getString("text")).put("url", url).put("verification", "unverified")
            .put("retrievedAt", composition.getString("checkedAt"))))
        val findings = composition.getJSONArray("findings")
        for (i in 0 until findings.length()) findings.getJSONObject(i).put("evidenceId", id)
        composition.getJSONArray("warnings").put(if (de) "Zutaten von KI aus einer Webquelle gelesen; Produktvariante, Markt und aktuelle Rezeptur am Original prüfen." else "Ingredients read from a web source by AI; check the product variant, market and current recipe against the original.")
        result = mergeResults(result, applyAIEvidence(composition, sourceInput, extracted, item.getBoolean("complete"), false, "$id-assessment"))
    }
    return result
}

internal fun validateWebClaims(extracted: JSONObject) {
    if (!extracted.has("webClaims")) return
    val claims = extracted.getJSONArray("webClaims")
    require(claims.length() <= 5)
    for (index in 0 until claims.length()) {
        val item = claims.getJSONObject(index)
        require(item.optString("claim") in setOf("vegan", "not_vegan"))
        require(item.optString("sourceType") in setOf("manufacturer", "certification"))
        for ((field, limit) in mapOf("url" to 2000, "quote" to 1000, "productName" to 300, "brand" to 300)) {
            require(item.get(field) is String && item.getString(field).length in 1..limit)
        }
    }
}

internal fun applyWebEvidence(result: JSONObject, input: CheckInput, extracted: JSONObject): JSONObject {
    val research = extracted.optJSONObject("research") ?: return result.put("webSearchStatus", "unsupported")
    result.put("webSearchStatus", if (research.optBoolean("searched")) "searched" else "not_used")
    if (!research.optBoolean("searched")) return result
    val sources = research.optJSONArray("sources") ?: JSONArray()
    val urls = (0 until sources.length()).map { sources.getJSONObject(it).getString("url") }.toSet()
    fun consultedOnly(): JSONObject {
        val evidence = result.getJSONArray("evidence")
        if ((0 until evidence.length()).any { evidence.getJSONObject(it).getString("id").startsWith("web-composition-") }) return result
        for (index in 0 until minOf(3, sources.length())) {
            val source = sources.getJSONObject(index)
            val url = publicEvidenceUrl(source.optString("url")) ?: continue
            result.getJSONArray("evidence").put(JSONObject().put("id", "web-consulted-$index").put("kind", "ai_extraction")
                .put("title", if (input.locale == "de") "Bei der Webrecherche konsultiert" else "Consulted during web research")
                .put("excerpt", if (input.locale == "de") "Keine passende produktspezifische Aussage bestätigt." else "No matching product-specific claim was established.")
                .put("url", url).put("verification", "unverified").put("retrievedAt", result.getString("checkedAt")))
        }
        return result
    }
    var accepted = false
    val claims = extracted.optJSONArray("webClaims") ?: JSONArray()
    val name = normalizeProductIdentity(extracted.optString("name", input.name))
    val brand = normalizeProductIdentity(extracted.optString("brand"))
    if (name.isBlank() || brand.isBlank() || input.name.isNotBlank() && normalizeProductIdentity(input.name) != name) return consultedOnly()
    val de = input.locale == "de"
    for (index in 0 until claims.length()) {
        val item = claims.getJSONObject(index)
        val url = publicEvidenceUrl(item.getString("url")) ?: continue
        if (url !in urls || normalizeProductIdentity(item.getString("productName")) != name || normalizeProductIdentity(item.getString("brand")) != brand) continue
        accepted = true
        val claim = item.getString("claim")
        val certification = item.getString("sourceType") == "certification"
        val current = result.getString("outcome")
        val conflict = current == "conflicting" || current == "vegan" && claim == "not_vegan" || current == "not_vegan" && claim == "vegan"
        result.put("outcome", if (conflict) "conflicting" else if (claim == "vegan") "vegan" else "not_vegan")
            .put("basis", if (conflict) "insufficient" else if (certification) "research" else "manufacturer")
            .put("summary", if (conflict) {
                if (de) "Die Produktquellen widersprechen sich. Produktvariante und Belege prüfen." else "The product sources disagree. Check the product variant and evidence."
            } else if (claim == "vegan") {
                if (de) "Eine bei der Websuche gelesene Produktquelle bezeichnet das Produkt als vegan. Die KI-Zuordnung und das Zitat prüfen." else "A product source read during web search describes this product as vegan. Check the AI's product match and quoted source."
            } else {
                if (de) "Eine bei der Websuche gelesene Produktquelle bezeichnet das Produkt als nicht vegan. Die KI-Zuordnung und das Zitat prüfen." else "A product source read during web search describes this product as not vegan. Check the AI's product match and quoted source."
            })
        if (!conflict) result.put("questions", JSONArray())
        result.getJSONArray("evidence").put(JSONObject().put("id", "web-claim-$index").put("kind", if (certification) "certification" else "manufacturer")
            .put("title", if (de) "Produktquelle — von KI ausgewertet" else "Product source — interpreted by AI")
            .put("excerpt", item.getString("quote")).put("url", url).put("claim", claim).put("verification", "unverified")
            .put("retrievedAt", result.getString("checkedAt")))
        result.getJSONArray("warnings").put(if (de) "Webquelle von KI gelesen; Produktzuordnung und Aussage wurden nicht unabhängig geprüft." else "Web source read by AI; the product match and claim have not been independently verified.")
    }
    return if (accepted) result else consultedOnly()
}
