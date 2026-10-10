package app.vegsnap

import org.json.JSONObject

/** A late lookup must never overwrite a recheck/country correction or recreate deleted history. */
internal suspend fun HistoryDao.cacheCommunityResult(source: JSONObject, result: JSONObject): HistoryEntry? {
    val saved = find(source.getString("id")) ?: return null
    if (JSONObject(saved.json).toString() != source.toString()) return null
    val updated = saved.copy(json = result.toString())
    if (updated == saved) return null
    return updated.takeIf { updateCommunityResult(it.id, it.json, saved.json) == 1 }
}
