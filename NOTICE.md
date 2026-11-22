# Notice

ai-space
Copyright (c) 2026 Nexia Global Limited

ai-space is licensed under the [Sustainable Use License 1.0](LICENSE). The licensor is Nexia Global
Limited. What that allows, and what needs a separate commercial license, is summarized in
[COMMERCIAL.md](COMMERCIAL.md).

## Files under the MIT License

These files are meant to be copied into apps that other people write, so they are under the
[MIT License](LICENSE-MIT) instead, and an app made from them is its author's own:

- `skills/space-app/templates/` and `skills/space-app/package-template/`, the app templates
  (`space app create` starts from the second one);
- `src/web/ui-kit/kit.css`, the Space Tiles stylesheet apps carry a copy of.

## Third-party software

Code that others wrote stays under its own license; the Sustainable Use License 1.0 does not apply to it.

In this repository:

| What | Where | License |
| --- | --- | --- |
| Termux terminal emulator and view | `mobile/android/app/src/main/java/dev/aispace/android/terminal/` | Apache-2.0 (`LICENSE-APACHE-2.0.txt` there) |
| Claude and Codex agent icons (LobeHub) | `desktop/macos/AISpace/Resources/` | MIT (`AgentIcons-LICENSE.txt` there) |
| Gradle wrapper | `mobile/android/gradlew`, `gradlew.bat`, `gradle/wrapper/` | Apache-2.0 |

Fetched at build time and shipped inside the downloads:

| What | Shipped in | License |
| --- | --- | --- |
| Bun | the Server and Local archives (`runtime/`) | MIT, with the components its own license file lists |
| react, react-dom | the web panel | MIT |
| @xterm/xterm, @xterm/addon-fit | the web terminal, the Linux client | MIT |
| croner | the scheduler | MIT |
| SwiftTerm | the Mac and iPhone clients | MIT |
| AndroidX, Jetpack Compose, kotlinx.coroutines, OkHttp | the Android client | Apache-2.0 |

Each package's full license text is in its own distribution (`node_modules/<package>/` in a Server
archive). The native clients' dependencies are declared in their build files (`mobile/android/app/build.gradle.kts`,
`mobile/ios/project.yml`, `desktop/macos/project.yml`, `desktop/windows/`).
