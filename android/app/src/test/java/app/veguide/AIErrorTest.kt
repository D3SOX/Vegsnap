package app.veguide

import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AIErrorTest {
    @Test fun providerCodesDistinguishQuotaFromRateLimitWithoutRetainingMessages() {
        val cases = listOf(
            Triple(401, "invalid_api_key", "authentication"),
            Triple(403, "permission_denied", "access_denied"),
            Triple(429, "insufficient_quota", "quota"),
            Triple(429, "usage_limit_reached", "quota"),
            Triple(429, "rate_limit_exceeded", "rate_limit"),
            Triple(400, "model_not_supported", "unsupported_model"),
            Triple(404, "model_not_found", "unsupported_model"),
            Triple(503, "server_error", "service"),
            Triple(504, "", "timeout"),
            Triple(400, "", "request_rejected"),
        )
        cases.forEach { (status, code, expected) ->
            val body = JSONObject().put("error", JSONObject().put("code", code).put("message", "secret@example.test Bearer private-token supplied-private-text"))
            val error = providerHttpFailure(status, body.toString().byteInputStream())
            val result = aiFailure(error, "en")
            assertEquals(expected, result.getString("code"))
            assertFalse(result.toString().contains("private"))
            assertFalse(result.toString().contains("example.test"))
            assertEquals(expected, error.message)
            assertNull(error.cause)
        }
    }
    @Test fun subscriptionSharingFailuresAreNotMistakenForTruncatedStreams() {
        val cases = mapOf("subscription_sharing_usage_limit_exceeded" to AIErrorCode.QUOTA,
            "subscription_sharing_usage_unavailable" to AIErrorCode.SERVICE, "user_not_eligible" to AIErrorCode.ACCESS,
            "unsupported_capability" to AIErrorCode.MODEL)
        cases.forEach { (code, reason) ->
            val event = JSONObject().put("type", "response.failed").put("response", JSONObject().put("status", "failed")
                .put("error", JSONObject().put("code", code).put("message", "private text and private@example.test")))
            val diagnostics = mutableListOf<String>()
            val failure = assertThrows(AIProviderFailure::class.java) { readChatGPTStream("data: $event\n\n".byteInputStream(), onDiagnostic = diagnostics::add) }
            assertEquals(reason, failure.reason)
            assertTrue(diagnostics.single().contains("code=$code"))
            assertFalse(diagnostics.single().contains("private"))
        }
        assertEquals(AIErrorCode.UNKNOWN, providerStreamFailure(JSONObject().put("type", "response.failed")).reason)
        assertEquals(AIErrorCode.INCOMPLETE, providerStreamFailure(JSONObject().put("type", "response.incomplete")).reason)
    }
    @Test fun streamDiagnosticRejectsAnythingExceptBoundedMachineTags() {
        val event = JSONObject().put("error", JSONObject().put("code", "person@example.test").put("type", "token " + "a".repeat(100)))
        val diagnostic = streamFailureDiagnostic(event, "response.failed")
        assertFalse(diagnostic.contains("person"))
        assertFalse(diagnostic.contains("token"))
        assertTrue(diagnostic.contains("code=unrecognized"))
    }
    @Test fun malformedOversizedAndFailedErrorBodiesKeepHttpClassification() {
        for (body in listOf("not-json secret", "x".repeat(65_537))) {
            assertEquals("rate_limit", aiFailure(providerHttpFailure(429, body.byteInputStream()), "en").getString("code"))
        }
        val broken = object : java.io.InputStream() { override fun read(): Int = throw IOException("secret") }
        assertEquals("service", aiFailure(providerHttpFailure(503, broken), "en").getString("code"))
        val bounded = object : java.io.InputStream() {
            var count = 0
            override fun read(): Int { check(++count <= 65_537); return 'x'.code }
        }
        assertEquals("authentication", aiFailure(providerHttpFailure(401, bounded), "en").getString("code"))
        assertEquals(65_537, bounded.count)
    }
    @Test fun actualTransportExceptionTypesRetainTimeoutVersusConnectivity() {
        assertEquals("timeout", aiFailure(SocketTimeoutException("secret-url"), "en").getString("code"))
        assertEquals("network", aiFailure(UnknownHostException("private-host"), "en").getString("code"))
        assertEquals("invalid_response", aiFailure(org.json.JSONException("secret model text"), "en").getString("code"))
        assertEquals("unknown", aiFailure(IllegalStateException("private-token"), "en").getString("code"))
        assertTrue(aiFailure(SocketTimeoutException(), "de").getString("message").contains("lange gedauert"))
    }
    @Test fun streamedProviderFailurePreservesStructuredReasonAndRejectsPartialOutput() {
        val partial = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n"
        val failed = "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"usage_limit_reached\",\"message\":\"private\"}}}\n\n"
        val error = assertThrows(AIProviderFailure::class.java) { readChatGPTStream((partial + failed).byteInputStream()) }
        assertEquals("quota", aiFailure(error, "en").getString("code"))
        val interrupted = assertThrows(AIProviderFailure::class.java) { readChatGPTStream(partial.byteInputStream()) }
        assertEquals("incomplete_response", aiFailure(interrupted, "en").getString("code"))
    }
}
