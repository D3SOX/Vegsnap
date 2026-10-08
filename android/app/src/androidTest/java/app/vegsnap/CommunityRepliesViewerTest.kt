package app.vegsnap

import android.graphics.Bitmap
import android.content.ContextWrapper
import android.content.Intent
import android.os.Bundle
import android.content.res.Configuration
import android.os.LocaleList
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.*
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.awaitCancellation
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.Before
import org.junit.After

class CommunityRepliesViewerTest {
    @get:Rule val compose = createComposeRule()
    @Before fun resetBlocks() { HiddenCommunityReplies(InstrumentationRegistry.getInstrumentation().targetContext).clear() }
    @After fun cleanBlocks() { resetBlocks() }
    private val result = JSONObject().put("identity", JSONObject().put("name", "Oat drink").put("brand", "Maker").put("market", "SE"))
        .put("outcome", "uncertain").put("photos", "private-photo")
    private val links = CommunityLinks("https://community.example/submit#name=Oat+drink", "https://community.example/replies#name=Oat+drink")
    private val reply = CommunityReply("12345678-1234-4234-8234-123456789abc", "Oat drink", "Maker", "SE", "Vanilla 1 L",
        "Is the vitamin D plant derived?", "The vitamin D is plant derived.\nOther ingredients were not checked.",
        "2026-01-10", "vegan", "ingredients", "2026-01-11T12:00:00Z", "https://maker.example/contact", false)

