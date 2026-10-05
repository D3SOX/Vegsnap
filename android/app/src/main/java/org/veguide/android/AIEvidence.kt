package org.veguide.android

import org.json.JSONArray
import org.json.JSONObject

/** Bound and validate optional AI evidence before it can affect a stored result. */
internal fun validateAIEvidence(extracted: JSONObject) {
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
    fun register(term: String, item: JSONObject) {
        val previous = assessments[term]
        assessments[term] = if (previous != null && previous.getString("status") != item.getString("status")) {
            JSONObject().put("status", "ambiguous").put("explanation", if (de) "Die KI macht widersprüchliche Angaben zur Herkunft." else "The AI gave conflicting ingredient origins.")
        } else item
    }
    val composition = normalizeCompositionTerm(input.text)
    for (index in 0 until supplied.length()) {
        val item = supplied.getJSONObject(index)
        val term = normalizeCompositionTerm(item.getString("term"))
        register(term, item)
        // A parent assessment applies only to a compound actually present in this source.
        // Known local animal/ambiguous children still cannot be overwritten below.
        if (term.isNotEmpty() && composition.contains(term)) {
            val terms = compositionTerms(item.getString("term"), input.category in setOf("shoes", "clothing"))
            if (item.getString("status") == "plant") terms.forEach { register(it, item) }
            else if (terms.size == 1 || term.any { it == '(' || it == '[' || it == '{' }) terms.firstOrNull()?.let { register(it, item) }
        }
    }
    val findings = result.getJSONArray("findings")
    val assessed = mutableListOf<JSONObject>()
    for (index in 0 until findings.length()) {
        val finding = findings.getJSONObject(index)
        val assessment = assessments[normalizeCompositionTerm(finding.getString("term"))] ?: continue
        val translated = assessment.opt("translatedTerm") as? String
        if (!translated.isNullOrBlank() && translated.length <= 300 && normalizeCompositionTerm(assessment.optString("term")) == normalizeCompositionTerm(finding.getString("term"))) {
            finding.put("displayTerm", translated).put("displayLocale", if (de) "de" else "en")
        }
        if (finding.getString("status") != "unknown") continue
        finding.put("status", assessment.getString("status")).put("evidenceId", assessmentEvidenceId)
            .put("explanation", (if (de) "KI-Einschätzung: " else "AI assessment: ") + assessment.getString("explanation"))
        assessed += finding
    }
    val values = (0 until findings.length()).map { findings.getJSONObject(it) }
    val animal = values.any { it.getString("status") == "animal" }
    if (assessed.isNotEmpty()) {
        result.getJSONArray("evidence").put(JSONObject().put("id", assessmentEvidenceId).put("kind", "ai_extraction")
            .put("title", if (de) "KI-Einschätzung der Zutaten" else "AI ingredient assessment")
            .put("excerpt", assessed.joinToString("\n") { "${it.getString("term")}: ${it.getString("explanation")}" })
            .put("retrievedAt", result.getString("checkedAt")).put("verification", "unverified"))
        result.getJSONArray("warnings").put(if (de) "KI-Einschätzungen zur Herkunft sind keine Herstellerbestätigung." else "AI ingredient assessments are not manufacturer confirmation.")
        if (animal && result.getString("outcome") != "conflicting") result.put("outcome", if (result.getString("outcome") == "vegan") "conflicting" else "not_vegan").put("basis", "composition").put("questions", JSONArray())
            .put("summary", if (de) "Die Zutatenbewertung weist auf tierische Bestandteile hin. Die KI-Einschätzung ist gekennzeichnet." else "The ingredient assessment identifies animal-derived content. AI assessments are marked.")
        else if (result.getString("outcome") == "uncertain" && complete && values.isNotEmpty() && values.all { it.getString("status") == "plant" } && input.category in setOf("food", "drink", "cosmetics", "household") && !needsProcessingEvidence(input)) {
            result.put("outcome", "vegan").put("basis", "composition").put("questions", JSONArray())
                .put("summary", if (de) "In der vollständigen Zutatenliste wurden mit KI-Unterstützung keine tierischen Bestandteile erkannt." else "No animal-derived ingredients were identified in the complete list, with AI assistance.")
        }
    }
    if (result.getString("outcome") == "uncertain" && complete) {
        val unresolved = values.filter { it.getString("status") in setOf("unknown", "ambiguous") }.map { it.getString("term") }
        if (unresolved.isNotEmpty()) result.put("questions", JSONArray().put((if (de) "Die Herkunft dieser Zutaten klären: " else "Confirm the origin of: ") + unresolved.joinToString(", ") + "."))
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
            if (de) "Das sichtbare Vegan-Label widerspricht der Zutatenbewertung. Produktvariante und Belege prüfen." else "The visible vegan label conflicts with the ingredient assessment. Check the product variant and evidence."
        } else {
            if (de) "Die KI erkennt eine vegane Kennzeichnung auf dem bereitgestellten Produktfoto. Die Kennzeichnung am Original prüfen." else "The AI identified a vegan label on the supplied product photo. Verify the label against the original."
        })
    if (!conflict) result.put("questions", JSONArray())
    observations.forEachIndexed { index, item ->
        result.getJSONArray("evidence").put(JSONObject().put("id", "ai-label-$index").put("kind", "ai_extraction")
            .put("title", (if (de) "Sichtbare Kennzeichnung (KI): " else "Visible packaging label (AI): ") + item.getString("name"))
            .put("excerpt", item.getString("text")).put("retrievedAt", result.getString("checkedAt"))
            .put("claim", "vegan").put("verification", "unverified"))
    }
    result.getJSONArray("warnings").put(if (de) "Kennzeichnung von KI abgelesen; Echtheit und Zertifizierungsregister wurden nicht geprüft." else "Label read by AI; authenticity and certification registry were not checked.")
    return result
}
