package dev.aispace.android.live

import dev.aispace.android.core.CatalogueCache
import dev.aispace.android.core.Connection
import dev.aispace.android.core.CookieSource
import dev.aispace.android.core.Fixture
import dev.aispace.android.core.SpaceApiError
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException
import java.net.URI
import java.nio.file.Files

/** A Space whose answers the test holds back and lets go, so a refresh can be caught half way. */
private class FakeSpace {
    enum class Answer { catalogue, signIn, offline }

    var answer = Answer.catalogue
    var holds = false
    var requests = 0
        private set
    private var gate = CompletableDeferred<Unit>()

    suspend fun fetch(path: String): String {
        requests += 1
        // The answer is decided when the request is made, as a server decides it by the cookie it was sent.
        val answer = this.answer
        if (holds) gate.await()
        return when (answer) {
            Answer.signIn -> throw SpaceApiError.AuthenticationRequired
            Answer.offline -> throw IOException("offline")
            Answer.catalogue -> when (path) {
                "/api/apps" -> Fixture.apps
                "/api/agents" -> Fixture.agents
                "/api/widgets" -> Fixture.widgets
                "/api/peers" -> Fixture.peers
                "/api/router" -> Fixture.router
                else -> Fixture.layout
            }
        }
    }

    fun release() {
        holds = false
        gate.complete(Unit)
        gate = CompletableDeferred()
    }

    suspend fun reached(count: Int) {
        repeat(10_000) { if (requests >= count) return; yield() }
    }
}

/** Port of the iOS CatalogueLoaderTests. */
class CatalogueLoaderTests {
    private val connection = Connection(name = "Space", url = URI("https://space.example.com/"))
    private val directory: File = Files.createTempDirectory("aispace-loader").toFile()
    private val cache = CatalogueCache(directory)
    private val space = FakeSpace()

    private fun CoroutineScope.loader() =
        CatalogueLoader(connection, cache, CookieSource.none, this) { space.fetch(it) }

    @Test
    fun aRefreshShowsAndSavesTheCatalogue() = runBlocking {
        val l = loader()
        var seen = 0
        l.onCatalogue = { seen += 1 }
        l.refresh()
        assertEquals(LoaderStatus.Ok, l.status.value)
        assertTrue(l.catalogue.value?.apps?.isNotEmpty() == true)
        assertFalse(l.isLastKnown.value)
        assertFalse(l.isRefreshing)
        assertNotNull(cache.load(connection.id))
        assertEquals(1, seen)
        // The next launch starts from the saved catalogue, marked as last known.
        val next = loader()
        assertEquals(l.catalogue.value, next.catalogue.value)
        assertTrue(next.isLastKnown.value)
    }

    @Test
    fun anAnswerThatArrivesAfterSigningOutIsDropped() = runBlocking {
        val l = loader()
        var seen = 0
        l.onCatalogue = { seen += 1 }
        space.holds = true
        val old = async(Dispatchers.Unconfined) { l.refresh() }
        space.reached(6)
        l.forget()
        space.release()
        old.await()
        assertNull(l.catalogue.value)
        assertNull(cache.load(connection.id))
        assertEquals(LoaderStatus.Loading, l.status.value)
        assertEquals(0, seen)
        assertFalse(l.isRefreshing)
    }

    @Test
    fun signingOutDoesNotBlockTheNextRefresh() = runBlocking {
        val l = loader()
        space.holds = true
        val old = async(Dispatchers.Unconfined) { l.refresh() }
        space.reached(6)
        l.forget()
        space.answer = FakeSpace.Answer.signIn
        val new = async(Dispatchers.Unconfined) { l.refresh() }
        space.reached(12)
        space.release()
        old.await()
        new.await()
        assertEquals(12, space.requests)
        assertEquals(LoaderStatus.SignInNeeded, l.status.value)
        assertNull(l.catalogue.value)
        assertFalse(l.isRefreshing)
        space.answer = FakeSpace.Answer.catalogue
        l.refresh()
        assertEquals(LoaderStatus.Ok, l.status.value)
    }

    @Test
    fun theCatalogueIsLastKnownWheneverTheSpaceStopsAnswering() = runBlocking {
        val l = loader()
        l.refresh()
        assertFalse(l.isLastKnown.value)
        space.answer = FakeSpace.Answer.offline
        l.refresh()
        assertTrue(l.status.value is LoaderStatus.Unreachable)
        assertNotNull(l.catalogue.value)
        assertTrue(l.isLastKnown.value)
        space.answer = FakeSpace.Answer.signIn
        l.refresh()
        assertEquals(LoaderStatus.SignInNeeded, l.status.value)
        assertTrue(l.isLastKnown.value)
        space.answer = FakeSpace.Answer.catalogue
        l.refresh()
        assertEquals(LoaderStatus.Ok, l.status.value)
        assertFalse(l.isLastKnown.value)
    }

    @Test
    fun nothingIsLastKnownWithoutACatalogue() = runBlocking {
        val l = loader()
        space.answer = FakeSpace.Answer.offline
        l.refresh()
        assertNull(l.catalogue.value)
        assertFalse(l.isLastKnown.value)
    }
}
