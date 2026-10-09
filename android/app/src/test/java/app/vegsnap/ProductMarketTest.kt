package app.vegsnap

import org.junit.Assert.assertEquals
import org.junit.Test

class ProductMarketTest {
    private val automatic = CheckInput(market = "DE", autoMarket = true)
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
}
