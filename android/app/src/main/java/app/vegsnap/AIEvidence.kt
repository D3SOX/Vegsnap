package app.vegsnap

import org.json.JSONArray
import org.json.JSONObject

internal fun validateIngredients(source: JSONObject) {
    if (!source.has("ingredients")) return
    val items = source.getJSONArray("ingredients")
    require(items.length() <= 100)
    for (index in 0 until items.length()) {
        val term = items.get(index)
        require(term is String && term.isNotBlank() && term.length <= 300)
    }
}

private fun canonicalIngredientSource(text: String): String = java.text.Normalizer.normalize(text, java.text.Normalizer.Form.NFKC)
    .lowercase(java.util.Locale.ROOT).replace(Regex("\\s+"), " ").trim()

/** Preserve chemical punctuation; every model-split term must occur in intentional source composition. */
internal fun parseSourceIngredients(text: String, items: JSONArray?): List<String>? {
    if (items == null || items.length() !in 1..100) return null
    val source = canonicalIngredientSource(text)
    val precaution = compositionPrecaution.find(source)
    val intentional = if (precaution == null) source else source.take(precaution.range.first)
    val terms = mutableListOf<String>()
    val word = Regex("[\\p{L}\\p{N}]")
    for (index in 0 until items.length()) {
        val value = items.opt(index) as? String ?: return null
        if (value.isBlank() || value.length > 300) return null
        val term = canonicalIngredientSource(value)
        var start = intentional.indexOf(term)
        var found = false
        while (start >= 0) {
            val before = intentional.getOrNull(start - 1)?.toString().orEmpty()
            val after = intentional.getOrNull(start + term.length)?.toString().orEmpty()
            if (!word.containsMatchIn(before) && !word.containsMatchIn(after)) { found = true; break }
            start = intentional.indexOf(term, start + 1)
        }
        if (!found) return null
        terms += normalizeCompositionTerm(term)
    }
    return terms.distinct()
}

/** Replace the old split only for this exact source, keeping all other source findings. */
internal fun withoutCompositionFindings(result: JSONObject, text: String): JSONObject {
    val key = canonicalIngredientSource(text)
    if (key.isBlank()) return result
    val evidence = result.getJSONArray("evidence")
    val ids = (0 until evidence.length()).map { evidence.getJSONObject(it) }
        .filter { it.optString("id") in setOf("input", "ai-extraction", "photo-ocr") && canonicalIngredientSource(it.optString("excerpt")) == key }
        .map { it.getString("id") }.toSet()
    val findings = result.getJSONArray("findings")
    return JSONObject(result.toString()).put("findings", JSONArray((0 until findings.length())
        .map { findings.getJSONObject(it) }.filterNot { it.optString("evidenceId") in ids }))
}

/** A research follow-up can enrich the split of the same source without duplicating its recipe. */
internal fun mergeSourceCompositions(items: List<JSONObject>): List<JSONObject> {
    val sources = linkedMapOf<String, JSONObject>()
    for (item in items) {
        val key = JSONArray(listOf(item.optString("url"), canonicalIngredientSource(item.optString("text")), item.optBoolean("complete"),
            item.optString("sourceType"), canonicalIngredientSource(item.optString("productName")), canonicalIngredientSource(item.optString("brand")))).toString()
        val previous = sources[key]
        val next = JSONObject(item.toString())
        if (parseSourceIngredients(item.optString("text"), item.optJSONArray("ingredients")) == null) {
            previous?.optJSONArray("ingredients")?.let { next.put("ingredients", it) }
        }
        sources[key] = next
    }
    return sources.values.toList()
}

