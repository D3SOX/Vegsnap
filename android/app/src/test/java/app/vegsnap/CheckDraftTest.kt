package app.vegsnap

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CheckDraftTest {
    @Test fun detectedCountryNeverBecomesTheFallbackWhenRestoringACheck() {
        val result = org.json.JSONObject().put("identity", org.json.JSONObject().put("market", "SE").put("marketSource", "database"))
        val original = CheckInput(market = "DE", autoMarket = true)
        val restored = restoreCheckInput(result, original, "DE")
        assertEquals("DE", restored.market)
        assertEquals(null, restored.autoMarket)
        result.getJSONObject("identity").put("marketSource", "manual").put("market", "FI")
        val manual = restoreCheckInput(result, original, "DE")
        assertEquals("FI", manual.market)
        assertEquals(false, manual.autoMarket)
    }

    @Test fun `only inconclusive builtin barcode results offer AI escalation`() {
        val result = JSONObject().put("outcome", "uncertain").put("usedAI", false)
            .put("identity", JSONObject().put("barcode", "4006381333931"))
            .put("evidence", JSONArray().put(JSONObject().put("kind", "database")))
        assertTrue(canSendBarcodeToAI(result))
        for (outcome in listOf("vegan", "not_vegan")) {
            result.put("outcome", outcome)
            assertFalse(canSendBarcodeToAI(result))
        }
        result.put("outcome", "uncertain").put("usedAI", true)
        assertFalse(canSendBarcodeToAI(result))
        result.put("usedAI", false).getJSONObject("identity").put("barcode", "invalid")
        assertFalse(canSendBarcodeToAI(result))
        result.getJSONObject("identity").put("barcode", "4006381333931")
        result.put("evidence", JSONArray().put(JSONObject().put("kind", "user_text")))
        assertFalse(canSendBarcodeToAI(result))
    }

    @Test fun `original draft round trip keeps complete user input and selected category`() {
        val original = CheckInput("Wasser, Salz", "other", true, "Product", "4006381333931", "de", true)
        assertEquals(original, decodeDraftInput(encodeDraftInput(original)))
        assertNull(decodeDraftInput(encodeDraftInput(CheckInput())).complete)
    }

    @Test fun `recheck never presents discovered website or photo transcription as user supplied ingredients`() {
        val result = JSONObject().put("category", "drink")
            .put("identity", JSONObject().put("name", "Soy drink").put("barcode", "4006381333931"))
            .put("evidence", JSONArray()
                .put(JSONObject().put("kind", "ai_extraction").put("excerpt", "AI text"))
                .put(JSONObject().put("kind", "manufacturer").put("excerpt", "Website text"))
                .put(JSONObject().put("kind", "user_text").put("excerpt", "My original ingredients")))
        val draft = recheckInput(result)
        assertEquals("My original ingredients", draft.text)
        assertEquals("Soy drink", draft.name)
        assertEquals("4006381333931", draft.barcode)
        assertNull(draft.complete)
        result.put("evidence", JSONArray().put(JSONObject().put("kind", "ai_extraction").put("excerpt", "AI text")))
        assertEquals("", recheckInput(result).text)
    }

    @Test fun `camera check does not inherit edited manual identity`() {
        val manual = ScanState(name = "Previous product", barcode = "4006381333931", text = "milk", complete = true)
        val camera = manual.forCheck(photosOnly = true)
        assertEquals("", camera.name)
        assertEquals("", camera.barcode)
        assertEquals(manual, manual.forCheck(photosOnly = false))
    }
    @Test fun `selected market survives old drafts photo checks and rechecks`() {
        val input = CheckInput(market = "SE")
        assertEquals(input, decodeDraftInput(encodeDraftInput(input)))
        assertEquals("DE", decodeDraftInput(encodeDraftInput(input).apply { remove("market") }).market)
        assertEquals("SE", ScanState(market = "SE").forCheck(photosOnly = true).market)
        val result = JSONObject().put("category", "drink").put("identity", JSONObject().put("market", "SE"))
        assertEquals("SE", recheckInput(result).market)
        assertEquals("SE", extractionInputContext(input).getString("market"))
        assertEquals("en:sweden", productMarketTag("SE"))
    }
    @Test fun `restored manual countries normalize aliases and reject invalid imports before queueing`() {
        val original = CheckInput(market = "FI", autoMarket = false)
        val result = JSONObject().put("category", "food").put("identity", JSONObject().put("marketSource", "manual"))
        for (market in listOf("SE", "en:sweden", "sverige")) {
            result.getJSONObject("identity").put("market", market)
            val restored = restoreCheckInput(result, original, "DE")
            assertEquals("SE", restored.market)
            assertEquals(false, restored.autoMarket)
        }
        for (market in listOf("SWE", "ZZ", "unknown country", "")) {
            result.getJSONObject("identity").put("market", market)
            try { restoreCheckInput(result, original, "DE"); fail("Invalid manual country accepted") }
            catch (_: IllegalArgumentException) { }
        }
        result.getJSONObject("identity").remove("marketSource")
        assertEquals("SE", restoreCheckInput(result, original.copy(market = "en:sweden"), "DE").market)
        try { restoreCheckInput(result, original.copy(market = "SWE"), "DE"); fail("Invalid saved manual country accepted") }
        catch (_: IllegalArgumentException) { }
    }

}
