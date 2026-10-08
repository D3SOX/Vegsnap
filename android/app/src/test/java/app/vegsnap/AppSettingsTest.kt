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
    @Test fun freshSettingsEnableAiWithoutOverwritingSavedOptOut() {
        assertTrue(AppSettings().aiEnabled)
        assertTrue(appSettingsFromPreferences(emptyPreferences()).aiEnabled)
        assertFalse(appSettingsFromPreferences(preferencesOf(booleanPreferencesKey("ai") to false)).aiEnabled)
    }
    @Test fun offlinePreservesAiChoiceForReturningOnline() {
        val offline = appSettingsFromPreferences(preferencesOf(booleanPreferencesKey("ai") to true, booleanPreferencesKey("offline") to true))
        assertTrue(offline.offline)
        assertTrue(offline.aiEnabled)
        assertTrue(offline.copy(offline = false).aiEnabled)
    }
}