/** Bound and validate optional AI evidence before it can affect a stored result. */
internal fun validateAIEvidence(extracted: JSONObject) {
    validateIngredients(extracted)
    if (extracted.has("packaging")) {
        val packaging = extracted.getJSONObject("packaging")
        require(packaging.length() in 1..4)
        for (key in packaging.keys()) {
            val clue = packaging.get(key)
            require(key in setOf("language", "country", "variant", "quantity") && clue is String && clue.isNotBlank() && clue.length <= 300)
        }
    }
    for (field in listOf("name", "brand")) if (extracted.has(field)) require(extracted.getString(field).length <= 300)
    if (extracted.has("ingredientAssessments")) {
        val items = extracted.getJSONArray("ingredientAssessments")
        require(items.length() <= 100)
        for (index in 0 until items.length()) {
            val item = items.getJSONObject(index)
            require(item.get("term") is String && item.getString("term").length in 1..300)
            if (item.has("translatedTerm")) require(item.get("translatedTerm") is String && item.getString("translatedTerm").isNotBlank() && item.getString("translatedTerm").length <= 300)
            require(item.get("explanation") is String && item.getString("explanation").length in 1..1000)
            require(item.optString("status") in setOf("plant", "animal", "ambiguous", "unknown"))
        }
    }
    if (extracted.has("labelObservations")) {
        val items = extracted.getJSONArray("labelObservations")
        require(items.length() <= 5)
        for (index in 0 until items.length()) {
            val item = items.getJSONObject(index)
            require(item.optString("kind") in setOf("vegan_certification", "vegan_claim"))
            require(item.get("name") is String && item.getString("name").length in 1..100)
            require(item.get("text") is String && item.getString("text").length in 1..300)
        }
    }
}

private val veganLabels = setOf("v-label", "v label", "v-label vegan", "v label vegan", "vegan society", "the vegan society", "vegan society trademark", "vegan trademark", "vegan flower", "veganblume", "veganblomman", "certified vegan", "vegan action")

