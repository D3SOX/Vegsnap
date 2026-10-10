package app.vegsnap

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
import org.json.JSONObject

/** Product identity must preserve recipe/variant distinctions such as percentages and Organic. */
internal fun normalizeProductIdentity(value: String): String = java.text.Normalizer.normalize(value, java.text.Normalizer.Form.NFKC)
    .lowercase(java.util.Locale.ROOT).trim().replace(Regex("\\s+"), " ")

/** Keep evidence URLs when bounding verbose provider search results, without inventing provenance. */
internal fun boundedResearchSources(sources: List<JSONObject>, extractions: List<JSONObject>): JSONArray {
    val cited = mutableSetOf<String>()
    for (extracted in extractions) {
        for (field in listOf("webCompositions", "webClaims")) {
            val items = extracted.optJSONArray(field) ?: JSONArray()
            for (i in 0 until items.length()) cited += items.getJSONObject(i).optString("url")
        }
        extracted.optJSONObject("contact")?.let { cited += it.optString("sourceUrl"); cited += it.optString("url") }
        extracted.optJSONObject("companyAssessment")?.let { company ->
            cited += company.optString("ownershipSourceUrl")
            val items = company.optJSONArray("sources") ?: JSONArray()
            for (i in 0 until items.length()) cited += items.getJSONObject(i).optString("url")
        }
    }
    return JSONArray(sources.distinctBy { it.getString("url") }.sortedBy { it.getString("url") !in cited }.take(50))
}

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
        validateIngredients(item)
        require(item.get("complete") is Boolean)
        require(item.optString("sourceType") in setOf("manufacturer", "retailer"))
        for ((field, limit) in mapOf("url" to 2000, "text" to 20_000, "productName" to 300, "brand" to 300)) {
            require(item.get(field) is String && item.getString(field).length in 1..limit)
        }
    }
}

/** A model split must cover the fetched list before it can replace the local split. */
private fun coversCatalogueComposition(text: String, items: JSONArray): Boolean {
    val parsed = parseSourceIngredients(text, items) ?: return false
    val heading = compositionHeading.find(text)
    var body = heading?.let { text.substring(it.range.last + 1) } ?: text
    compositionPrecaution.find(body)?.let { body = body.take(it.range.first) }
    // This retailer's origin-location footnote is not part of the ingredient list.
    body = body.replace(Regex("\\s+\\*Ursprung: Se till vänster\\.?\\s*$", RegexOption.IGNORE_CASE), "")
    return compositionTerms(body).all { term ->
        var remaining = term
        for (ingredient in parsed.sortedByDescending { it.length }) {
            remaining = remaining.replace(Regex("(?<![\\p{L}\\p{N}])${Regex.escape(ingredient)}(?![\\p{L}\\p{N}])"), "")
        }
        !Regex("[\\p{L}\\p{N}]").containsMatchIn(remaining)
    }
}

/** Allow Swedish grammatical and brand-prefix variations, preserving every recipe qualifier. */
internal fun matchesCatalogueIdentity(extracted: JSONObject, original: JSONObject): Boolean {
    val brand = normalizeProductIdentity(original.optString("brand"))
    fun nameWords(value: String) = normalizeProductIdentity(value).removePrefix("$brand ")
        .split(Regex("\\s+")).filter { it.isNotBlank() && it != "med" }.sorted()
    return brand.isNotBlank() && normalizeProductIdentity(extracted.optString("brand")) == brand &&
        nameWords(extracted.optString("name")) == nameWords(original.optString("name"))
}

