package app.vegsnap

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import java.io.IOException
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ContentReportButtonTest {
    @get:Rule val compose = createComposeRule()
    private val reference = "12345678-1234-4234-8234-123456789abc"

    @Test fun reportAllowsRedactionAndSendsOnlyAfterExplicitConfirmation() {
        var sent: ContentReport? = null
        compose.setContent { MaterialTheme {
            ContentReportButton("ai", false, initialText = "Private text") { sent = it; reference }
        } }
        compose.onNodeWithText("Report AI output").performClick()
        compose.onNodeWithText("Send report").assertIsNotEnabled()
        compose.onNodeWithText("AI text to report").performTextReplacement("Redacted excerpt")
        compose.onNodeWithText("Why are you reporting this content?").performTextInput("Offensive explanation")
        compose.runOnIdle { assertNull(sent) }
        compose.onNodeWithText("Send report").performClick()
        compose.onNodeWithText("Report received. Thank you. Reference: $reference").assertExists()
        compose.runOnIdle { assertEquals(ContentReport("ai", text = "Redacted excerpt", reason = "Offensive explanation"), sent) }
        compose.onNodeWithText("Close").performClick()
        compose.onNodeWithText("AI text to report").assertDoesNotExist()
    }
    @Test fun failedReportsRemainEditableAndCanBeRetried() {
        var calls = 0
        compose.setContent { MaterialTheme {
            ContentReportButton("community", false, contentId = reference) { if (++calls == 1) throw IOException("unavailable") else reference }
        } }
        compose.onNodeWithText("Report this reply").performClick()
        compose.onNodeWithText("Why are you reporting this content?").performTextInput("Personal information")
        compose.onNodeWithText("Send report").performClick()
        compose.onNodeWithText("Could not send the report. Try again shortly. Your report has not been confirmed.").assertExists()
        compose.onNodeWithText("Send report").performClick()
        compose.onNodeWithText("Report received. Thank you. Reference: $reference").assertExists()
        compose.runOnIdle { assertEquals(2, calls) }
    }
    @Test fun offlineModeDisablesReportingEvenWhenTheDialogIsAlreadyOpen() {
        val offline = mutableStateOf(false)
        var calls = 0
        compose.setContent { MaterialTheme {
            ContentReportButton("community", offline.value, contentId = reference) { calls++; reference }
        } }
        compose.onNodeWithText("Report this reply").performClick()
        compose.onNodeWithText("Why are you reporting this content?").performTextInput("Issue")
        compose.runOnIdle { offline.value = true }
        compose.onNodeWithText("Go online to send a report.").assertExists()
        compose.onNodeWithText("Send report").assertIsNotEnabled()
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("Report this reply").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(0, calls) }
    }
}