    private fun show(offline: State<Boolean> = mutableStateOf(false), dark: Boolean = false, fontScale: Float = 1f,
        open: (String) -> Unit = {}, load: suspend (CommunityLookup) -> CommunityReplyPage) {
        compose.setContent {
            val context = LocalContext.current
            val configuration = LocalConfiguration.current
            val english = remember(context, configuration) { context.createConfigurationContext(Configuration(configuration).apply {
                setLocales(LocaleList.forLanguageTags("en"))
            }) }
            CompositionLocalProvider(LocalContext provides english, LocalDensity provides Density(LocalDensity.current.density, fontScale)) {
                MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme()) {
                    Surface {
                        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp).testTag("community-scroll")) {
                            CommunityRepliesViewer(result, offline.value, links, load, open)
                        }
                    }
                }
            }
        }
    }
    private fun capture(name: String) {
        if (InstrumentationRegistry.getArguments().getString("captureCommunityReplies") != "true") return
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.cacheDir, "community-$name.png").outputStream().use { stream ->
            compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, stream)
        }
    }
    private fun click(text: String) = compose.onNodeWithText(text).performScrollTo().performClick()

    @Test fun nativeViewerLoadsOnlyOnRequestAndShowsScopeAndOriginalText() {
        var requests = 0
        val before = result.toString()
        val opened = mutableListOf<String>()
        show(open = { opened.add(it) }) { lookup ->
            requests++
            assertEquals(CommunityLookup("Oat drink", "Maker", "", "SE"), lookup)
            CommunityReplyPage(listOf(reply), true)
        }
        compose.runOnIdle { assertEquals(0, requests) }
        click("View shared replies")
        compose.onNodeWithText("Specific ingredients or materials").assertExists()
        compose.onNodeWithText("Vanilla 1 L").assertExists()
        click("Read reply")
        compose.onNodeWithText(reply.question).assertExists()
        compose.onNodeWithText(reply.reply).performScrollTo().assertIsDisplayed()
        capture("light")
        compose.onNodeWithText("Evidence reviewed privately.").assertExists()
        compose.onNodeWithText("Download reviewed evidence").assertDoesNotExist()
        click("Manufacturer source")
        compose.runOnIdle { assertEquals(listOf(reply.sourceUrl), opened); assertEquals(before, result.toString()) }
        click("Open community website")
        compose.runOnIdle { assertTrue(opened.last().contains("market=SE")); assertTrue(opened.last().contains("brand=Maker")) }
    }
    @Test fun missingIdentityCanBeCompletedWithoutChangingTheResult() {
        result.getJSONObject("identity").remove("brand")
        val before = result.toString()
        var requests = 0
        show { requests++; assertEquals("Maker", it.brand); CommunityReplyPage(emptyList(), false) }
        click("View shared replies")
        compose.onNodeWithText("Enter a two-letter country code and a valid barcode, or the exact product name and brand.").assertExists()
        compose.runOnIdle { assertEquals(0, requests) }
        compose.onNode(hasSetTextAction() and hasText("Brand")).performScrollTo().performTextInput("Maker")
        click("Find replies")
        compose.onNodeWithText("No reviewed replies were found for this product and market.").assertExists()
        compose.runOnIdle { assertEquals(1, requests); assertEquals(before, result.toString()) }
    }
    @Test fun loadingFailureCanBeRetriedWithoutLeavingTheApp() {
        var requests = 0
        show { if (++requests == 1) throw java.io.IOException("offline") else CommunityReplyPage(emptyList(), false) }
        click("View shared replies")
        compose.onNodeWithText("Could not load replies. Check your connection and try again.").assertExists()
        click("Find replies")
        compose.onNodeWithText("No reviewed replies were found for this product and market.").assertExists()
        compose.runOnIdle { assertEquals(2, requests) }
    }
    @Test fun goingOfflineCancelsLoadingAndDisablesSharing() {
        val offline = mutableStateOf(false)
        var cancelled = false
        show(offline = offline) { try { awaitCancellation() } finally { cancelled = true } }
        click("View shared replies")
        compose.onNodeWithText("Loading replies…").assertExists()
        compose.runOnIdle { offline.value = true }
        compose.onNodeWithText("Go online to share or view community replies.").assertExists()
        compose.onNodeWithText("Share a reply").assertIsNotEnabled()
        compose.onNodeWithText("Loading replies…").assertDoesNotExist()
        compose.runOnIdle { assertTrue(cancelled) }
    }
    @Test fun productionSharingLaunchesACustomTabWithOnlyProductIdentity() {
        var launched: Intent? = null
        compose.setContent {
            val context = LocalContext.current
            val configuration = LocalConfiguration.current
            val capture = remember(context, configuration) {
                object : ContextWrapper(context.createConfigurationContext(Configuration(configuration).apply {
                    setLocales(LocaleList.forLanguageTags("en"))
                })) {
                    override fun startActivity(intent: Intent, options: Bundle?) { launched = intent }
                }
            }
            CompositionLocalProvider(LocalContext provides capture) {
                MaterialTheme {
                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
                        CommunityRepliesSection(result, false)
                    }
                }
            }
        }
        click("Share a reply")
        compose.runOnIdle {
            val intent = requireNotNull(launched)
            assertEquals(Intent.ACTION_VIEW, intent.action)
            assertTrue(intent.hasExtra("android.support.customtabs.extra.SESSION"))
            assertEquals("/submit", intent.data!!.path)
            assertNull(intent.data!!.query)
            assertTrue(intent.data!!.fragment!!.contains("name=Oat+drink"))
            assertFalse(intent.data.toString().contains("private-photo"))
        }
    }
    @Test fun sharingUsesThePrefilledHostedForm() {
        val opened = mutableListOf<String>()
        show(open = { opened.add(it) }) { fail("Sharing must not fetch replies"); CommunityReplyPage(emptyList(), false) }
        click("Share a reply")
        compose.runOnIdle { assertEquals(listOf(links.submit), opened) }
    }
    @Test fun blockedRepliesPersistLocallyAndCanBeRestored() {
        show { CommunityReplyPage(listOf(reply), false) }
        click("View shared replies")
        click("Block this reply")
        compose.onNodeWithText("Maker · Oat drink").assertDoesNotExist()
        compose.runOnIdle {
            assertTrue(reply.id in HiddenCommunityReplies(InstrumentationRegistry.getInstrumentation().targetContext).ids())
        }
        click("Restore blocked replies")
        compose.onNodeWithText("Maker · Oat drink").assertExists()
    }
    @Test fun darkViewerWithLargeTextCanReadAndCloseReplies() {
        show(dark = true, fontScale = 2f) { CommunityReplyPage(listOf(reply.copy(evidencePublic = true)), false) }
        click("View shared replies")
        click("Read reply")
        compose.onNodeWithText(reply.reply).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Download reviewed evidence").performScrollTo().assertIsDisplayed()
        capture("dark-large-text")
        click("Hide shared replies")
        compose.onNodeWithText(reply.reply).assertDoesNotExist()
    }
}
