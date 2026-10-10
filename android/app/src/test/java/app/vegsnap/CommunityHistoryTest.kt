package app.vegsnap

import java.time.Instant
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CommunityHistoryTest {
    private val reply = CommunityReply("12345678-1234-4234-8234-123456789abc", "Drink", "Maker", "SE", "", "Is it vegan?", "All our drinks are vegan.",
        "2026-01-10", "vegan", "whole_product", "2026-01-11T00:00:00Z", null, false, "barcode")
    private fun original() = JSONObject().put("id", "saved-check").put("checkedAt", "2026-01-01T00:00:00Z")
        .put("outcome", "uncertain").put("basis", "insufficient").put("title", "Drink").put("summary", "Unclear")
        .put("identity", JSONObject().put("name", "Drink").put("brand", "Maker").put("market", "SE"))
        .put("findings", JSONArray()).put("evidence", JSONArray()).put("warnings", JSONArray()).put("questions", JSONArray().put("Ask maker"))
        .put("schemaVersion", 1).put("category", "drink").put("crossContact", JSONArray()).put("companyConcerns", JSONArray()).put("usedAI", false)
    private fun entry(result: JSONObject) = HistoryEntry(result.getString("id"), result.getString("title"), result.getString("checkedAt"), result.toString())
    private fun apply(result: JSONObject, replies: List<CommunityReply> = listOf(reply)) =
        applyCommunityReplies(result, replies, "en", "https://community.example", Instant.parse("2026-01-12T00:00:00Z"))

    @Test fun `shared confirmation persists in history and survives reopening offline`() = runBlocking {
        val original = original()
        val history = MemoryHistory(entry(original))
        val updated = history.cacheCommunityResult(original, apply(original))!!
        val reopened = JSONObject(history.find(updated.id)!!.json)
        assertEquals("Drink", history.observe().value.single().title)
        assertEquals("Manufacturer says vegan", reopened.getString("title"))
        assertEquals(ResultClassification.MANUFACTURER, resultClassification(reopened.getString("outcome"), reopened.getString("basis")))
        assertEquals("vegan", reopened.getString("outcome"))
        assertEquals("manufacturer", reopened.getString("basis"))
        assertEquals(original.getString("checkedAt"), updated.checkedAt)
        assertEquals(reply.reply, reopened.getJSONArray("evidence").getJSONObject(0).getString("excerpt"))
        assertNull(history.cacheCommunityResult(reopened, apply(reopened)))

        history.cacheCommunityResult(reopened, apply(reopened, emptyList()))
        assertEquals("Drink", history.observe().value.single().title)
        val restored = JSONObject(history.find(updated.id)!!.json)
        assertEquals(ResultClassification.UNCERTAIN, resultClassification(restored.getString("outcome"), restored.getString("basis")))
        assertEquals(original.toString(), JSONObject(history.find(updated.id)!!.json).toString())
    }

    @Test fun `late lookup cannot overwrite corrected or rechecked results or recreate deleted history`() = runBlocking {
        val source = original()
        for (current in listOf(
            original().apply { getJSONObject("identity").put("market", "DE") },
            original().put("checkedAt", "2026-01-13T00:00:00Z"),
        )) {
            val saved = entry(current)
            val history = MemoryHistory(saved)
            assertNull(history.cacheCommunityResult(source, apply(source)))
            assertEquals(saved, history.find(saved.id))
        }
        val history = MemoryHistory(entry(source))
        history.delete(source.getString("id"))
        assertNull(history.cacheCommunityResult(source, apply(source)))
        assertTrue(history.observe().value.isEmpty())
    }

    @Test fun `history transfer exports original analysis so cached replies can refresh after import`() {
        val source = original()
        val imported = HistoryTransfer.parse(HistoryTransfer.export(listOf(entry(apply(source))))).single()
        val reopened = JSONObject(imported.json)
        assertEquals(source.toString(), reopened.toString())
        assertEquals(source.toString(), apply(reopened, emptyList()).toString())
        assertEquals(1, apply(reopened).getJSONArray("evidence").length())
        assertEquals("not_vegan", apply(reopened, listOf(reply.copy(claim = "not_vegan"))).getString("outcome"))
    }

    @Test fun `concurrent history changes between lookup and write are preserved`() = runBlocking {
        val source = original()
        val history = MemoryHistory(entry(source))
        val rechecked = entry(original().put("title", "New analysis"))
        history.beforeUpdate = { history.rows.value = listOf(rechecked) }
        assertNull(history.cacheCommunityResult(source, apply(source)))
        assertEquals(rechecked, history.find(rechecked.id))
        history.beforeUpdate = { history.rows.value = emptyList() }
        assertNull(history.cacheCommunityResult(JSONObject(rechecked.json), apply(JSONObject(rechecked.json))))
        assertTrue(history.observe().value.isEmpty())
    }

    private class MemoryHistory(entry: HistoryEntry) : HistoryDao {
        val rows = MutableStateFlow(listOf(entry))
        var beforeUpdate: () -> Unit = {}
        override fun observe() = rows
        override suspend fun ids() = rows.value.map { it.id }
        override suspend fun find(id: String) = rows.value.find { it.id == id }
        override suspend fun save(entry: HistoryEntry) { rows.value = rows.value.filter { it.id != entry.id } + entry }
        override suspend fun saveAll(entries: List<HistoryEntry>) { entries.forEach { save(it) } }
        override suspend fun delete(id: String) { rows.value = rows.value.filter { it.id != id } }
        override suspend fun clear() { rows.value = emptyList() }
        override suspend fun updateCommunityResult(id: String, json: String, expectedJson: String): Int {
            beforeUpdate()
            val saved = find(id)?.takeIf { it.json == expectedJson } ?: return 0
            save(saved.copy(json = json))
            return 1
        }
    }
}
