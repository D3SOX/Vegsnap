package app.vegsnap

import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.preferencesOf
import org.junit.Assert.*
import org.junit.Test

class AppSettingsTest {
    @Test fun `parallel checks default to three and saved values stay within one to ten`() {
        val key = androidx.datastore.preferences.core.intPreferencesKey("parallelChecks")
        assertEquals(3, AppSettings().parallelChecks)
        assertEquals(3, appSettingsFromPreferences(emptyPreferences()).parallelChecks)
        assertEquals(1, appSettingsFromPreferences(preferencesOf(key to 0)).parallelChecks)
        assertEquals(10, appSettingsFromPreferences(preferencesOf(key to 999)).parallelChecks)
        assertEquals(6, appSettingsFromPreferences(preferencesOf(key to 6)).parallelChecks)
    }
    @Test fun `default category starts auto and restores a valid saved choice`() {
        assertEquals("other", appSettingsFromPreferences(emptyPreferences()).defaultCategory)
        assertEquals("drink", appSettingsFromPreferences(preferencesOf(androidx.datastore.preferences.core.stringPreferencesKey("defaultCategory") to "drink")).defaultCategory)
        assertEquals("other", appSettingsFromPreferences(preferencesOf(androidx.datastore.preferences.core.stringPreferencesKey("defaultCategory") to "invalid")).defaultCategory)
    }
    @Test fun aiAvailabilityIsNoLongerControlledByASavedToggle() {
        assertTrue(AppSettings().aiEnabled)
        assertTrue(appSettingsFromPreferences(emptyPreferences()).aiEnabled)
        assertTrue(appSettingsFromPreferences(preferencesOf(booleanPreferencesKey("ai") to false)).aiEnabled)
    }
    @Test fun offlineStopsAiWithoutErasingTheConnection() {
        val offline = appSettingsFromPreferences(preferencesOf(booleanPreferencesKey("ai") to true, booleanPreferencesKey("offline") to true))
        assertTrue(offline.offline)
        assertTrue(offline.aiEnabled)
        assertTrue(offline.copy(offline = false).aiEnabled)
        val connected = offline.copy(connection = "api", model = "fixture-model", aiEnabled = false)
        assertFalse(connected.forAnalysis("https://hosted.example", "hosted-model", connected = true).aiEnabled)
        val online = connected.copy(offline = false).forAnalysis("https://hosted.example", "hosted-model", connected = true)
        assertTrue(online.aiEnabled)
        assertEquals("fixture-model", online.model)
    }
    @Test fun chatGPTChecksBecomeAvailableOnConnectAndUnavailableOnDisconnect() {
        val settings = AppSettings(chatgptModel = "fixture-model")
        val signedOut = ChatGPTStatus()
        val connected = ChatGPTStatus(connected = true)
        assertFalse(aiConnectionReady(settings, signedOut, HostedAIStatus(), "", ""))
        assertTrue(aiConnectionReady(settings, connected, HostedAIStatus(), "", ""))
        assertFalse(aiConnectionReady(settings.copy(chatgptModel = ""), connected, HostedAIStatus(), "", ""))
    }
    @Test fun hostedChecksRequireVerifiedAccessRatherThanJustAPendingToken() {
        val settings = AppSettings(connection = "hosted")
        val token = "a".repeat(64)
        assertFalse(aiConnectionReady(settings, ChatGPTStatus(), HostedAIStatus(state = "pending"), "", token))
        assertTrue(aiConnectionReady(settings, ChatGPTStatus(), HostedAIStatus(state = "connected", enabled = true), "", token))
        assertFalse(aiConnectionReady(settings, ChatGPTStatus(), HostedAIStatus(state = "connected", enabled = false), "", token))
        assertFalse(aiConnectionReady(settings, ChatGPTStatus(), HostedAIStatus(state = "connected", enabled = true), "", ""))
    }
    @Test fun apiChecksRequireAKeyAndModelWhileLocalModelsCanRunWithoutAKey() {
        val api = AppSettings(connection = "api", model = "fixture-model")
        fun ready(settings: AppSettings, token: String = "") = aiConnectionReady(settings, ChatGPTStatus(), HostedAIStatus(), token, "")
        assertFalse(ready(api))
        assertTrue(ready(api, "fixture-key"))
        assertFalse(ready(api.copy(model = ""), "fixture-key"))
        assertFalse(ready(api.copy(baseUrl = "http://remote.example/v1"), "fixture-key"))
        assertTrue(ready(api.copy(baseUrl = "http://127.0.0.1:11434/v1")))
        assertTrue(ready(api.copy(baseUrl = "http://localhost:11434/v1")))
        assertFalse(ready(api.copy(baseUrl = "http://127.0.0.1:11434/v1", model = "")))
    }
}