/** The model may resolve unknown terms, but cannot overwrite known local ingredient evidence. */
internal fun applyAIEvidence(result: JSONObject, input: CheckInput, extracted: JSONObject, complete: Boolean, imagesSent: Boolean, assessmentEvidenceId: String = "ai-assessment"): JSONObject {
    val de = input.locale == "de"
    val assessments = linkedMapOf<String, JSONObject>()
    val supplied = extracted.optJSONArray("ingredientAssessments") ?: JSONArray()
    val parsedTerms = parseSourceIngredients(input.text, extracted.optJSONArray("ingredients"))
    val structured = parsedTerms != null
    val evidence = result.getJSONArray("evidence")
    val sourceIds = (0 until evidence.length()).map { evidence.getJSONObject(it) }.filter { item ->
        val id = item.optString("id")
        (id in setOf("input", "ai-extraction", "photo-ocr") || id == assessmentEvidenceId.removeSuffix("-assessment")) &&
            canonicalIngredientSource(item.optString("excerpt")) == canonicalIngredientSource(input.text)
    }.map { it.getString("id") }.toSet()
    fun register(term: String, item: JSONObject) {
        val previous = assessments[term]
        assessments[term] = if (previous != null && previous.getString("status") != item.getString("status")) {
            JSONObject().put("status", "ambiguous").put("explanation", ResultStrings.aiOriginConflict(de))
        } else item
    }
    val composition = normalizeCompositionTerm(input.text)
    for (index in 0 until supplied.length()) {
        val item = supplied.getJSONObject(index)
        val term = normalizeCompositionTerm(item.getString("term"))
        register(term, item)
        // A parent assessment applies only to a compound actually present in this source.
        // Known local animal/ambiguous children still cannot be overwritten below.
        if (!structured && term.isNotEmpty() && composition.contains(term)) {
            val terms = compositionTerms(item.getString("term"), input.category in setOf("shoes", "clothing"))
            if (item.getString("status") == "plant") terms.forEach { register(it, item) }
            else if (terms.size == 1 || term.any { it == '(' || it == '[' || it == '{' }) terms.firstOrNull()?.let { register(it, item) }
        }
    }
    val findings = result.getJSONArray("findings")
    val assessed = mutableListOf<JSONObject>()
    for (index in 0 until findings.length()) {
        val finding = findings.getJSONObject(index)
        val term = normalizeCompositionTerm(finding.getString("term"))
        val assessment = assessments[term]
        if (assessment == null) {
            if (term in parsedTerms.orEmpty() && finding.getString("status") == "unknown" && finding.optString("evidenceId") in sourceIds) finding.put("explanation",
                ResultStrings.aiUnknownOrigin(de))
            continue
        }
        val translated = assessment.opt("translatedTerm") as? String
        if (!translated.isNullOrBlank() && translated.length <= 300 && normalizeCompositionTerm(assessment.optString("term")) == normalizeCompositionTerm(finding.getString("term"))) {
            finding.put("displayTerm", translated).put("displayLocale", if (de) "de" else "en")
        }
        if (finding.getString("status") != "unknown") continue
        finding.put("status", assessment.getString("status")).put("evidenceId", assessmentEvidenceId)
            .put("explanation", (ResultStrings.aiAssessmentPrefix(de)) + assessment.getString("explanation"))
        assessed += finding
    }
    val values = (0 until findings.length()).map { findings.getJSONObject(it) }
    val animal = values.any { it.getString("status") == "animal" }
    if (assessed.isNotEmpty()) {
        result.getJSONArray("evidence").put(JSONObject().put("id", assessmentEvidenceId).put("kind", "ai_extraction")
            .put("title", ResultStrings.aiIngredientAssessment(de))
            .put("excerpt", assessed.joinToString("\n") { "${it.getString("term")}: ${it.getString("explanation")}" })
            .put("retrievedAt", result.getString("checkedAt")).put("verification", "unverified"))
        result.getJSONArray("warnings").put(ResultStrings.aiIngredientCaution(de))
        if (animal && result.getString("outcome") != "conflicting") result.put("outcome", if (result.getString("outcome") == "vegan") "conflicting" else "not_vegan").put("basis", "composition").put("questions", JSONArray())
            .put("summary", ResultStrings.aiAnimalCompositionSummary(de))
        else if (result.getString("outcome") == "uncertain" && complete && values.isNotEmpty() && values.all { it.getString("status") == "plant" } && input.category in setOf("food", "drink", "cosmetics", "household") && !needsProcessingEvidence(input)) {
            result.put("outcome", "vegan").put("basis", "composition").put("questions", JSONArray())
                .put("summary", ResultStrings.aiVeganCompositionSummary(de))
        }
    }
    if (result.getString("outcome") == "uncertain" && complete) {
        val unresolved = values.filter { it.getString("status") in setOf("unknown", "ambiguous") }.map { it.getString("term") }
        if (unresolved.isNotEmpty()) result.put("questions", JSONArray().put((ResultStrings.originQuestionPrefix(de)) + unresolved.joinToString(", ") + "."))
    }
    if (!imagesSent) return result
    val labels = extracted.optJSONArray("labelObservations") ?: JSONArray()
    val observations = (0 until labels.length()).map { labels.getJSONObject(it) }.filter {
        val text = it.getString("text")
        Regex("\\bvegan\\b", RegexOption.IGNORE_CASE).containsMatchIn(text) &&
            !Regex("\\b(?:vegetarian|vegetarisch|vegetarisk)\\b|\\b(?:not|non|nicht|kein|keine|inte|ej)\\s*[-:]?\\s*vegan\\b", RegexOption.IGNORE_CASE).containsMatchIn(text) &&
            (it.getString("kind") == "vegan_claim" || normalizeCompositionTerm(it.getString("name")) in veganLabels)
    }
    if (observations.isEmpty()) return result
    val conflict = animal || result.getString("outcome") in setOf("not_vegan", "conflicting")
    result.put("outcome", if (conflict) "conflicting" else "vegan").put("basis", if (conflict) "insufficient" else "packaging")
        .put("summary", if (conflict) {
            ResultStrings.aiLabelConflictSummary(de)
        } else {
            ResultStrings.aiLabelSummary(de)
        })
    if (!conflict) result.put("questions", JSONArray())
    observations.forEachIndexed { index, item ->
        result.getJSONArray("evidence").put(JSONObject().put("id", "ai-label-$index").put("kind", "ai_extraction")
            .put("title", (ResultStrings.aiLabelTitlePrefix(de)) + item.getString("name"))
            .put("excerpt", item.getString("text")).put("retrievedAt", result.getString("checkedAt"))
            .put("claim", "vegan").put("verification", "unverified"))
    }
    result.getJSONArray("warnings").put(ResultStrings.aiLabelCaution(de))
    return result
}
