package app.vegsnap

import org.json.JSONObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

class ChatGPTRegistrationTest {
    @Test fun anotherAccountStartsFreshAuthorizationWithoutReusingWorkspaceBoundClient() {
        var metadata: String? = null
        val registrations = ChatGPTRegistrations({ metadata }) { metadata = it }
        registrations.verified("oaiapp_original", "original-user")
        val original = metadata
        val registration = registrations.forSignIn(null, newAccount = true)
        val url = chatGPTAuthorization("urn:uuid:8fd8cd3c-55d9-4a22-90aa-c42f0ea92bab", registration?.clientId ?: CHATGPT_BOOTSTRAP,
            "http://127.0.0.1:3210/auth/callback", "state", "nonce", "verifier").toHttpUrl()
        assertEquals(CHATGPT_BOOTSTRAP, url.queryParameter("client_id"))
        assertEquals("Vegsnap", url.queryParameter("agent_name_hint"))
        assertEquals("oaiapp_original", registrations.forSignIn(null)?.clientId)
        assertEquals(original, metadata)
    }
    @Test fun localSignOutRetainsVerifiedEmailForAccountIdentificationWithoutTokens() {
        var metadata: String? = null
        val registrations = ChatGPTRegistrations({ metadata }) { metadata = it }
        val session = JSONObject().put("client_id", "oaiapp_existing").put("subject", "verified-user")
            .put("access_token", "private-access").put("refresh_token", "private-refresh").put("id_token", "private-id")
            .put("email", "private@example.test")
        val original = registrations.selected(session)
        val afterSignOut = registrations.selected(null)
        assertEquals(original, afterSignOut)
        assertEquals("oaiapp_existing", afterSignOut?.clientId)
        val persisted = requireNotNull(metadata)
        assertEquals("private@example.test", JSONObject(persisted).getJSONArray("registrations").getJSONObject(0).getString("email"))
        assertFalse(persisted.contains("private-access"))
        assertFalse(persisted.contains("private-refresh"))
        assertFalse(persisted.contains("private-id"))
        assertFalse(persisted.contains("verified-user"))
        assertEquals(setOf("selected_client_id", "registrations"), JSONObject(persisted).keys().asSequence().toSet())
    }
    @Test fun issuedCallbackRegistrationSurvivesTokenExchangeFailure() {
        var metadata: String? = null
        val registrations = ChatGPTRegistrations({ metadata }) { metadata = it }
        registrations.rememberIssued("oaiapp_issued")
        // A failed exchange leaves no tokens. The next attempt must not bootstrap again.
        assertEquals("oaiapp_issued", registrations.selected(null)?.clientId)
    }
    @Test fun returningRegistrationCannotSilentlyChangeAccountOrClient() {
        var metadata: String? = null
        val registrations = ChatGPTRegistrations({ metadata }) { metadata = it }
        registrations.verified("oaiapp_existing", "original-subject")
        val original = metadata
        assertThrows(IllegalArgumentException::class.java) { registrations.verified("oaiapp_existing", "other-subject") }
        assertThrows(IllegalArgumentException::class.java) { registrations.rememberIssued("oaiapp_other") }
        assertEquals(original, metadata)
    }
    @Test fun invalidCallbackCannotPersistAnIssuedRegistration() {
        var metadata: String? = null
        val registrations = ChatGPTRegistrations({ metadata }) { metadata = it }
        for (callback in listOf("/auth/callback?state=wrong&code=c&client_id=oaiapp_new", "/auth/callback?state=s&client_id=oaiapp_new",
            "/auth/callback?state=s&code=c&client_id=dynamic_agent_client", "/auth/callback?state=s&error=denied&client_id=oaiapp_new")) {
            assertThrows(IllegalArgumentException::class.java) {
                val (_, issued) = chatGPTCallback(callback, "s", null)
                registrations.rememberIssued(issued)
            }
            assertNull(metadata)
        }
    }
    @Test fun invalidOrUnpersistableRegistrationDoesNotFallBackToBootstrap() {
        var metadata: String? = null
        val registrations = ChatGPTRegistrations({ metadata }) { metadata = it }
        listOf(CHATGPT_BOOTSTRAP, "", "bad client", "x".repeat(201)).forEach {
            assertThrows(IllegalArgumentException::class.java) { registrations.rememberIssued(it) }
        }
        assertNull(metadata)
        val broken = ChatGPTRegistrations({ null }) { error("Disk full") }
        assertThrows(IllegalStateException::class.java) { broken.rememberIssued("oaiapp_issued") }
    }
    @Test fun anotherAccountKeepsOriginalBindingAndCanReconnectEachAccount() {
        var metadata: String? = null
        val registrations = ChatGPTRegistrations({ metadata }) { metadata = it }
        val first = registrations.verified("oaiapp_first", "first-user")
        val fresh = registrations.forSignIn(null, newAccount = true)
        val (_, clientId) = chatGPTCallback("/auth/callback?state=s&code=code&client_id=oaiapp_second", "s", fresh?.clientId)
        registrations.rememberIssued(clientId, newAccount = true)
        val second = registrations.verified(clientId, "second-user")
        // Simulate process restart and local sign-out, preserving each account/client mapping.
        val reopened = ChatGPTRegistrations({ metadata }) { metadata = it }
        assertEquals(listOf(first, second), reopened.accounts())
        assertEquals(second, reopened.forSignIn(null))
        val returning = reopened.forSignIn(null, clientId = first.clientId)!!
        val url = chatGPTAuthorization("host", returning.clientId, "http://127.0.0.1:1234/auth/callback", "s", "n", "v").toHttpUrl()
        assertEquals(first.clientId, url.queryParameter("client_id"))
        assertNull(url.queryParameter("agent_name_hint"))
        val (_, issued) = chatGPTCallback("/auth/callback?state=s&code=code", "s", returning.clientId)
        reopened.rememberIssued(issued)
        reopened.verified(issued, "first-user")
        assertEquals(first, reopened.selected(null))
        assertEquals(listOf(first, second), reopened.accounts())
    }
    @Test fun failedNewAccountExchangeRetainsIssuedClientForRetryAndOriginalForSelection() {
        var metadata: String? = null
        val registrations = ChatGPTRegistrations({ metadata }) { metadata = it }
        val first = registrations.verified("oaiapp_first", "first-user")
        registrations.rememberIssued("oaiapp_pending", newAccount = true)
        assertEquals("oaiapp_pending", registrations.forSignIn(null)?.clientId)
        assertEquals(first, registrations.forSignIn(null, clientId = first.clientId))
        val before = metadata
        assertThrows(IllegalArgumentException::class.java) { registrations.verified(first.clientId, "second-user") }
        assertEquals(before, metadata)
    }
    @Test fun switchingAccountsKeepsCurrentSessionUntilNewIdentityIsValidated() {
        var metadata: String? = null
        val registrations = ChatGPTRegistrations({ metadata }) { metadata = it }
        val session = JSONObject().put("client_id", "oaiapp_first").put("subject", "first-user")
        val first = registrations.selected(session)
        assertNull(registrations.forSignIn(session, newAccount = true))
        registrations.rememberIssued("oaiapp_other", newAccount = true)
        registrations.verified("oaiapp_other", "other-user")
        assertEquals("oaiapp_other", registrations.forSignIn(session, clientId = "oaiapp_other")?.clientId)
        assertEquals(first, registrations.forSignIn(session))
        assertEquals(listOf("oaiapp_first", "oaiapp_other"), registrations.accounts().map { it.clientId })
    }
    @Test fun existingSingleAccountMetadataIsRetainedWhenAddingAnotherAccount() {
        var metadata: String? = ChatGPTRegistration("oaiapp_existing").json().toString()
        val registrations = ChatGPTRegistrations({ metadata }) { metadata = it }
        assertEquals("oaiapp_existing", registrations.forSignIn(null)?.clientId)
        registrations.rememberIssued("oaiapp_new", newAccount = true)
        assertEquals(listOf("oaiapp_existing", "oaiapp_new"), registrations.accounts().map { it.clientId })
    }
    @Test fun savedAccountEmailsStayBoundToVerifiedIdentitiesAcrossRestartAndSwitching() {
        var metadata: String? = null
        val registrations = ChatGPTRegistrations({ metadata }) { metadata = it }
        val first = JSONObject().put("client_id", "oaiapp_first").put("subject", "first-user").put("email", "first@example.test")
        registrations.selected(first)
        registrations.rememberIssued("oaiapp_second", newAccount = true)
        registrations.verified("oaiapp_second", "second-user", "second@example.test")
        val reopened = ChatGPTRegistrations({ metadata }) { metadata = it }
        assertEquals(listOf("first@example.test", "second@example.test"), reopened.accounts().map { it.email })
        assertEquals("second@example.test", reopened.forSignIn(first, clientId = "oaiapp_second")?.email)
        assertEquals("first@example.test", reopened.selected(first)?.email)
        val before = metadata
        assertThrows(IllegalArgumentException::class.java) { reopened.verified("oaiapp_first", "wrong-user", "wrong@example.test") }
        assertEquals(before, metadata)
        reopened.verified("oaiapp_first", "first-user")
        assertEquals("first@example.test", reopened.selected(null)?.email)
    }
    @Test fun failedSwitchRetainsTheActiveAccountAndPendingRegistrationForRetry() {
        var metadata: String? = null
        val registrations = ChatGPTRegistrations({ metadata }) { metadata = it }
        val first = JSONObject().put("client_id", "oaiapp_first").put("subject", "first-user").put("email", "first@example.test")
        registrations.selected(first)
        assertNull(registrations.forSignIn(first, newAccount = true))
        registrations.rememberIssued("oaiapp_pending", newAccount = true)
        // Model's finally/status reload restores the current session after exchange fails.
        assertEquals("oaiapp_first", registrations.selected(first)?.clientId)
        assertEquals("oaiapp_pending", registrations.forSignIn(first, clientId = "oaiapp_pending")?.clientId)
        assertEquals("first@example.test", registrations.selected(first)?.email)
    }
    @Test fun removingSavedAccountKeepsOtherBindingsAndRemovingLastAllowsFreshSignIn() {
        var metadata: String? = null
        val registrations = ChatGPTRegistrations({ metadata }) { metadata = it }
        registrations.verified("oaiapp_first", "first-user", "first@example.test")
        registrations.rememberIssued("oaiapp_second", newAccount = true)
        registrations.verified("oaiapp_second", "second-user", "second@example.test")
        registrations.remove("oaiapp_first")
        assertEquals(listOf("second@example.test"), registrations.accounts().map { it.email })
        assertEquals("oaiapp_second", registrations.selected(null)?.clientId)
        assertFalse(requireNotNull(metadata).contains("first@example.test"))
        registrations.remove("oaiapp_second")
        val reopened = ChatGPTRegistrations({ metadata }) { metadata = it }
        assertTrue(reopened.accounts().isEmpty())
        assertNull(reopened.forSignIn(null))
        reopened.rememberIssued("oaiapp_fresh")
        assertEquals("oaiapp_fresh", reopened.selected(null)?.clientId)
    }
    @Test fun removingSelectedAccountChoosesRemainingAccountAndUnknownRemovalDoesNothing() {
        var metadata: String? = null
        val registrations = ChatGPTRegistrations({ metadata }) { metadata = it }
        registrations.verified("oaiapp_first", "first-user", "first@example.test")
        registrations.rememberIssued("oaiapp_second", newAccount = true)
        registrations.remove("oaiapp_second")
        assertEquals("oaiapp_first", registrations.selected(null)?.clientId)
        val before = metadata
        registrations.remove("unknown")
        assertEquals(before, metadata)
    }
    @Test fun activeRemovalClearsCredentialsBeforeMetadataAndInterruptedWritesRemainRecoverable() {
        var metadata: String? = null
        var failWrite = false
        val registrations = ChatGPTRegistrations({ metadata }) { if (failWrite) error("Disk full") else metadata = it }
        var active: JSONObject? = JSONObject().put("client_id", "oaiapp_first").put("subject", "first-user").put("email", "first@example.test")
        registrations.selected(active)
        registrations.rememberIssued("oaiapp_second", newAccount = true)
        registrations.verified("oaiapp_second", "second-user", "second@example.test")
        registrations.selected(active)
        val original = metadata
        assertThrows(IllegalStateException::class.java) {
            registrations.remove("oaiapp_first", active) { error("Keystore unavailable") }
        }
        assertEquals(original, metadata)
        assertEquals("oaiapp_first", registrations.selected(active)?.clientId)
        failWrite = true
        assertThrows(IllegalStateException::class.java) {
            registrations.remove("oaiapp_first", active) { active = null }
        }
        assertNull(active)
        assertEquals(original, metadata)
        assertEquals("oaiapp_first", registrations.selected(null)?.clientId)
        failWrite = false
        registrations.remove("oaiapp_first", active) { fail("Already disconnected") }
        assertEquals("oaiapp_second", registrations.selected(null)?.clientId)
        assertEquals(listOf("second@example.test"), registrations.accounts().map { it.email })
    }
    @Test fun removingInactiveAccountNeverClearsCurrentCredentials() {
        var metadata: String? = null
        val registrations = ChatGPTRegistrations({ metadata }) { metadata = it }
        val active = JSONObject().put("client_id", "oaiapp_first").put("subject", "first-user")
        registrations.selected(active)
        registrations.rememberIssued("oaiapp_second", newAccount = true)
        registrations.remove("oaiapp_second", active) { fail("Must keep active credentials") }
        assertEquals("oaiapp_first", registrations.selected(active)?.clientId)
    }
    @Test fun corruptMetadataAndUnknownAccountSelectionNeverBootstrapSilently() {
        var metadata: String? = "broken"
        val registrations = ChatGPTRegistrations({ metadata }) { metadata = it }
        assertThrows(org.json.JSONException::class.java) { registrations.forSignIn(null, newAccount = true) }
        assertEquals("broken", metadata)
        metadata = null
        registrations.verified("oaiapp_existing", "user")
        val before = metadata
        assertThrows(IllegalArgumentException::class.java) { registrations.forSignIn(null, clientId = "unknown") }
        assertEquals(before, metadata)
    }
}
