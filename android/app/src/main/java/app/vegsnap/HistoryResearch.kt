package app.vegsnap

import org.json.JSONObject

/** A missing optional AI field does not retract previously sourced evidence for the same product. */
internal fun retainPreviousResearch(result: JSONObject, previous: JSONObject) {
    val identity = result.optJSONObject("identity") ?: return
    val oldIdentity = previous.optJSONObject("identity") ?: return
    if (listOf("name", "brand", "market").any { identity.optString(it).isBlank() }) return
    if (listOf("name", "brand", "market").any {
        normalizeProductIdentity(identity.optString(it)) != normalizeProductIdentity(oldIdentity.optString(it))
    }) return
    fun barcodeKey(value: String): String? {
        if (value.isBlank()) return ""
        val code = value.replace(Regex("[\\s-]"), "")
        return code.takeIf(::validGtin)?.padStart(14, '0')
    }
    val barcode = barcodeKey(identity.optString("barcode")) ?: return
    if (barcode != barcodeKey(oldIdentity.optString("barcode"))) return
    val brand = normalizeProductIdentity(identity.getString("brand"))
    if (!result.has("companyAssessment")) {
        safeCompanyAssessment(previous.optJSONObject("companyAssessment"), saved = true)?.takeIf {
            normalizeProductIdentity(it.getString("brand")) == brand
        }?.let { result.put("companyAssessment", it) }
    }
    if (!result.has("manufacturerContact") && result.optString("outcome") in setOf("uncertain", "conflicting")) {
        safeManufacturerContact(previous.optJSONObject("manufacturerContact"))?.takeIf {
            normalizeProductIdentity(it.getString("brand")) == brand &&
                normalizeProductIdentity(it.getString("productName")) == normalizeProductIdentity(identity.getString("name"))
        }?.let { result.put("manufacturerContact", it) }
    }
}
