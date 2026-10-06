package app.veguide

import android.app.Application
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import android.os.LocaleList
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.After
import org.junit.Rule
import org.junit.Test
import java.io.File

/** Test-only fixture loading; all pixels come from the normal application UI. */
class MarketingScreenshotTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val store = ViewModelStore()

    @After fun cleanUp() { compose.runOnIdle { store.clear() } }

    @Test fun captureMarketingScreens() {
        val target = instrumentation.targetContext
        assumeTrue("Only run marketing captures with -PmarketingCapture", target.packageName == "app.veguide.screenshots")
        val dark = InstrumentationRegistry.getArguments().getString("screenshotTheme") == "dark"
        val configuration = Configuration(target.resources.configuration).apply {
            setLocales(LocaleList.forLanguageTags("en"))
            fontScale = 1f
            uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
                if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
        }
        val localized = target.createConfigurationContext(configuration)
        val fixtures = JSONObject(instrumentation.context.assets.open("fixtures.json").bufferedReader().use { it.readText() })
        val results = fixtures.getJSONArray("results")
        // Android stores the product name as title; extension results store the outcome title.
        for (i in 0 until results.length()) {
            val result = results.getJSONObject(i)
            result.put("title", result.getJSONObject("identity").getString("name"))
        }
        target.getSharedPreferences("onboarding", 0).edit().putBoolean("completed", true).commit()
        runBlocking {
            SettingsStore(target).save(AppSettings(offline = true, connection = "database", startTab = "manual"))
            ApplicationHistoryDatabase.get(target).history().apply {
                clear()
                saveAll((0..2).map { i ->
                    val r = results.getJSONObject(i)
                    HistoryEntry(r.getString("id"), r.getJSONObject("identity").getString("name"), r.getString("checkedAt"), r.toString())
                })
            }
        }
        lateinit var model: VeguideViewModel
        compose.runOnIdle {
            val bars = if (dark) SystemBarStyle.dark(AndroidColor.TRANSPARENT)
                else SystemBarStyle.light(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT)
            compose.activity.enableEdgeToEdge(statusBarStyle = bars, navigationBarStyle = bars)
            model = VeguideViewModel(target.applicationContext as Application)
            model.hasSharedInput = true
            store.put("marketing-capture", model)
        }
        compose.waitUntil(30_000) { model.settings.value.offline && model.settings.value.connection == "database" }
        compose.runOnIdle {
            model.selectTab("manual")
            val input = fixtures.getJSONObject("input")
            model.update { ScanState(name = input.getString("name"), text = input.getString("text"), category = input.getString("category"), complete = input.getBoolean("complete")) }
        }
        compose.setContent {
            CompositionLocalProvider(LocalContext provides localized, LocalConfiguration provides configuration, LocalResources provides localized.resources,
                LocalActivityResultRegistryOwner provides compose.activity) {
                VeguideApp(model)
            }
        }
        compose.waitUntil(30_000) { model.history.value.size == 3 }
        compose.onNodeWithText("Check product").assertIsDisplayed()
        capture("android-check")
        compose.runOnIdle { model.update { it.copy(result = null) }; model.selectTab("history") }
        compose.onNodeWithText("Honey granola").assertIsDisplayed()
        capture("android-history")
        for ((index, name) in listOf(1 to "android-result", 2 to "android-uncertain")) {
            compose.runOnIdle { model.update { it.copy(result = results.getJSONObject(index).toString()) } }
            compose.onNodeWithTag("result-sheet-content").assertIsDisplayed()
            compose.onNodeWithText("Share result").assertIsDisplayed()
            capture(name)
            compose.runOnIdle { model.update { it.copy(result = null) } }
            compose.waitForIdle()
        }
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        val directory = File(instrumentation.targetContext.filesDir, "marketing-screenshots").apply { mkdirs() }
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
