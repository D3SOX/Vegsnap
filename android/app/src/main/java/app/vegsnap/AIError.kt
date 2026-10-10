package app.vegsnap

import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException
import org.json.JSONException
import org.json.JSONObject

/** Only these fixed codes/messages may reach saved results; never a provider's raw response. */
internal enum class AIErrorCode(val code: String, val english: String, val german: String) {
    AUTHENTICATION("authentication", ResultStrings.aiAuthenticationError(false), ResultStrings.aiAuthenticationError(true)),
    ACCESS("access_denied", ResultStrings.aiAccessError(false), ResultStrings.aiAccessError(true)),
    QUOTA("quota", ResultStrings.aiQuotaError(false), ResultStrings.aiQuotaError(true)),
    RATE_LIMIT("rate_limit", ResultStrings.aiRateLimitError(false), ResultStrings.aiRateLimitError(true)),
    TIMEOUT("timeout", ResultStrings.aiTimeoutError(false), ResultStrings.aiTimeoutError(true)),
    NETWORK("network", ResultStrings.aiNetworkError(false), ResultStrings.aiNetworkError(true)),
    MODEL("unsupported_model", ResultStrings.aiModelError(false), ResultStrings.aiModelError(true)),
    INVALID_RESPONSE("invalid_response", ResultStrings.aiResponseError(false), ResultStrings.aiResponseError(true)),
    INCOMPLETE("incomplete_response", ResultStrings.aiIncompleteError(false), ResultStrings.aiIncompleteError(true)),
    REJECTED("request_rejected", ResultStrings.aiRequestError(false), ResultStrings.aiRequestError(true)),
    SERVICE("service", ResultStrings.aiServiceError(false), ResultStrings.aiServiceError(true)),
    UNKNOWN("unknown", ResultStrings.aiUnknownError(false), ResultStrings.aiUnknownError(true));

    fun message(locale: String, hosted: Boolean = false): String = when {
        hosted && this == QUOTA -> ResultStrings.hostedQuotaError(locale == "de")
        hosted && this == RATE_LIMIT -> ResultStrings.hostedRateLimitError(locale == "de")
        else -> if (locale == "de") german else english
    }
    fun json(locale: String, hosted: Boolean = false): JSONObject =
        JSONObject().put("code", code).put("message", message(locale, hosted)).apply { if (hosted) put("hosted", true) }
}

internal class AIProviderFailure(val reason: AIErrorCode) : IOException(reason.code)

internal fun aiFailure(error: Exception, locale: String, hosted: Boolean = false): JSONObject = when (error) {
    is AIProviderFailure -> error.reason
    is InterruptedIOException -> AIErrorCode.TIMEOUT
    is JSONException, is IllegalArgumentException -> AIErrorCode.INVALID_RESPONSE
    is IOException -> AIErrorCode.NETWORK
    else -> AIErrorCode.UNKNOWN
}.json(locale, hosted)

/** Read a bounded error envelope, retain no body, and only recognize known provider error codes. */
internal fun providerHttpFailure(status: Int, stream: InputStream?): AIProviderFailure {
    val envelope = try {
        val buffer = ByteArray(65_537)
        var size = 0
        if (stream != null) while (size < buffer.size) {
            val count = stream.read(buffer, size, buffer.size - size)
            if (count < 0) break
            size += count
        }
        if (size > 65_536) null else JSONObject(String(buffer, 0, size, Charsets.UTF_8))
    } catch (_: Exception) { null }
    return AIProviderFailure(providerErrorCode(envelope) ?: when (status) {
        401 -> AIErrorCode.AUTHENTICATION
        403 -> AIErrorCode.ACCESS
        408, 504 -> AIErrorCode.TIMEOUT
        429 -> AIErrorCode.RATE_LIMIT
        in 500..599 -> AIErrorCode.SERVICE
        else -> AIErrorCode.REJECTED
    })
}

internal fun providerErrorCode(envelope: JSONObject?): AIErrorCode? {
    val error = envelope?.optJSONObject("error") ?: envelope ?: return null
    val codes = listOf(error.optString("code"), error.optString("type"), envelope?.optString("error").orEmpty()).map { it.lowercase(java.util.Locale.ROOT) }
    return when {
        codes.any { it in setOf("invalid_api_key", "invalid_token", "expired_token", "invalid_grant", "token_expired", "authentication_error") } -> AIErrorCode.AUTHENTICATION
        codes.any { it in setOf("insufficient_quota", "usage_limit_reached", "quota_exceeded", "credit_balance_too_low", "plan_limit_exceeded", "subscription_sharing_usage_limit_exceeded") } -> AIErrorCode.QUOTA
        codes.any { it in setOf("rate_limit_exceeded", "rate_limit_error") } -> AIErrorCode.RATE_LIMIT
        codes.any { it in setOf("model_not_found", "model_not_supported", "unsupported_model", "unsupported_image", "unsupported_content_type", "unsupported_capability", "subscription_sharing_unsupported_capability") } -> AIErrorCode.MODEL
        codes.any { it in setOf("permission_denied", "permission_error", "access_denied", "user_not_eligible", "subscription_sharing_user_not_eligible") } -> AIErrorCode.ACCESS
        codes.any { it in setOf("server_error", "internal_server_error", "overloaded_error", "subscription_sharing_usage_unavailable") } -> AIErrorCode.SERVICE
        codes.any { it in setOf("timeout", "request_timeout") } -> AIErrorCode.TIMEOUT
        else -> null
    }
}

/** Metadata only: never log the error message, response content, URL, or request data. */
internal fun streamFailureDiagnostic(event: JSONObject, type: String): String {
    fun tag(value: String, eventType: Boolean = false): String = value.takeIf { it.matches(Regex(if (eventType) "[a-z_.]{1,80}" else "[a-z_]{1,80}")) } ?: "unrecognized"
    val response = event.optJSONObject("response") ?: event
    val error = response.optJSONObject("error") ?: response
    return "stream terminal=${tag(type, true)} status=${tag(response.optString("status"))} code=${tag(error.optString("code"))} error_type=${tag(error.optString("type"))} reason=${tag(response.optJSONObject("incomplete_details")?.optString("reason").orEmpty())}"
}

internal fun providerStreamFailure(event: JSONObject, type: String = event.optString("type")): AIProviderFailure {
    val response = event.optJSONObject("response") ?: event
    val fallback = if (type == "response.incomplete" || response.optString("status") == "incomplete") AIErrorCode.INCOMPLETE else AIErrorCode.UNKNOWN
    return AIProviderFailure(providerErrorCode(response) ?: fallback)
}
