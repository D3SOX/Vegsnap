package app.vegsnap

import java.net.URI
import java.net.URLEncoder
import org.json.JSONObject

internal data class CommunityLinks(val submit: String, val replies: String)
internal fun communityLinks(result: JSONObject, language: String, baseUrl: String): CommunityLinks? {
    val safe = publicEvidenceUrl(baseUrl) ?: return null
    val uri = URI(safe)
    if (uri.scheme != "https" || uri.userInfo != null) return null
    val origin = URI(uri.scheme, null, uri.host, uri.port, null, null, null).toString()
    val identity = result.optJSONObject("identity") ?: JSONObject()
    fun encode(value: String) = URLEncoder.encode(value, "UTF-8")
    val fields = listOf("name" to 300, "brand" to 300, "barcode" to 40, "market" to 2).mapNotNull { (field, limit) ->
        (identity.opt(field) as? String)?.takeIf { it.isNotBlank() }?.let { "$field=${encode(it.take(limit))}" }
    } + "lang=${encode(language.takeIf { it in setOf("en", "de", "sv") } ?: "en") }"
    val fragment = fields.joinToString("&")
    return CommunityLinks("$origin/submit#$fragment", "$origin/replies#$fragment")
}

internal data class CommunityLookup(val name: String, val brand: String, val barcode: String, val market: String) {
    fun parameters(): List<Pair<String, String>> {
        val country = market.trim().uppercase(java.util.Locale.ROOT)
        require(country.matches(Regex("[A-Z]{2}")))
        val code = barcode.replace(Regex("[\\s-]"), "")
        require(name.length <= 300 && brand.length <= 300)
        if (code.isNotEmpty()) require(validGtin(code))
        else require(name.trim().isNotEmpty() && brand.trim().isNotEmpty())
        return listOf("market" to country) +
            (if (code.isNotEmpty()) listOf("barcode" to code.padStart(14, '0')) else emptyList()) +
            (if (name.isNotBlank()) listOf("name" to name.trim()) else emptyList()) +
            (if (brand.isNotBlank()) listOf("brand" to brand.trim()) else emptyList())
    }
}
internal data class CommunityReply(
    val id: String, val productName: String, val brand: String, val market: String, val variant: String,
    val question: String, val reply: String, val repliedOn: String, val claim: String, val scope: String,
    val reviewedAt: String, val sourceUrl: String?, val evidencePublic: Boolean,
    val match: String = "", val coverage: JSONObject? = null,
)
internal data class CommunityReplyPage(val replies: List<CommunityReply>, val more: Boolean, val candidates: List<CommunityReply> = emptyList())

internal fun parseCommunityReplies(body: String): CommunityReplyPage {
    val value = JSONObject(body)
    fun parse(records: org.json.JSONArray, candidate: Boolean): List<CommunityReply> {
      require(records.length() <= 50)
      return (0 until records.length()).map { index ->
        val item = records.getJSONObject(index)
        fun text(field: String, limit: Int, required: Boolean = true): String = item.getString(field).also {
            require(it.length <= limit && (!required || it.isNotBlank()))
        }
        val id = text("id", 36).also { require(it.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"))) }
        val claim = text("claim", 20).also { require(it in setOf("vegan", "not_vegan", "inconclusive")) }
        val scope = text("scope", 20).also { require(it in setOf("whole_product", "ingredients", "processing")) }
        val date = text("repliedOn", 10).also { require(java.time.LocalDate.parse(it).toString() == it) }
        val reviewed = text("reviewedAt", 40).also { java.time.Instant.parse(it) }
        val market = text("market", 2).also { require(it.matches(Regex("[A-Z]{2}"))) }
        require(item.get("evidencePublic") is Boolean)
        val match = item.optString("match")
        require(match in setOf("", "barcode", "name", "brand", "candidate") && (candidate || match != "candidate"))
        val coverage = item.optJSONObject("coverage")
        if (coverage != null) {
            require(coverage.getString("type") in setOf("products", "range"))
            require(coverage.getJSONArray("markets").length() in 1..10)
            for (index in 0 until coverage.getJSONArray("markets").length())
                require(coverage.getJSONArray("markets").getString(index).matches(Regex("[A-Z]{2}")))
            require(coverage.getJSONArray("products").length() <= 25)
            if (coverage.getString("type") == "range") require(coverage.getJSONObject("range").getString("name").length in 1..300)
        }
        CommunityReply(id, text("productName", 300), text("brand", 300), market, text("variant", 300, false),
            text("question", 4000), text("reply", 8000), date, claim, scope, reviewed,
            publicEvidenceUrl(text("sourceUrl", 2000, false)), item.getBoolean("evidencePublic"), if (candidate) "candidate" else match, coverage)
    }
    }
    require(value.get("more") is Boolean)
    return CommunityReplyPage(parse(value.getJSONArray("replies"), false), value.getBoolean("more"),
        value.optJSONArray("candidates")?.let { parse(it, true) } ?: emptyList())
}
