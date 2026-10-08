package app.vegsnap

import android.app.Application
import android.content.pm.ActivityInfo
import androidx.activity.ComponentActivity
import android.content.res.Configuration
import android.graphics.Bitmap
import android.os.LocaleList
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.unit.Density
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import java.io.File

@OptIn(ExperimentalMaterial3Api::class)
class ResultDetailsSheetTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val store = ViewModelStore()
    private val tops = mutableListOf<Float>()
    private val displayedResult = mutableStateOf(JSONObject())
    private var rechecks = 0

    @After fun cleanUp() {
        compose.runOnIdle { store.clear() }
    }

    private fun result(concerns: Boolean = true) = JSONObject()
        .put("id", "synthetic-result-tabs").put("title", "Synthetic ingredient regression")
        .put("outcome", "uncertain").put("basis", "composition")
        .put("summary", "The complete composition needs a source confirmation.")
        .put("checkedAt", "2026-10-06T00:00:00Z").put("category", "household")
        .put("identity", JSONObject().put("brand", "Fixture Maker"))
        .put("findings", JSONArray().apply { repeat(80) { index ->
            put(JSONObject().put("term", "Ingredient ${index + 1}").put("status", listOf("plant", "animal", "ambiguous", "unknown")[index % 4])
                .put("explanation", "A synthetic ingredient used to verify continuous long-result scrolling and section navigation."))
        } })
        .put("evidence", JSONArray().put(JSONObject().put("title", "Fixture source")
            .put("excerpt", "Synthetic source evidence is visible in the Sources section.")
            .put("retrievedAt", "2026-10-06T00:00:00Z")))
        .put("companyConcerns", JSONArray().apply { if (concerns) {
            put(JSONObject().put("company", "Fixture Maker").put("category", "animal_testing")
                .put("status", "current").put("scope", "direct")
                .put("description", "A synthetic documented company concern."))
            put(JSONObject().put("company", "Fixture Maker").put("category", "animal_exploitation")
                .put("status", "current").put("scope", "direct")
                .put("description", "A second synthetic documented company concern."))
        } })

    private fun show(value: JSONObject, language: String = "en", fontScale: Float = 1f, dark: Boolean = false) {
        if (InstrumentationRegistry.getArguments().getString("orientation") == "landscape") {
            compose.activityRule.scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
            compose.waitUntil(5_000) { compose.activity.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE }
        }
        val target = instrumentation.targetContext
        val configuration = Configuration(target.resources.configuration).apply {
            setLocales(LocaleList.forLanguageTags(language))
            this.fontScale = fontScale
        }
        val localized = target.createConfigurationContext(configuration)
        lateinit var model: VegsnapViewModel
        compose.runOnIdle {
            model = VegsnapViewModel(target.applicationContext as Application)
            store.put("result-ui-test", model)
        }
        displayedResult.value = value
        compose.setContent {
            val density = LocalDensity.current.density
            CompositionLocalProvider(LocalContext provides localized, LocalConfiguration provides configuration,
                LocalResources provides localized.resources, LocalDensity provides Density(density, fontScale)) {
                MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme()) {
                    Box(Modifier.fillMaxSize()) {
                        VegsnapBottomSheet(onDismissRequest = {}, dragHandle = {
                            BottomSheetDefaults.DragHandle(Modifier.onGloballyPositioned { tops.add(it.positionInWindow().y) })
                        }) {
                            CompositionLocalProvider(LocalContext provides localized, LocalConfiguration provides configuration,
                                LocalResources provides localized.resources, LocalDensity provides Density(density, fontScale)) {
                                ResultSheet(displayedResult.value, {}, { rechecks++ }, {}, model)
                            }
                        }
                    }
                }
            }
        }
        compose.waitForIdle()
    }

    private fun actions(language: String = "en") {
        val context = instrumentation.targetContext.createConfigurationContext(
            Configuration(instrumentation.targetContext.resources.configuration).apply {
                setLocales(LocaleList.forLanguageTags(language))
            })
        for (label in listOf(R.string.recheck, R.string.edit_result)) {
            compose.onNodeWithText(context.getString(label)).assertIsDisplayed().assertHasClickAction()
        }
        for (label in listOf(R.string.copy_result, R.string.close)) {
            compose.onNodeWithContentDescription(context.getString(label)).assertIsDisplayed().assertHasClickAction()
        }
    }

    private fun screenshot(name: String) {
        val file = File(instrumentation.targetContext.cacheDir, name)
        file.outputStream().use { output ->
            compose.onNodeWithTag("result-sheet-content").captureToImage().asAndroidBitmap()
                .compress(Bitmap.CompressFormat.PNG, 100, output)
        }
    }

    private fun nav(section: String) = compose.onNodeWithTag("result-nav-$section")
    private fun heading(section: String) = compose.onNodeWithTag("result-section-$section")

    private fun assertAnchored(section: String) {
        heading(section).assertIsDisplayed()
        nav(section).assertIsSelected()
        val difference = heading(section).fetchSemanticsNode().layoutInfo.coordinates.positionInRoot().y -
            compose.onNodeWithTag("result-details-scroll").fetchSemanticsNode().layoutInfo.coordinates.positionInRoot().y
        assertTrue("$section heading was not anchored: $difference px", difference in -1f..32f)
    }

    @Test fun inconclusiveBuiltinBarcodeOffersAiFromTheSharedResultSheet() {
        val original = result().put("usedAI", false)
        original.getJSONObject("identity").put("barcode", "4006381333931")
        original.getJSONArray("evidence").getJSONObject(0).put("kind", "database")
        show(original, language = "de", fontScale = 1.5f, dark = true)
        val send = compose.onNodeWithText("An KI senden")
        send.assertIsDisplayed().assertHasClickAction().performClick()
        compose.runOnIdle { assertEquals(1, rechecks) }
        screenshot("barcode-send-to-ai-de-large.png")
        compose.runOnIdle { displayedResult.value = JSONObject(original.toString()).put("usedAI", true) }
        compose.onNodeWithText("An KI senden").assertDoesNotExist()
        actions("de")
        compose.runOnIdle { displayedResult.value = JSONObject(original.toString()).put("outcome", "not_vegan") }
        compose.onNodeWithText("An KI senden").assertDoesNotExist()
        actions("de")
    }

    @Test fun savedManufacturerSourceWithoutContactStillOffersADraft() {
        val saved = result(concerns = false)
            .put("findings", JSONArray().put(JSONObject().put("term", "vitamin D").put("status", "ambiguous")
                .put("explanation", "Confirm its origin.")))
            .put("identity", JSONObject().put("name", "Oat drink").put("brand", "Fixture Maker").put("barcode", "4006381333931"))
            .put("evidence", JSONArray().put(JSONObject().put("title", "Manufacturer composition (AI)")
                .put("url", "https://maker.example/product").put("excerpt", "vitamin D")
                .put("retrievedAt", "2026-10-06T00:00:00Z")))
        show(saved, dark = true)
        compose.onNodeWithTag("result-details-scroll").performScrollToNode(hasText("Ask the manufacturer"))
        compose.onNodeWithText("Ask the manufacturer").assertIsDisplayed()
        compose.onNodeWithTag("result-details-scroll").performScrollToNode(hasText("Copy message"))
        compose.onNodeWithText("Copy message").assertIsDisplayed().assertHasClickAction()
        compose.onNodeWithText("Open in email app").assertDoesNotExist()
        compose.onNodeWithText("Open contact page").assertDoesNotExist()
        compose.onNodeWithText("Review contact source").assertDoesNotExist()
        compose.onNodeWithText("Review message").performClick()
        compose.onNodeWithTag("result-details-scroll").performScrollToNode(hasText("Vegan suitability question: Fixture Maker Oat drink"))
        compose.onNodeWithText("Vegan suitability question: Fixture Maker Oat drink").assertIsDisplayed()
        compose.onNodeWithText("4006381333931", substring = true).assertExists()
    }

    @Test fun manufacturerDraftWithoutContactsRemainsReachableInGermanWithLargeText() {
        show(result(concerns = false).put("findings", JSONArray()).put("evidence", JSONArray()), language = "de", fontScale = 1.6f)
        compose.onNodeWithTag("result-details-scroll").performScrollToNode(hasText("Nachricht kopieren"))
        compose.onNodeWithText("Nachricht kopieren").assertIsDisplayed().assertHasClickAction()
        compose.onNodeWithText("Nachricht prüfen").performClick()
        compose.onNodeWithText("Frage zur veganen Eignung: Fixture Maker").assertExists()
        compose.onNodeWithText("Frage zur veganen Eignung: Fixture Maker").performScrollTo().assertIsDisplayed()
        actions("de")
    }

    @Test fun inlineDraftLanguageChangesPreviewAndCopiedMessageWithoutChangingAppLanguage() {
        val saved = result(concerns = false).put("title", "Hand cream").put("evidence", JSONArray())
            .put("findings", JSONArray().put(JSONObject().put("term", "glycerol").put("status", "ambiguous").put("explanation", "Confirm its origin.")))
            .put("questions", JSONArray().put("Confirm the source of the ambiguous or unrecognized ingredients/materials.").put("Confirm the origin of: glycerol."))
        saved.getJSONObject("identity").put("name", "Hand cream")
        show(saved, dark = true)
        val scroll = compose.onNodeWithTag("result-details-scroll")
        scroll.performScrollToNode(hasText("Message language: English"))
        compose.onNodeWithText("Message language: English").performClick()
        compose.onNodeWithText("Svenska").performClick()
        compose.onNodeWithText("Fråga om produkten är vegansk: Fixture Maker Hand cream").assertExists()
        scroll.performScrollToNode(hasText("Copy message"))
        compose.onNodeWithText("Copy message").performClick()
        compose.runOnIdle {
            val clipboard = instrumentation.targetContext.getSystemService(android.content.ClipboardManager::class.java)
            val copied = clipboard.primaryClip!!.getItemAt(0).text.toString()
            assertTrue(copied.startsWith("Fråga om produkten är vegansk:"))
            assertTrue(copied.contains("Hej,"))
            assertTrue(copied.contains("Bekräfta ursprunget för: glycerol."))
            assertEquals(1, Regex("glycerol").findAll(copied).count())
        }
        scroll.performScrollToNode(hasText("Message language: Svenska"))
        compose.onNodeWithText("Message language: Svenska").performClick()
        compose.onNodeWithText("Deutsch").performClick()
        compose.onNodeWithText("Frage zur veganen Eignung: Fixture Maker Hand cream").assertExists()
        actions()
    }

    @Test fun continuousScrollAndSectionAnchorsKeepActionsReachableWithoutSheetOscillation() {
        show(result(), dark = true)
        actions()
        compose.onNodeWithText("Synthetic ingredient regression").assertIsDisplayed()
        nav("ingredients").assertIsSelected()
        nav("concerns").assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "2 company concerns"))
        nav("ingredients").performClick()
        assertAnchored("ingredients")
        val context = instrumentation.targetContext
        listOf(R.string.ingredient_status_vegan, R.string.ingredient_status_animal,
            R.string.ingredient_status_ambiguous, R.string.ingredient_status_unknown).forEach { description ->
            compose.onNodeWithTag("result-details-scroll").performScrollToNode(hasContentDescription(context.getString(description)))
            compose.onAllNodesWithContentDescription(context.getString(description)).onFirst().assertIsDisplayed()
        }
        val scroll = compose.onNodeWithTag("result-details-scroll")
        scroll.performScrollToNode(hasText("Ingredient 80"))
        compose.onNodeWithText("Ingredient 80").assertIsDisplayed()
        nav("ingredients").assertIsSelected()
        actions()
        // Manual scrolling reaches every section; navigation reflects it without
        // replacing the preceding ingredients or swapping scroll containers.
        scroll.performScrollToNode(hasTestTag("result-section-sources"))
        compose.onNodeWithText("Ingredient 80").assertIsDisplayed()
        nav("sources").performClick()
        assertAnchored("sources")
        compose.onNodeWithText("Fixture source").assertIsDisplayed()
        actions()
        screenshot("result-sections-sources-en.png")
        scroll.performTouchInput { swipeUp(durationMillis = 400) }
        compose.waitForIdle()
        nav("concerns").assertIsSelected()
        nav("concerns").performClick()
        assertAnchored("concerns")
        compose.onNodeWithText("A synthetic documented company concern.").assertIsDisplayed()
        actions()
        screenshot("result-sections-concerns-en.png")
        compose.runOnIdle { val top = tops.last(); tops.clear(); tops.add(top) }
        repeat(5) { scroll.performTouchInput { swipeUp(durationMillis = 80) }; compose.waitForIdle() }
        compose.runOnIdle {
            val travel = tops.maxOrNull()!! - tops.minOrNull()!!
            assertTrue("Expanded result sheet oscillated by $travel px", travel <= 2f)
        }
        nav("ingredients").performClick()
        assertAnchored("ingredients")
        compose.onNodeWithText("Ingredient 1").assertIsDisplayed()
        actions()
        screenshot("result-sections-ingredients-en.png")
        compose.runOnIdle { displayedResult.value = result().put("id", "new-synthetic-result").put("title", "Fresh result") }
        compose.onNodeWithText("Fresh result").assertIsDisplayed()
        nav("ingredients").assertIsSelected()
    }

    @Test fun shortEmptyConcernSectionAnchorsWithoutAWarningBadge() {
        show(result(concerns = false).put("findings", JSONArray()).put("evidence", JSONArray()))
        nav("concerns").assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "0 company concerns"))
        compose.onNodeWithText("2", useUnmergedTree = true).assertDoesNotExist()
        nav("concerns").performClick()
        assertAnchored("concerns")
        actions()
        nav("sources").performClick()
        assertAnchored("sources")
        nav("ingredients").performClick()
        assertAnchored("ingredients")
    }

    @Test fun germanLargeTextKeepsActionsAndSectionNavigationAvailable() {
        show(result(concerns = false), language = "de", fontScale = 1.6f)
        actions("de")
        val scroll = compose.onNodeWithTag("result-details-scroll")
        scroll.performScrollToNode(hasText("Ingredient 80"))
        nav("ingredients").assertIsDisplayed()
        nav("sources").performClick()
        assertAnchored("sources")
        actions("de")
        nav("concerns").performClick()
        assertAnchored("concerns")
        nav("concerns").assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "0 Unternehmensbedenken"))
        actions("de")
        screenshot("result-sections-de-large.png")
    }
}
