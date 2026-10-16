package dev.aispace.android.live

import dev.aispace.android.core.Catalogue
import dev.aispace.android.core.CatalogueCache
import dev.aispace.android.core.CatalogueError
import dev.aispace.android.core.CataloguePayload
import dev.aispace.android.core.Connection
import dev.aispace.android.core.CookieSource
import dev.aispace.android.core.SpaceApi
import dev.aispace.android.core.SpaceApiError
import dev.aispace.android.core.SpaceCheck
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.nio.charset.StandardCharsets
import java.time.Instant

/** Where a Space's catalogue stands. */
sealed class LoaderStatus {
    data object Loading : LoaderStatus()
    data object Ok : LoaderStatus()
    data object SignInNeeded : LoaderStatus()
    data class Unreachable(val message: String) : LoaderStatus()
    data class Incompatible(val message: String) : LoaderStatus()
}

/**
 * The catalogue of one saved Space, read from the Space's own panel routes with the cookies of that
 * Space's web profile. It says plainly where it stands: a sign-in is needed, the Space cannot be
 * reached, or the address is not ai-space; the last known catalogue stays on show, marked as such,
 * while it cannot be refreshed.
 *
 * State is changed on the caller's thread (the main thread in the app); only decoding runs elsewhere.
 */
class CatalogueLoader(
    val connection: Connection,
    private val cache: CatalogueCache,
    cookies: CookieSource,
    private val scope: CoroutineScope,
    /** Reads one route of the Space; the API's own call unless a test supplies the answers. */
    fetch: (suspend (String) -> String)? = null,
) {
    val api: SpaceApi = SpaceApi(connection.url, cookies)
    private val fetch: suspend (String) -> String =
        fetch ?: { path -> String(api.data(path), StandardCharsets.UTF_8) }

    private val statusState = MutableStateFlow<LoaderStatus>(LoaderStatus.Loading)
    val status: StateFlow<LoaderStatus> = statusState.asStateFlow()
    private val catalogueState = MutableStateFlow<Catalogue?>(null)
    val catalogue: StateFlow<Catalogue?> = catalogueState.asStateFlow()

    /**
     * True while the catalogue on show is not the latest refresh's answer: the saved one of an earlier
     * launch, or this launch's while the Space has stopped answering since.
     */
    private val lastKnownState = MutableStateFlow(false)
    val isLastKnown: StateFlow<Boolean> = lastKnownState.asStateFlow()

    /** Not observed by views: a refresh changes it twice and nothing on screen depends on it. */
    var isRefreshing: Boolean = false
        private set
    var onCatalogue: (Catalogue) -> Unit = {}

    /** Counts the sign-outs; see [forget]. */
    private var session = 0

    init {
        cache.load(connection.id)?.let { saved ->
            runCatching { Catalogue.decode(saved) }.getOrNull()?.let {
                catalogueState.value = it
                lastKnownState.value = true
            }
        }
    }

    suspend fun refresh() {
        if (isRefreshing) return
        isRefreshing = true
        // An answer counts only for the session that asked: forget() moves on to the next one.
        val session = this.session
        val outcome: LoaderStatus = try {
            val payload = coroutineScope {
                val apps = async { fetch("/api/apps") }
                val agents = async { fetch("/api/agents") }
                val widgets = async { fetch("/api/widgets") }
                // A Space without peers, screens or a router still has a catalogue.
                val peers = async { optional("/api/peers") }
                val layout = async { optional(SpaceCheck.path) }
                val router = async { optional("/api/router") }
                // Milliseconds, as the cache writes it, so a catalogue read back equals the one shown.
                CataloguePayload(
                    apps = apps.await(), agents = agents.await(), widgets = widgets.await(),
                    peers = peers.await(), layout = layout.await(), router = router.await(), fetchedAt = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.MILLIS),
                )
            }
            // Parsing widget blocks can be substantial; it does not run on the main thread (75233d0).
            val fresh = withContext(Dispatchers.Default) { Catalogue.decode(payload) }
            currentCoroutineContext().ensureActive()
            if (session != this.session) return
            cache.saveInBackground(payload, connection.id)
            catalogueState.value = fresh
            LoaderStatus.Ok
        } catch (e: SpaceApiError.AuthenticationRequired) {
            LoaderStatus.SignInNeeded
        } catch (e: SpaceApiError.Http) {
            LoaderStatus.Incompatible("HTTP ${e.code} ${e.msg}")
        } catch (e: SpaceApiError.InvalidResponse) {
            LoaderStatus.Incompatible(notASpaceText)
        } catch (e: CatalogueError.NotASpace) {
            LoaderStatus.Incompatible("$notASpaceText (${e.route})")
        } catch (e: Throwable) {
            if (e is CancellationException || !currentCoroutineContext().isActive) {
                // The coroutine that asked went away: nothing was learnt about the Space, so what is
                // on show stays as it was.
                if (session == this.session) {
                    isRefreshing = false
                    if (statusState.value == LoaderStatus.Loading) scope.launch { refresh() }
                }
                throw if (e is CancellationException) e else CancellationException(e.message)
            }
            LoaderStatus.Unreachable(e.localizedMessage ?: e.toString())
        }
        if (session != this.session) return
        isRefreshing = false
        if (statusState.value != outcome) statusState.value = outcome
        val lastKnown = outcome != LoaderStatus.Ok && catalogueState.value != null
        if (lastKnownState.value != lastKnown) lastKnownState.value = lastKnown
        val catalogue = catalogueState.value
        if (outcome == LoaderStatus.Ok && catalogue != null) onCatalogue(catalogue)
    }

    private suspend fun optional(path: String): String? = try {
        fetch(path)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }

    /**
     * Signing out forgets what the Space showed, not only the session. A refresh on its way belongs to
     * the session that ended: its answer is dropped, and it does not hold up the next one (b357ab9).
     */
    fun forget() {
        session += 1
        isRefreshing = false
        cache.remove(connection.id)
        catalogueState.value = null
        lastKnownState.value = false
        statusState.value = LoaderStatus.Loading
    }

    companion object {
        /** "not an ai-space response" in the app's language; set from the resources at launch. */
        @Volatile
        var notASpaceText: String = "not an ai-space response"
    }
}
