# Web parity review, 2026-10-18

Review scope: the 20 commits ending at `0495cf0`, before this follow-up. The goal is consistent chat behavior across the Mac and Web clients, without moving native installation or service management into the browser.

| Commit | Web impact and disposition |
| --- | --- |
| `0495cf0` | Composer sizing: Web started at one row but never expanded. Add content measurement, shrink after clear/send, a 160 px scrolling cap, and width-change measurement. |
| `d9a419f` | History: shared server reader already restores current and legacy Codex user records for Web. |
| `7acb4c6` | Markdown: Web had a basic renderer. Preserve actual ordered/nested lists, heading levels, table alignment and escaped pipes, literal inline code and incomplete fences; keep HTML inert. |
| `2a1bf6f` | Clipboard: Web already receives clipboard image files in its paste handler; AppKit first-responder fix does not apply. |
| `afec080` | Images: already implemented in Web with choose/paste/drop, removable previews, image-only sends, queued attachments and shared limits. |
| `8ddf148` | Catalogue: refresh after each settled chat turn, closing chat and returning to a visible page. Coalesce concurrent refreshes with a follow-up and ignore stale delayed health responses. ATS exception is Mac-only. |
| `14c70ab` | Merge of Local/chat work; no separate Web behavior beyond the constituent commits. |
| `60e13ca` | Web already has separate ordered work steps, result details, borderless replies, Permission and IME-safe Return. Setup colors, agent detection and loading UI are native-only. |
| `b93e28d` | Default model selection: shared runtime/model resolution and Web model controls already apply. Native first-install picker has no browser equivalent. |
| `fb68e14` | Local setup requirements: enforced by shared installation; Web backup settings already handle an unconfigured target. |
| `682d647` | Mac permission/retry parity was copied from existing Web behavior. |
| `26e7950` | Native app replacement and rollback: no browser equivalent. |
| `f5e2416` | Upgrade coordination: shared server activity checks already include Web runs; native/CLI upgrade controls only. |
| `71279d8` | App Studio creation/change flows already included Web forms, agent context and translations. Catalogue refresh above completes visibility after agent installation. |
| `e713e22` | Local signing/notarization/release CI: no browser behavior. |
| `220a847` | Native first-run setup and managed-service UI: no browser equivalent. |
| `8cfb75e` | Local service lifecycle and device authentication: shared server behavior, native/CLI management. |
| `6c8bda9` | Embedded runtime and PTY helpers: backend changes already apply to Web APIs/terminal. |
| `8ba4c6a` | Test timeout only. |
| `29c604c` | CI and process cleanup: shared backend behavior; no Web UI change. |

Regression tests cover Markdown structure, streaming fences, literal code and safe links/HTML alongside existing work-step, IME and queued-turn tests. Browser checks use the actual App and Chat components with isolated, scripted API responses; no live agent execution or workspace data changes are needed.

Browser results (Chrome, isolated fixture): empty/single-line/cleared composer each 40 px; three lines 79 px; long input capped at 160 px. IME confirmation sent zero requests. Image paste produced one removable preview and an image-only turn with one attachment. A settled turn triggered a catalogue fetch and Todo appeared in the library. Three overlapping refresh signals made one in-flight request and one follow-up. At a 390 px viewport the page stayed 390 px wide; table overflow remained horizontal scrolling. No browser errors were reported.
