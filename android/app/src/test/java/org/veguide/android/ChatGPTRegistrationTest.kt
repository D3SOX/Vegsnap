package org.veguide.android

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ChatGPTRegistrationTest {
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
        assertFalse(metadata!!.contains("private"))
        assertFalse(metadata!!.contains("verified-user"))
        assertEquals(setOf("client_id", "subject_hash"), JSONObject(metadata!!).keys().asSequence().toSet())
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
}
