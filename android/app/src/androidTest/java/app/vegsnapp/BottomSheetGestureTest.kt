package app.vegsnapp

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

@OptIn(ExperimentalMaterial3Api::class)
class BottomSheetGestureTest {
    @get:Rule val compose = createComposeRule()

    @Test fun expandedResultRemainsStableWhenSwipingPastEnd() = checkFlingStability(false)
    @Test fun darkResultRemainsStableWhenSwipingPastEnd() = checkFlingStability(true)

    private fun checkFlingStability(dark: Boolean) {
        val tops = mutableListOf<Float>()
        lateinit var scroll: ScrollState
        compose.setContent {
            MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme()) {
                scroll = rememberScrollState()
                VegsnapBottomSheet(onDismissRequest = {}, dragHandle = {
                    BottomSheetDefaults.DragHandle(Modifier.onGloballyPositioned { tops.add(it.positionInWindow().y) })
                }) {
                    Column(Modifier.fillMaxWidth().testTag("result-scroll").verticalScroll(scroll).padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        Text("More information needed", style = MaterialTheme.typography.headlineMedium)
                        Text("A product with multiple sources")
                        repeat(8) { index ->
                            OutlinedCard(Modifier.fillMaxWidth()) {
                                Column(Modifier.padding(24.dp)) {
                                    Text("Evidence ${index + 1}")
                                    Text("The available evidence is insufficient for a reliable conclusion. Compare the ingredients and product variant with the original source.")
                                }
                            }
                        }
                        Text("Company concerns")
                        Row { TextButton(onClick = {}) { Text("Share") }; TextButton(onClick = {}) { Text("Close") } }
                    }
                }
            }
        }
        compose.waitForIdle()
        val content = compose.onNodeWithTag("result-scroll")
        repeat(4) { content.performTouchInput { swipeUp(durationMillis = 250) } }
        compose.runOnIdle {
            assertTrue("The result must actually scroll before testing the end boundary", scroll.value > 0)
            val settledTop = tops.last()
            tops.clear()
            tops.add(settledTop)
        }
        repeat(5) {
            content.performTouchInput { swipeUp(durationMillis = 80) }
            compose.waitForIdle()
        }
        compose.runOnIdle {
            val travel = (tops.maxOrNull() ?: 0f) - (tops.minOrNull() ?: 0f)
            assertTrue("Expanded sheet oscillated by $travel px; positions=$tops", travel <= 2f)
        }
    }

    @Test fun regionalPacksRemainStableWhenSwipingPastEnd() {
        val tops = mutableListOf<Float>()
        compose.setContent {
            var visible by remember { mutableStateOf(true) }
            MaterialTheme {
                if (visible) RegionalPacksSheet(
                    state = OfflineDatabaseState(ready = true),
                    downloads = RegionalPacksState(ready = true, packs = (1..12).map { index ->
                        RegionalPackDescriptor("region-$index", "Region $index", "https://example.org/pack.json",
                            1_000_000, "a".repeat(64), "2026-10-01T00:00:00Z", 100)
                    }),
                    offline = false, busy = false, message = null,
                    onRefresh = {}, onCancel = {}, onDownload = {}, onDismiss = { visible = false },
                    dragHandle = {
                        BottomSheetDefaults.DragHandle(Modifier.onGloballyPositioned { tops.add(it.positionInWindow().y) })
                    }
                )
            }
        }
        compose.waitForIdle()
        val content = compose.onNodeWithTag("regional-packs")
        compose.onNodeWithText("Region 12").assertDoesNotExist()
        repeat(8) { content.performTouchInput { swipeUp(durationMillis = 250) } }
        compose.onNodeWithText("Region 12").assertIsDisplayed()
        compose.runOnIdle {
            val settledTop = tops.last()
            tops.clear()
            tops.add(settledTop)
        }
        repeat(5) {
            content.performTouchInput { swipeUp(durationMillis = 80) }
            compose.waitForIdle()
        }
        compose.runOnIdle {
            val travel = (tops.maxOrNull() ?: 0f) - (tops.minOrNull() ?: 0f)
            assertTrue("Regional sheet oscillated by $travel px; positions=$tops", travel <= 2f)
        }
        val context = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext
        compose.onNodeWithText(context.getString(R.string.close)).performClick()
        content.assertDoesNotExist()
    }

    @Test fun downwardSwipeStillDismissesShortSheet() {
        compose.setContent {
            var visible by remember { mutableStateOf(true) }
            MaterialTheme {
                if (visible) VegsnapBottomSheet(onDismissRequest = { visible = false }) {
                    Column(Modifier.fillMaxWidth().height(320.dp).testTag("short-result")
                        .verticalScroll(rememberScrollState()).padding(24.dp)) {
                        Text("Short result")
                    }
                }
            }
        }
        compose.waitForIdle()
        compose.onNodeWithTag("short-result").performTouchInput { swipeDown(durationMillis = 150) }
        compose.waitForIdle()
        compose.onNodeWithTag("short-result").assertDoesNotExist()
    }
}
