package app.vegsnapp

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
    @Test fun localSignOutRetainsRegistrationWithoutRetainingCredentialsOrEmail() {
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
        assertFalse(persisted.contains("private"))
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
    @Test fun connectedSessionMustBeDisconnectedBeforeAddingOrSwitchingAccounts() {
        var metadata: String? = null
        val registrations = ChatGPTRegistrations({ metadata }) { metadata = it }
        val session = JSONObject().put("client_id", "oaiapp_first").put("subject", "first-user")
        val first = registrations.selected(session)
        val before = metadata
        assertThrows(IllegalArgumentException::class.java) { registrations.forSignIn(session, newAccount = true) }
        assertThrows(IllegalArgumentException::class.java) { registrations.forSignIn(session, clientId = "oaiapp_other") }
        assertEquals(first, registrations.forSignIn(session))
        assertEquals(before, metadata)
    }
    @Test fun existingSingleAccountMetadataIsRetainedWhenAddingAnotherAccount() {
        var metadata: String? = ChatGPTRegistration("oaiapp_existing").json().toString()
        val registrations = ChatGPTRegistrations({ metadata }) { metadata = it }
        assertEquals("oaiapp_existing", registrations.forSignIn(null)?.clientId)
        registrations.rememberIssued("oaiapp_new", newAccount = true)
        assertEquals(listOf("oaiapp_existing", "oaiapp_new"), registrations.accounts().map { it.clientId })
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
