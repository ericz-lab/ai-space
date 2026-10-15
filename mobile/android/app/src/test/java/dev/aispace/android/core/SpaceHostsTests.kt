package dev.aispace.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI

class SpaceHostsTests {
    private val space = URI("https://space.example.com/")
    private fun u(s: String) = URI(s)

    @Test fun thePanelAndTheServiceAppsBelong() {
        val catalogue = Fixture.catalogue.copy(domain = null)
        val hosts = SpaceHosts.of(space, catalogue)
        assertTrue(hosts.contains(u("https://space.example.com/api/apps")))
        assertTrue(hosts.contains(u("https://todo.example.com/items/3")))
        assertTrue(hosts.contains(u("https://voice.example.com/")))
        // A link app points at another site: that is the browser's, not the Space's.
        assertFalse(hosts.contains(u("https://bun.sh/docs/installation")))
        assertFalse(hosts.contains(u("https://example.org/")))
        assertFalse(hosts.contains(u("https://bun.sh.evil.example.org/")))
    }

    @Test fun theDomainCoversItsHttpsHostsOnly() {
        val hosts = SpaceHosts(space, emptyList(), "example.com")
        assertTrue(hosts.contains(u("https://new-app.example.com/")))
        assertTrue(hosts.contains(u("https://example.com/")))
        assertFalse(hosts.contains(u("http://new-app.example.com/")))
        assertFalse(hosts.contains(u("https://new-app.example.com:8443/")))
        assertFalse(hosts.contains(u("https://example.com.evil.org/")))
        assertFalse(hosts.contains(u("https://notexample.com/")))
    }

    @Test fun aDomainTheSpaceIsNotUnderIsIgnored() {
        assertFalse(SpaceHosts(u("https://space.other.net/"), domain = "example.com").contains(u("https://a.example.com/")))
        assertFalse(SpaceHosts(u("http://127.0.0.1:8700/"), domain = "example.com").contains(u("https://a.example.com/")))
    }

    @Test fun originsCompareSchemeHostAndPort() {
        val hosts = SpaceHosts(u("http://127.0.0.1:8700/"), listOf(u("http://127.0.0.1:8801/")))
        assertTrue(hosts.contains(u("http://127.0.0.1:8700/x")))
        assertTrue(hosts.contains(u("http://127.0.0.1:8801/")))
        assertFalse(hosts.contains(u("http://127.0.0.1:9999/")))
        assertFalse(hosts.contains(u("https://127.0.0.1:8700/")))
        assertFalse(hosts.contains(u("mailto:someone@example.com")))
        assertTrue(SpaceHosts(space).contains(u("https://SPACE.example.com:443/")))
    }
}

class MobileNavigationTests {
    private val space = URI("https://space.example.com/")
    private val hosts = SpaceHosts.of(space, Fixture.catalogue)

    private fun decide(
        url: String,
        mainFrame: Boolean = true,
        link: Boolean = false,
        newWindow: Boolean = false,
        download: Boolean = false,
        fromSpace: Boolean = true,
    ): NavigationDecision = MobileNavigation.decide(
        NavigationRequest(URI(url), mainFrame, link, newWindow, download, fromSpace),
        hosts,
        space,
    )

    @Test fun spacePagesStayInTheView() {
        assertEquals(NavigationDecision.allow, decide("https://todo.example.com/items/3", link = true))
        assertEquals(NavigationDecision.allow, decide("https://space.example.com/", link = true))
        // From one app to another of the same Space.
        assertEquals(NavigationDecision.allow, decide("https://reader.example.com/a", link = true))
        assertEquals(NavigationDecision.allow, decide("https://later.example.com/", link = true))
    }

    @Test fun tappedLinksToOtherSitesLeaveForTheBrowser() {
        assertEquals(NavigationDecision.openExternally, decide("https://news.ycombinator.com/", link = true))
        assertEquals(NavigationDecision.openExternally, decide("https://news.ycombinator.com/", newWindow = true))
        assertEquals(NavigationDecision.openExternally, decide("mailto:someone@example.org", link = true))
        assertEquals(NavigationDecision.cancel, decide("tel:10086"))
        assertEquals(NavigationDecision.cancel, decide("javascript:alert(1)"))
    }

    @Test fun theSignInRedirectStaysInTheView() {
        // The access layer answers a Space page with a redirect to its login; no one tapped a link.
        assertEquals(NavigationDecision.allow, decide("https://team.cloudflareaccess.com/cdn-cgi/access/login/todo.example.com"))
        // On the login pages themselves, links and forms keep working until the Space is back.
        assertEquals(NavigationDecision.allow, decide("https://accounts.example.org/next", link = true, fromSpace = false))
        assertEquals(NavigationDecision.allow, decide("https://todo.example.com/", fromSpace = false))
    }

    @Test fun framesAndDownloads() {
        assertEquals(NavigationDecision.allow, decide("https://player.example.org/embed", mainFrame = false))
        assertEquals(NavigationDecision.download, decide("https://todo.example.com/export.csv", link = true, download = true))
        assertEquals(NavigationDecision.openExternally, decide("https://files.example.org/x.zip", link = true, download = true))
    }

    @Test fun aNewWindowForASpacePageLoadsInTheSameView() {
        assertEquals(NavigationDecision.openExternally, decide("https://todo.example.com/print", newWindow = true))
        assertEquals(MobileNavigation.ExternalRoute.sameView, MobileNavigation.external(URI("https://todo.example.com/print"), hosts))
        assertEquals(MobileNavigation.ExternalRoute.browser, MobileNavigation.external(URI("https://example.org/"), hosts))
    }
}
