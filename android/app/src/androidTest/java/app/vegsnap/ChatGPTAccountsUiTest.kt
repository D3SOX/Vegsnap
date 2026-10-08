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
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

class ChatGPTAccountsUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun accountSwitchStopsChatGPTWorkBeforeOpeningTheBrowserAndBlocksRetries() {
        val application = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        assumeTrue(application.packageName.endsWith(".screenshots"))
        val preferences = application.getSharedPreferences("chatgpt-host", Application.MODE_PRIVATE)
        preferences.edit().remove("registration").commit()
        ChatGPTRegistrations({ preferences.getString("registration", null) }) {
            check(preferences.edit().putString("registration", it).commit())
        }.verified("oaiapp_first", "first-user", "alpha@example.test")
        runBlocking { SettingsStore(application).save(AppSettings(connection = "chatgpt", chatgptModel = "fixture-model")) }
        val viewModels = ViewModelStore()
        lateinit var model: VegsnapViewModel
        compose.runOnUiThread { model = VegsnapViewModel(application); viewModels.put("accounts", model) }
        compose.waitUntil(10_000) { !model.settings.value.offline && model.chatGPTState.value.savedAccounts.size == 1 }
        val queue = ApplicationAnalysisQueue.get(application)
        val running = queue.enqueue(CheckInput(text = "running"), AppSettings(connection = "chatgpt"), emptyList())
        queue.next(offline = false, parallelChecks = 1)
        val waiting = queue.enqueue(CheckInput(text = "waiting"), AppSettings(connection = "chatgpt"), emptyList())
        val other = queue.enqueue(CheckInput(text = "local"), AppSettings(connection = "api", offline = true), emptyList())
        val workerScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val releaseWorker = CompletableDeferred<Unit>()
        val worker = workerScope.launch(start = CoroutineStart.UNDISPATCHED) {
            try { awaitCancellation() }
            finally { withContext(NonCancellable) { releaseWorker.await() } }
        }
        val previousCancellation = ApplicationAnalysisQueue.cancelRunning
        ApplicationAnalysisQueue.cancelRunning = { id -> if (id == running.id) worker.also { it.cancel() } else null }
        val browserOpened = CompletableDeferred<Unit>()
        try {
            compose.runOnUiThread { model.connectChatGPT(newAccount = true) { browserOpened.complete(Unit) } }
            compose.waitUntil(10_000) { browserOpened.isCompleted || queue.get(running.id)?.status == AnalysisStatus.CANCELLED }
            assertEquals(AnalysisStatus.CANCELLED, queue.get(running.id)?.status)
            assertFalse("Sign-in must wait for the old running request to finish cancelling", browserOpened.isCompleted)
            releaseWorker.complete(Unit)
            compose.waitUntil(10_000) { browserOpened.isCompleted }
            assertEquals(AnalysisStatus.CANCELLED, queue.get(waiting.id)?.status)
            assertEquals(AnalysisStatus.QUEUED, queue.get(other.id)?.status)
            lateinit var retry: Job
            compose.runOnUiThread {
                retry = model.retryJob(waiting.id)
                model.update { it.copy(text = "check during sign-in") }
                model.check()
            }
            runBlocking { retry.join() }
            assertEquals(AnalysisStatus.CANCELLED, queue.get(waiting.id)?.status)
            assertEquals(3, queue.jobs.value.size)
        } finally {
            releaseWorker.complete(Unit)
            compose.runOnUiThread { model.cancelChatGPT(); viewModels.clear() }
            workerScope.cancel()
            ApplicationAnalysisQueue.cancelRunning = previousCancellation
            queue.jobs.value.forEach { queue.stop(it.id, AnalysisStatus.CANCELLED); queue.remove(it.id) }
        }
    }

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
