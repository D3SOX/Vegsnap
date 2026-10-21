package app.vegsnap

import android.app.LocaleConfig
import android.content.res.Configuration
import android.os.Build
import android.os.LocaleList
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test

class AppLanguagesTest {
    @Test fun androidLanguagePickerDeclaresEnglishGermanAndSwedish() {
        assumeTrue(Build.VERSION.SDK_INT >= 33)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val config = LocaleConfig(context)
        assertEquals(LocaleConfig.STATUS_SUCCESS, config.status)
        assertEquals(setOf("en", "de", "sv"), config.supportedLocales!!.let { locales ->
            (0 until locales.size()).map { locales[it].language }.toSet()
        })
        val german = context.createConfigurationContext(Configuration(context.resources.configuration).apply {
            setLocales(LocaleList.forLanguageTags("de"))
        })
        assertEquals("Einstellungen", german.getString(R.string.settings))
        assertEquals("Standardkategorie", german.getString(R.string.default_category))
        val swedish = context.createConfigurationContext(Configuration(context.resources.configuration).apply {
            setLocales(LocaleList.forLanguageTags("sv"))
        })
        assertEquals("Inställningar", swedish.getString(R.string.settings))
        assertEquals("Standardkategori", swedish.getString(R.string.default_category))
    }
}
