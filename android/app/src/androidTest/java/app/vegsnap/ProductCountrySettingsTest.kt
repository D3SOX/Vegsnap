package app.vegsnap

import android.app.Application
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.first
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

class ProductCountrySettingsTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val models = ViewModelStore()
    @After fun cleanup() { compose.runOnIdle { models.clear() } }

    @Test fun fallbackAndDetectionSettingsPersistWhileManualProductChoiceWins() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val target = instrumentation.targetContext
        target.getSharedPreferences("onboarding", 0).edit().putBoolean("completed", true).commit()
        runBlocking { SettingsStore(target).save(AppSettings(offline = true, connection = "database", fallbackCountry = "SE")) }
        lateinit var model: VegsnapViewModel
        compose.runOnIdle {
            model = VegsnapViewModel(target.applicationContext as Application)
            model.hasSharedInput = true
            models.put("country-settings", model)
        }
        compose.waitUntil(30_000) { model.settings.value.offline && model.state.value.market == "SE" }
        compose.runOnIdle { model.selectTab("settings") }
        compose.setContent { VegsnapApp(model) }
        compose.onNodeWithText("Detect product country automatically").performScrollTo().assertIsOn()
        compose.onNodeWithText("Product country: Sweden (SE)").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(target.getString(R.string.auto_product_country_hint)).performScrollTo()
        if (InstrumentationRegistry.getArguments().getString("captureCountrySettings") == "true") {
            val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
            File(target.cacheDir, "product-country-settings.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
        compose.onNodeWithText("Detect product country automatically").performScrollTo().performClick()
        compose.waitUntil { !model.settings.value.autoCountry }
        compose.onNodeWithText("Product country: Sweden (SE)").performScrollTo().performClick()
        compose.onNode(hasSetTextAction()).performTextReplacement("FI")
        compose.onNodeWithText("Save country").performClick()
        compose.waitUntil { model.settings.value.fallbackCountry == "FI" && model.state.value.market == "FI" }
        compose.runOnIdle { model.setProductMarket("SE") }
        runBlocking { model.updateSettings { it.copy(fallbackCountry = "NO", autoCountry = true) }.join() }
        assertEquals("SE", model.state.value.market)
        assertEquals(false, model.state.value.autoMarket)
        val restored = runBlocking { SettingsStore(target).flow.first() }
        assertTrue(restored.autoCountry)
        assertEquals("NO", restored.fallbackCountry)
    }
}
