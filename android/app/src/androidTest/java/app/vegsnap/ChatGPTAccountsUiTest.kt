package app.vegsnap

import android.app.Application
import android.graphics.Bitmap
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelStore
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

class ChatGPTAccountsUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun offlineAccountManagementShowsEmailsAndRemovesOnlyTheChosenAccount() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val application = instrumentation.targetContext.applicationContext as Application
        // This fixture writes account metadata only in the isolated capture application.
        assumeTrue(application.packageName.endsWith(".screenshots"))
        val preferences = application.getSharedPreferences("chatgpt-host", Application.MODE_PRIVATE)
        val accounts = ChatGPTRegistrations({ preferences.getString("registration", null) }) {
            check(preferences.edit().putString("registration", it).commit())
        }
        preferences.edit().remove("registration").commit()
        accounts.verified("oaiapp_first", "first-user", "alpha@example.test")
        accounts.rememberIssued("oaiapp_second", newAccount = true)
        accounts.verified("oaiapp_second", "second-user", "beta@example.test")
        runBlocking { SettingsStore(application).save(AppSettings(connection = "hosted", offline = true)) }
        val store = ViewModelStore()
        lateinit var model: VegsnapViewModel
        compose.runOnUiThread { model = VegsnapViewModel(application); store.put("accounts", model) }
        try {
            compose.setContent {
                val settings by model.settings.collectAsState()
                MaterialTheme {
                    Surface {
                        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
                            AIConnectionSettings(settings, model)
                        }
                    }
                }
            }
            compose.waitUntil(10_000) { model.settings.value.offline && model.chatGPTState.value.savedAccounts.size == 2 }
            compose.onNodeWithText("ChatGPT").performScrollTo().performClick()
            compose.onNodeWithText("Saved accounts").performScrollTo().performClick()
            compose.onNodeWithText("alpha@example.test").assertIsDisplayed().assertIsNotEnabled()
            compose.onNodeWithText("beta@example.test").assertIsDisplayed().assertIsNotEnabled()
            if (InstrumentationRegistry.getArguments().getString("captureChatGPTAccounts") == "true") {
                File(application.cacheDir, "chatgpt-accounts-offline.png").outputStream().use {
                    checkNotNull(instrumentation.uiAutomation.takeScreenshot()).apply {
                        compress(Bitmap.CompressFormat.PNG, 100, it)
                        recycle()
                    }
                }
            }
            compose.onNodeWithContentDescription("Remove beta@example.test").assertIsEnabled().performClick()
            compose.onNodeWithText("Remove saved account?").assertIsDisplayed()
            compose.onNodeWithText("Cancel").performClick()
            assertEquals(2, accounts.accounts().size)
            compose.onNodeWithText("Saved accounts").performScrollTo().performClick()
            compose.onNodeWithContentDescription("Remove beta@example.test").performClick()
            compose.onNodeWithText("Delete").performClick()
            compose.waitUntil(10_000) { model.chatGPTState.value.savedAccounts.size == 1 }
            assertEquals(listOf("alpha@example.test"), accounts.accounts().map { it.email })
            compose.onNodeWithText("Saved accounts").performScrollTo().performClick()
            compose.onNodeWithText("alpha@example.test").assertIsDisplayed()
            compose.onNodeWithText("beta@example.test").assertDoesNotExist()
        } finally { compose.runOnUiThread { store.clear() } }
    }
}
