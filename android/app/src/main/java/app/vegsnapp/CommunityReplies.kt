package app.vegsnapp

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
