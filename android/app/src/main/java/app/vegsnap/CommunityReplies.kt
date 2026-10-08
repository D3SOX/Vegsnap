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
        return listOf("market" to country) + if (code.isNotEmpty()) {
            require(validGtin(code))
            listOf("barcode" to code.padStart(14, '0'))
        } else {
            require(name.trim().length in 1..300 && brand.trim().length in 1..300)
            listOf("name" to name.trim(), "brand" to brand.trim())
        }
    }
}
internal data class CommunityReply(
    val id: String, val productName: String, val brand: String, val market: String, val variant: String,
    val question: String, val reply: String, val repliedOn: String, val claim: String, val scope: String,
    val reviewedAt: String, val sourceUrl: String?, val evidencePublic: Boolean,
)
internal data class CommunityReplyPage(val replies: List<CommunityReply>, val more: Boolean)

internal fun parseCommunityReplies(body: String): CommunityReplyPage {
    val value = JSONObject(body)
    val records = value.getJSONArray("replies")
    require(records.length() <= 50)
    val replies = (0 until records.length()).map { index ->
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
        CommunityReply(id, text("productName", 300), text("brand", 300), market, text("variant", 300, false),
            text("question", 4000), text("reply", 8000), date, claim, scope, reviewed,
            publicEvidenceUrl(text("sourceUrl", 2000, false)), item.getBoolean("evidencePublic"))
    }
    require(value.get("more") is Boolean)
    return CommunityReplyPage(replies, value.getBoolean("more"))
}
