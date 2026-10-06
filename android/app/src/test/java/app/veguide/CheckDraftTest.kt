package app.veguide

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CheckDraftTest {
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
}
