package app.vegsnap

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Locale

class ProductMarketTest {
    private val automatic = CheckInput(market = "DE", autoMarket = true)
    @Test fun `imported country values display safely without constructing invalid locales`() {
        for (value in listOf("SE", "en:sweden", "sverige")) assertEquals("Sweden", productCountryName(value, Locale.ENGLISH))
        for (value in listOf("SWE", "unknown country", "ZZ", "")) assertEquals(value, productCountryName(value, Locale.ENGLISH))
    }
    @Test fun `pack regions read as localized country names, keeping unknown regions verbatim`() {
        assertEquals(listOf("United Kingdom", "Switzerland", "European Union", "Germany + European Union", "fixture"),
            listOf("united-kingdom", "switzerland", "eu", "de-eu", "fixture").map { packRegionName(it, Locale.ENGLISH) })
        assertEquals("Vereinigte Staaten", packRegionName("united-states", Locale.GERMAN))
    }
    @Test fun `canonical Open Facts tags match ISO countries despite system name differences`() {
        for ((country, tag) in mapOf("CZ" to "czech-republic", "TR" to "turkey", "HK" to "hong-kong", "BA" to "bosnia-and-herzegovina", "RE" to "reunion", "CI" to "cote-d-ivoire", "AX" to "aland-islands", "CD" to "democratic-republic-of-the-congo")) {
            assertEquals(country, productCountryCode("en:$tag"))
            assertEquals(country to "database", selectProductCountry(automatic, markets = listOf("en:$tag")))
        }
    }
    @Test fun `explicit packaging and one database country can select a country`() {
        assertEquals("SE" to "packaging", selectProductCountry(automatic, "Sweden"))
        assertEquals("SE" to "database", selectProductCountry(automatic, markets = listOf("en:sweden", "SE")))
        assertEquals("SE" to "packaging", selectProductCountry(automatic, "SE", listOf("en:germany", "en:sweden")))
        assertEquals("JP" to "database", selectProductCountry(automatic, markets = listOf("en:japan")))
    }
    @Test fun `ambiguous conflicting and unsupported clues use the fallback`() {
        for ((packaging, markets) in listOf(null to emptyList(), null to listOf("en:germany", "en:sweden"), "Swedish" to emptyList(), "Made in Sweden" to emptyList(), "SE" to listOf("en:germany"), null to listOf("en:sweden", "unknown"))) {
            assertEquals("DE" to "fallback", selectProductCountry(automatic, packaging, markets))
        }
    }
    @Test fun `manual choice takes precedence`() {
        assertEquals("FI" to "manual", selectProductCountry(automatic.copy(market = "FI", autoMarket = false), "SE", listOf("en:sweden")))
    }
    @Test fun `country flags use regional indicators and stay empty for unknown codes`() {
        assertEquals("🇸🇪", countryFlag("SE"))
        assertEquals("🇩🇪", countryFlag("de"))
        assertEquals("🇸🇪", countryFlag("en:sweden"))
        for (value in listOf("ZZ", "SWE", "")) assertEquals("", countryFlag(value))
    }
}
