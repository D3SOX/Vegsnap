package app.vegsnap

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ModelCapabilitiesTest {
    @Test fun metadataOverridesFamilyAndUnknownModelsRemainEligibleForAnAttempt() {
        assertEquals(true, knownModelVisionSupport("gpt-5.6-luna"))
        assertEquals(false, knownModelVisionSupport("gpt-5.6-luna", JSONObject().put("supports_image_input", false)))
        assertEquals(true, knownModelVisionSupport("custom", JSONObject("""{"input_modalities":["text","image"]}""")))
        assertEquals(false, knownModelVisionSupport("custom", JSONObject("""{"architecture":{"input_modalities":["text"]}}""")))
        assertNull(knownModelVisionSupport("unknown-custom-model"))
        assertEquals(false, knownModelVisionSupport("openai/o3-mini"))
        assertEquals(true, knownModelVisionSupport("openai/o3"))
        assertEquals(false, knownModelVisionSupport("gpt-4-0613"))
        assertEquals(true, knownModelVisionSupport("gpt-4o"))
    }
    @Test fun selectedCatalogMetadataWinsAndManualModelChangeDoesNotReuseIt() {
        val settings = AppSettings(chatgptModel = "custom-model")
        val models = listOf(ChatGPTModel("custom-model", "Custom", false))
        assertEquals(false, modelVisionSupport(settings, models))
        assertEquals(true, modelVisionSupport(settings.copy(chatgptModel = "gpt-5.6-luna"), models))
        assertNull(modelVisionSupport(settings.copy(connection = "api", model = "unknown"), models))
    }
}
