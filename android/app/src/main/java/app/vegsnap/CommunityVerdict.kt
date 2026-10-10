package app.vegsnap

import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject

private val communityVerdictFields = listOf("outcome", "basis", "title", "summary", "questions", "evidence", "warnings")

/** Keep the original analysis so refreshed or blocked replies can replace cached evidence. */
internal fun withoutCommunityReplies(source: JSONObject): JSONObject {
    val original = source.optJSONObject("communityOriginal") ?: return source
    return JSONObject(source.toString()).apply {
        remove("communityOriginal")
        for (field in communityVerdictFields) {
            remove(field)
            if (original.has(field)) put(field, original.get(field))
        }
    }
}

/** Globally blocking a reply invalidates its cache on every scan, even without a fresh lookup. */
internal fun cachedCommunityResult(source: JSONObject, hidden: Set<String>): JSONObject {
    if (!source.has("communityOriginal")) return source
    val evidence = source.optJSONArray("evidence") ?: return source
    val blocked = (0 until evidence.length()).any { index ->
        val id = evidence.getJSONObject(index).optString("id")
        id.startsWith("community-") && id.removePrefix("community-") in hidden
    }
    return if (blocked) withoutCommunityReplies(source) else source
}

/** Current community evidence can be saved locally without replacing the original analysis. */
internal fun applyCommunityReplies(source: JSONObject, replies: List<CommunityReply>, locale: String, baseUrl: String,
    now: Instant = Instant.now()): JSONObject {
    val original = withoutCommunityReplies(source)
    val eligible = replies.filter { it.scope == "whole_product" && it.claim in setOf("vegan", "not_vegan") && it.match != "candidate" }
    if (eligible.isEmpty()) return original
    val result = JSONObject(original.toString())
    result.put("communityOriginal", JSONObject().apply {
        for (field in communityVerdictFields) if (original.has(field)) put(field, original.get(field))
    })
    val positive = eligible.any { it.claim == "vegan" }
    val negative = eligible.any { it.claim == "not_vegan" }
    val findings = result.optJSONArray("findings") ?: JSONArray()
    val animal = (0 until findings.length()).any { findings.getJSONObject(it).optString("status") == "animal" }
    val conflict = result.optString("outcome") == "conflicting" || positive && (negative || result.optString("outcome") == "not_vegan" || animal) || negative && result.optString("outcome") == "vegan"
    val de = locale == "de"
    result.put("outcome", if (conflict) "conflicting" else if (positive) "vegan" else "not_vegan")
        .put("basis", if (conflict) "insufficient" else "manufacturer")
        .put("title", if (conflict) { if (de) "Widersprüchliche Belege" else "Conflicting evidence" }
            else if (positive) { if (de) "Hersteller bezeichnet es als vegan" else "Manufacturer says vegan" }
            else { if (de) "Hersteller bezeichnet es als nicht vegan" else "Manufacturer says not vegan" })
        .put("summary", if (conflict) {
            if (de) "Die geprüfte Herstellerantwort widerspricht anderen Belegen. Produktvariante, Datum und Originalantwort prüfen."
            else "The reviewed manufacturer reply conflicts with other evidence. Check the variant, date and original reply."
        } else {
            if (de) "Eine geprüfte Community-Einreichung enthält eine Herstellerbestätigung für dieses Produkt. Antwortdatum und Geltungsbereich prüfen."
            else "A reviewed community contribution contains manufacturer confirmation for this product. Check the response date and coverage."
        })
    if (!conflict) result.put("questions", JSONArray())
    val evidence = result.optJSONArray("evidence") ?: JSONArray().also { result.put("evidence", it) }
    val links = communityLinks(result, locale, baseUrl)
    for (reply in eligible) evidence.put(JSONObject().put("id", "community-${reply.id}").put("kind", "manufacturer")
        .put("title", "${if (de) "Geprüfte Herstellerantwort" else "Reviewed manufacturer reply"}: ${reply.brand}")
        .put("excerpt", reply.reply).put("retrievedAt", now.toString()).put("sourceDate", "${reply.repliedOn}T00:00:00Z")
        .put("claim", reply.claim).put("verification", "unverified").apply { if (links != null) put("url", links.replies) })
    val warnings = result.optJSONArray("warnings") ?: JSONArray().also { result.put("warnings", it) }
    warnings.put(if (de) "Von der Community eingereicht und moderiert; Absender nicht unabhängig authentifiziert. Rezepturen können sich ändern."
        else "Submitted by the community and reviewed by a moderator; the sender was not independently authenticated. Recipes can change.")
    return result
}