/** The app fetched and matched this record itself; AI formatting cannot erase its composition. */
internal fun retainCatalogueComposition(extracted: JSONObject, catalogue: JSONObject, identity: JSONObject) {
    val url = catalogue.getString("url")
    val text = catalogue.getString("text")
    // Fetching a composition cannot establish provenance for other model claims.
    extracted.optJSONArray("webClaims")?.let { claims ->
        extracted.put("webClaims", JSONArray((0 until claims.length()).map { claims.getJSONObject(it) }.filter { it.getString("url") != url }))
    }
    extracted.optJSONObject("contact")?.let { contact ->
        if (contact.optString("sourceUrl") == url || contact.optString("url") == url) extracted.remove("contact")
    }
    extracted.optJSONObject("companyAssessment")?.let { company ->
        val sources = company.optJSONArray("sources") ?: JSONArray()
        if (company.optString("ownershipSourceUrl") == url || (0 until sources.length()).any { sources.optJSONObject(it)?.optString("url") == url })
            extracted.remove("companyAssessment")
    }
    val items = extracted.optJSONArray("webCompositions") ?: JSONArray()
    val compositions = (0 until items.length()).map { items.getJSONObject(it) }
    val source = JSONObject().put("url", url).put("text", text).put("sourceType", "retailer").put("complete", true)
        .put("productName", identity.getString("name")).put("brand", identity.getString("brand"))
    val assessments = extracted.optJSONArray("ingredientAssessments") ?: JSONArray()
    val assessedTerms = JSONArray((0 until assessments.length()).map { assessments.getJSONObject(it).getString("term") }
        .filter { parseSourceIngredients(text, JSONArray().put(it)) != null }.distinct())
    val parsed = compositions.filter { it.optString("url") == url }.mapNotNull { it.optJSONArray("ingredients") }
        .firstOrNull { coversCatalogueComposition(text, it) }
        ?: assessedTerms.takeIf { coversCatalogueComposition(text, it) }
    parsed?.let { source.put("ingredients", it) }
    extracted.put("name", identity.getString("name")).put("brand", identity.getString("brand"))
        .put("webCompositions", JSONArray(listOf(source) + compositions.filter { it.getString("url") != url }.take(2)))
    val research = extracted.optJSONObject("research") ?: JSONObject()
    val sources = research.optJSONArray("sources") ?: JSONArray()
    sources.put(JSONObject().put("url", url).put("title", catalogue.getString("productName") + " — Matspar"))
    extracted.put("research", research.put("searched", true).put("sources", boundedResearchSources(
        (0 until sources.length()).map { sources.getJSONObject(it) }, listOf(extracted))))
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
        val parsed = parseSourceIngredients(sourceInput.text, item.optJSONArray("ingredients"))
        val composition = evaluator.evaluate(sourceInput, item.optJSONArray("ingredients")?.let { values ->
            (0 until values.length()).map { values.getString(it) }
        }).put("usedAI", true)
        val id = "web-composition-$index"
        val de = input.locale == "de"
        composition.put("evidence", JSONArray().put(JSONObject().put("id", id).put("kind", "ai_extraction")
            .put("title", if (item.getString("sourceType") == "manufacturer") { ResultStrings.manufacturerCompositionAi(de) }
                else { ResultStrings.retailerCompositionAi(de) })
            .put("excerpt", item.getString("text")).put("url", url).put("verification", "unverified")
            .put("retrievedAt", composition.getString("checkedAt"))))
        val findings = composition.getJSONArray("findings")
        for (i in 0 until findings.length()) findings.getJSONObject(i).put("evidenceId", id)
        composition.getJSONArray("warnings").put(ResultStrings.webIngredientsCaution(de))
        val sourceExtraction = JSONObject(extracted.toString()).apply {
            remove("ingredients")
            item.optJSONArray("ingredients")?.let { put("ingredients", it) }
        }
        result = mergeResults(if (parsed != null) withoutCompositionFindings(result, sourceInput.text) else result,
            applyAIEvidence(composition, sourceInput, sourceExtraction, item.getBoolean("complete"), false, "$id-assessment"))
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
                .put("title", ResultStrings.consultedDuringWebResearch(input.locale == "de"))
                .put("excerpt", ResultStrings.webClaimMissing(input.locale == "de"))
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
                ResultStrings.webConflictSummary(de)
            } else if (claim == "vegan") {
                ResultStrings.webVeganSummary(de)
            } else {
                ResultStrings.webNotVeganSummary(de)
            })
        if (!conflict) result.put("questions", JSONArray())
        result.getJSONArray("evidence").put(JSONObject().put("id", "web-claim-$index").put("kind", if (certification) "certification" else "manufacturer")
            .put("title", ResultStrings.productSourceInterpretedByAi(de))
            .put("excerpt", item.getString("quote")).put("url", url).put("claim", claim).put("verification", "unverified")
            .put("retrievedAt", result.getString("checkedAt")))
        result.getJSONArray("warnings").put(ResultStrings.webClaimCaution(de))
    }
    return if (accepted) result else consultedOnly()
}
