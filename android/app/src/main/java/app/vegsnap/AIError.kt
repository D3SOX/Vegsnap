package app.vegsnap

import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException
import org.json.JSONException
import org.json.JSONObject

/** Only these fixed codes/messages may reach saved results; never a provider's raw response. */
internal enum class AIErrorCode(val code: String, val english: String, val german: String) {
    AUTHENTICATION("authentication", "Your AI connection has expired or was rejected. Reconnect ChatGPT or check your API key.", "Deine KI-Verbindung ist abgelaufen oder wurde abgelehnt. Verbinde ChatGPT erneut oder prüfe deinen API-Schlüssel."),
    ACCESS("access_denied", "Your account does not have access to this AI request or model. Check your plan or choose another model.", "Dein Konto hat keinen Zugriff auf diese KI-Anfrage oder dieses Modell. Prüfe deinen Tarif oder wähle ein anderes Modell."),
    QUOTA("quota", "An AI usage limit was reached. Check your provider's usage settings. For ChatGPT, open Settings → Usage.", "Ein KI-Nutzungslimit wurde erreicht. Prüfe die Nutzungseinstellungen deines Anbieters. Öffne bei ChatGPT Einstellungen → Nutzung."),
    RATE_LIMIT("rate_limit", "The AI provider is receiving too many requests. Wait a moment, then try again.", "Der KI-Anbieter erhält zu viele Anfragen. Warte kurz und versuche es erneut."),
    TIMEOUT("timeout", "The AI request timed out. Check your connection and try again.", "Die KI-Anfrage hat zu lange gedauert. Prüfe deine Verbindung und versuche es erneut."),
    NETWORK("network", "Vegsnap could not reach the AI provider. Check your internet connection and try again.", "Vegsnap konnte den KI-Anbieter nicht erreichen. Prüfe deine Internetverbindung und versuche es erneut."),
    MODEL("unsupported_model", "The selected model is unavailable or does not support this request. Choose another model.", "Das gewählte Modell ist nicht verfügbar oder unterstützt diese Anfrage nicht. Wähle ein anderes Modell."),
    INVALID_RESPONSE("invalid_response", "The AI response could not be safely evaluated. Your existing evidence was kept. Try again or choose another model.", "Die KI-Antwort konnte nicht zuverlässig ausgewertet werden. Bisherige Belege bleiben erhalten. Versuche es erneut oder wähle ein anderes Modell."),
    INCOMPLETE("incomplete_response", "The AI response ended before the analysis was complete. Your existing evidence was kept. Try again.", "Die KI-Antwort endete vor Abschluss der Analyse. Bisherige Belege bleiben erhalten. Versuche es erneut."),
    REJECTED("request_rejected", "The AI provider rejected this request. Check your provider and model settings.", "Der KI-Anbieter hat diese Anfrage abgelehnt. Prüfe deine Anbieter- und Modelleinstellungen."),
    SERVICE("service", "The AI provider is temporarily unavailable. Try again later.", "Der KI-Anbieter ist vorübergehend nicht verfügbar. Versuche es später erneut."),
    UNKNOWN("unknown", "The AI check failed. Your existing evidence was kept. Try again.", "Die KI-Prüfung ist fehlgeschlagen. Bisherige Belege bleiben erhalten. Versuche es erneut.");

    fun message(locale: String, hosted: Boolean = false): String = when {
        hosted && this == QUOTA -> if (locale == "de") "Das kostenlose Kontingent von Vegsnap KI ist aufgebraucht. Es wird um Mitternacht UTC zurückgesetzt."
            else "The free Vegsnap AI allowance is used up. It resets at midnight UTC."
        hosted && this == RATE_LIMIT -> if (locale == "de") "Zu viele Anfragen an Vegsnap KI. Warte eine Minute und versuche es erneut."
            else "Too many requests to Vegsnap AI. Wait a minute, then try again."
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
