package dev.aispace.android.live

import dev.aispace.android.core.Json
import dev.aispace.android.core.ModelPreferences
import dev.aispace.android.core.SpaceApi
import dev.aispace.android.core.SpaceApiError
import dev.aispace.android.core.SpaceSettings
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import java.nio.charset.StandardCharsets

/**
 * The Space's own settings as the Settings page shows them, read with the Space's session. Nothing is
 * kept: they are a claim about now, asked again each time the page comes up.
 */
class SettingsLoader(private val api: SpaceApi, @Suppress("unused") private val scope: CoroutineScope) {
    private val settingsState = MutableStateFlow<SpaceSettings?>(null)
    val settings: StateFlow<SpaceSettings?> = settingsState.asStateFlow()
    private val loadingState = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = loadingState.asStateFlow()
    private val savingState = MutableStateFlow(false)
    val isSaving: StateFlow<Boolean> = savingState.asStateFlow()

    /** Why the last change was not taken, until the next one is. */
    private val saveErrorState = MutableStateFlow<String?>(null)
    val saveError: StateFlow<String?> = saveErrorState.asStateFlow()

    suspend fun refresh() {
        if (loadingState.value) return
        loadingState.value = true
        try {
            val (s, b, m) = coroutineScope {
                val services = async { text("/api/services") }
                val backups = async { text("/api/backups") }
                val models = async { text("/api/model/preferences") }
                Triple(services.await(), backups.await(), models.await())
            }
            // No route answered (signed out, offline): what was shown is no longer known.
            settingsState.value = if (s == null && b == null && m == null) null else SpaceSettings.decode(s, b, m)
        } finally {
            loadingState.value = false
        }
    }

    private suspend fun text(path: String): String? = try {
        String(api.data(path), StandardCharsets.UTF_8)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }

    /**
     * Sets the Space's default model, or returns it to the environment's defaults with null. This
     * changes the Space for every client, as the same menu on the panel does.
     */
    suspend fun setDefaultModel(value: String?) {
        if (savingState.value) return
        savingState.value = true
        try {
            val answer = api.send("PUT", "/api/model/preferences", JSONObject().put("defaultModel", value ?: JSONObject.NULL))
            Json.obj(answer)?.let { ModelPreferences.from(it) }?.let { fresh ->
                settingsState.value = settingsState.value?.copy(models = fresh)
            }
            saveErrorState.value = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: SpaceApiError.Http) {
            saveErrorState.value = "HTTP ${e.code} ${e.msg}"
        } catch (e: Exception) {
            saveErrorState.value = e.localizedMessage ?: e.toString()
        } finally {
            savingState.value = false
        }
    }

    fun forget() {
        saveErrorState.value = null
        settingsState.value = null
    }
}
