package app.vegsnap

import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.crypto.RSASSASigner
import com.nimbusds.jose.jwk.JWKSet
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.SignedJWT
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Date

class ChatGPTConnectionTest {
    @Test fun persistedHostIdIsUuidV4UrnInAuthorization() {
        var stored: String? = null
        var saves = 0
        fun load() = chatGPTHostId({ stored }) { stored = it; saves++ }
        val host = load()
        assertEquals(host, load())
        assertEquals(1, saves)
        val url = chatGPTAuthorization(host, CHATGPT_BOOTSTRAP, "http://127.0.0.1:3210/auth/callback", "state", "nonce", "verifier").toHttpUrl()
        assertEquals(host, url.queryParameter("ext_agent_host_id"))
        assertTrue("ext_agent_host_id must be a UUIDv4 URN, not an arbitrary opaque string", host.matches(Regex("urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")))
    }
    @Test fun invalidSavedHostIdIsRejectedWithoutReplacement() {
        var saved = false
        listOf("old-invalid-opaque-id", "", "urn:uuid:8fd8cd3c-55d9-1a22-90aa-c42f0ea92bab",
            "urn:uuid:8fd8cd3c-55d9-4a22-10aa-c42f0ea92bab", "urn:uuid:8fd8cd3c55d94a2290aac42f0ea92bab",
            "urn:uuid:8fd8cd3c-55d9-4a22-90aa-c42f0ea92bab\n").forEach { invalid ->
            assertThrows(IllegalArgumentException::class.java) { chatGPTHostId({ invalid }) { saved = true } }
        }
        assertFalse(saved)
    }
    @Test fun savedUuidIsPreservedAndFailureToPersistStopsSignIn() {
        val valid = "urn:uuid:8fd8cd3c-55d9-4a22-90aa-c42f0ea92bab"
        assertEquals(valid, chatGPTHostId({ valid }) { fail("An existing host must not be replaced") })
        assertThrows(IllegalStateException::class.java) { chatGPTHostId({ null }) { error("Disk full") } }
    }
    @Test fun pkceUsesRfcVectorAndFreshSecrets() {
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
        assertNotEquals(oauthRandom(), oauthRandom())
        assertEquals(43, oauthRandom().length)
    }
    @Test fun authorizationBindsAllValuesAndUsesBootstrapOnlyForRegistration() {
        val host = "urn:uuid:8fd8cd3c-55d9-4a22-90aa-c42f0ea92bab"
        val url = chatGPTAuthorization(host, CHATGPT_BOOTSTRAP, "http://127.0.0.1:3210/auth/callback", "state", "nonce", "verifier").toHttpUrl()
        assertEquals("Vegsnap", url.queryParameter("agent_name_hint"))
        assertEquals("http://127.0.0.1:3210/auth/callback", url.queryParameter("redirect_uri"))
        assertEquals(pkceChallenge("verifier"), url.queryParameter("code_challenge"))
        assertEquals("state", url.queryParameter("state"))
        assertEquals("nonce", url.queryParameter("nonce"))
        val returning = chatGPTAuthorization(host, "oaiapp_test", "http://127.0.0.1:12/auth/callback", "s", "n", "v").toHttpUrl()
        assertNull(returning.queryParameter("agent_name_hint"))
    }
    @Test fun callbackRejectsMissingIssuedRegistrationWrongStateDuplicatesAndRefusal() {
        assertEquals("code" to "issued", chatGPTCallback("/auth/callback?state=s&code=code&client_id=issued", "s", null))
        assertEquals("code" to "issued", chatGPTCallback("/auth/callback?state=s&code=code", "s", "issued"))
        listOf("/callback?state=s&code=code&client_id=issued", "/auth/callback?state=wrong&code=code&client_id=issued",
            "/auth/callback?state=s&state=s&code=code&client_id=issued", "/auth/callback?state=s&code=code",
            "/auth/callback?state=s&code=code&client_id=dynamic_agent_client", "/auth/callback?state=s&error=access_denied").forEach {
            assertThrows(IllegalArgumentException::class.java) { chatGPTCallback(it, "s", null) }
        }
        assertThrows(IllegalArgumentException::class.java) { chatGPTCallback("/auth/callback?state=s&code=c&client_id=different", "s", "issued") }
    }
    @Test fun signatureAndEveryIdentityBindingAreCheckedBeforeUsingClaims() {
        val key = RSAKeyGenerator(2048).keyID("test-key").generate()
        val keys = JWKSet(key.toPublicJWK())
        val now = System.currentTimeMillis()
        fun token(issuer: String = CHATGPT_ISSUER, audience: String = "issued", nonce: String = "nonce", expiry: Long = now + 60_000, subject: String = "subject"): String {
            val claims = JWTClaimsSet.Builder().issuer(issuer).audience(audience).subject(subject).issueTime(Date(now))
                .expirationTime(Date(expiry)).claim("nonce", nonce).claim("email", "test@example.test").build()
            return SignedJWT(JWSHeader.Builder(JWSAlgorithm.RS256).keyID(key.keyID).build(), claims).apply { sign(RSASSASigner(key)) }.serialize()
        }
        assertEquals("subject", verifyChatGPTIdentity(token(), "issued", "nonce", keys, now).subject)
        listOf(token(issuer = "https://example.test"), token(audience = "other"), token(nonce = "wrong"), token(expiry = now - 60_000), token(subject = "")).forEach {
            assertThrows(IllegalArgumentException::class.java) { verifyChatGPTIdentity(it, "issued", "nonce", keys, now) }
        }
        val otherKey = RSAKeyGenerator(2048).keyID("test-key").generate()
        assertThrows(IllegalArgumentException::class.java) { verifyChatGPTIdentity(token(), "issued", "nonce", JWKSet(otherKey.toPublicJWK()), now) }
    }
    @Test fun planGrantMustBeExplicitAndRefreshCanRetainPreviouslyGrantedScopes() {
        fun tokens() = JSONObject().put("token_type", "Bearer").put("access_token", "test").put("expires_in", 3600)
        assertThrows(IllegalArgumentException::class.java) { chatGPTScopes(tokens().put("scope", "openid email")) }
        assertThrows(IllegalArgumentException::class.java) { chatGPTScopes(tokens()) }
        assertEquals(1, chatGPTScopes(tokens(), JSONArray().put("chatgpt.tokens.use.direct")).length())
        assertThrows(IllegalArgumentException::class.java) { chatGPTScopes(tokens().put("scope", "openid"), JSONArray().put("chatgpt.tokens.use.direct")) }
        assertThrows(IllegalArgumentException::class.java) { chatGPTScopes(tokens().put("token_type", "Basic"), JSONArray().put("chatgpt.tokens.use.direct")) }
    }
    @Test fun refreshRotatesAtomicallyAndCannotReplaceTheConnectedIdentity() {
        val previous = JSONObject().put("subject", "subject").put("email", "old@example.test").put("refresh_token", "old-refresh")
            .put("access_token", "old-access").put("scopes", JSONArray().put("chatgpt.tokens.use.direct"))
        val tokens = JSONObject().put("access_token", "new-access").put("refresh_token", "new-refresh")
            .put("token_type", "Bearer").put("expires_in", 3600).put("id_token", "verified-token")
        val next = refreshedChatGPTSession(previous, tokens, ChatGPTIdentity("subject", "new@example.test"), 100)
        assertEquals("new-refresh", next.getString("refresh_token"))
        assertEquals("new-access", next.getString("access_token"))
        assertEquals(3700, next.getLong("expires_at"))
        assertEquals("old-refresh", previous.getString("refresh_token"))
        assertThrows(IllegalArgumentException::class.java) { refreshedChatGPTSession(previous, tokens, ChatGPTIdentity("other", "")) }
        assertThrows(IllegalArgumentException::class.java) { refreshedChatGPTSession(previous, tokens, null) }
        tokens.remove("id_token"); tokens.remove("refresh_token")
        assertEquals("old-refresh", refreshedChatGPTSession(previous, tokens, null).getString("refresh_token"))
    }
    @Test fun streamedTextOnlySucceedsAfterCompletedNotAfterDoneOrLateFailure() {
        val delta = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"label\"}\n\n"
        assertEquals("label", readChatGPTStream((delta + "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n").byteInputStream()).text)
        listOf("", "data: [DONE]\n\n", "data: {\"type\":\"response.failed\"}\n\n", "data: {\"type\":\"response.incomplete\"}\n\n").forEach {
            assertThrows(Exception::class.java) { readChatGPTStream((delta + it).byteInputStream()) }
        }
        assertThrows(IllegalArgumentException::class.java) { readChatGPTStream("data: ${"x".repeat(2_000_001)}".byteInputStream()) }
    }
    @Test fun completedStreamCanCarryFinalTextWithoutAnyDeltas() {
        val item = JSONObject().put("type", "message").put("content", JSONArray().put(JSONObject().put("type", "output_text").put("text", "final label")))
        val terminal = JSONObject().put("type", "response.completed").put("response", JSONObject().put("status", "completed").put("output", JSONArray().put(item)))
        assertEquals("final label", readChatGPTStream("data: $terminal\n\n".byteInputStream()).text)
        val early = JSONObject().put("type", "response.output_item.done").put("item", item)
        assertEquals("final label", readChatGPTStream("data: $early\n\ndata: {\"type\":\"response.completed\"}\n\n".byteInputStream()).text)
        assertThrows(Exception::class.java) { readChatGPTStream("data: $early\n\n".byteInputStream()) }
    }
    @Test fun finalTextReplacesDeltasWithoutDuplicatingAndStillNeedsCompletion() {
        val prefix = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\ndata: {\"type\":\"response.output_text.done\",\"text\":\"full label\"}\n\n"
        assertEquals("full label", readChatGPTStream((prefix + "data: {\"type\":\"response.completed\"}\n\n").byteInputStream()).text)
        assertThrows(AIProviderFailure::class.java) { readChatGPTStream(prefix.byteInputStream()) }
    }
    @Test fun streamRecognizesErrorEnvelopeWithoutPayloadEventType() {
        val body = "event: error\ndata: {\"error\":{\"code\":\"usage_limit_reached\",\"message\":\"private text\"}}\n\n"
        val error = assertThrows(AIProviderFailure::class.java) { readChatGPTStream(body.byteInputStream()) }
        assertEquals(AIErrorCode.QUOTA, error.reason)
    }
    @Test fun completedStreamRetainsToolMetadataFromEarlierOutputItemEvents() {
        val tool = JSONObject().put("type", "response.output_item.done").put("item", JSONObject().put("type", "web_search_call").put("status", "completed")
            .put("action", JSONObject().put("sources", JSONArray().put(JSONObject().put("url", "https://maker.example/product")))))
        val delta = JSONObject().put("type", "response.output_text.delta").put("delta", "{\"text\":\"\"}")
        val prefix = "data: $tool\n\ndata: $delta\n\n"
        val success = readChatGPTStream((prefix + "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n").byteInputStream())
        assertTrue(success.research.getBoolean("searched"))
        assertEquals("https://maker.example/product", success.research.getJSONArray("sources").getJSONObject(0).getString("url"))
        assertThrows(Exception::class.java) { readChatGPTStream((prefix + "data: {\"type\":\"response.failed\"}\n\n").byteInputStream()) }
        assertThrows(Exception::class.java) { readChatGPTStream(prefix.byteInputStream()) }
    }
    @Test fun streamMergesEarlyMessageCitationsAndTerminalSourcesWithoutDuplicates() {
        fun event(value: JSONObject) = "data: $value\n\n"
        val tool = JSONObject().put("type", "web_search_call").put("status", "completed")
        val citation = JSONObject().put("type", "url_citation").put("url", "https://maker.example/product")
        val message = JSONObject().put("type", "message").put("content", JSONArray().put(JSONObject().put("type", "output_text").put("annotations", JSONArray().put(citation))))
        val stream = event(JSONObject().put("type", "response.output_item.done").put("item", tool)) +
            event(JSONObject().put("type", "response.output_item.done").put("item", message)) +
            event(JSONObject().put("type", "response.output_text.delta").put("delta", "{}")) +
            event(JSONObject().put("type", "response.completed").put("response", JSONObject().put("status", "completed").put("output", JSONArray().put(message))))
        var researchStarted = 0
        val parsed = readChatGPTStream(stream.byteInputStream(), onResearchStarted = { researchStarted++ })
        assertEquals(1, researchStarted)
        assertTrue(parsed.research.getBoolean("searched"))
        assertEquals(1, parsed.research.getJSONArray("sources").length())
        assertEquals("https://maker.example/product", parsed.research.getJSONArray("sources").getJSONObject(0).getString("url"))
    }
    @Test fun streamCarriesOnlyProviderResearchMetadata() {
        val response = JSONObject().put("status", "completed").put("output", org.json.JSONArray().put(
            JSONObject().put("type", "web_search_call").put("status", "completed").put("action", JSONObject().put("sources",
                org.json.JSONArray().put(JSONObject().put("url", "https://maker.example/product"))))))
        val delta = "data: " + JSONObject().put("type", "response.output_text.delta").put("delta", "{\"research\":true}").toString() + "\n\n"
        val done = "data: " + JSONObject().put("type", "response.completed").put("response", response).toString() + "\n\n"
        val parsed = readChatGPTStream((delta + done).byteInputStream())
        assertTrue(parsed.research.getBoolean("searched"))
        assertEquals("https://maker.example/product", parsed.research.getJSONArray("sources").getJSONObject(0).getString("url"))
        val plain = readChatGPTStream((delta + "data: {\"type\":\"response.completed\"}\n\n").byteInputStream())
        assertFalse(plain.research.getBoolean("searched"))
    }

}
