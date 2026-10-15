pluginManagement {
    repositories {
        // Mirrors first: Google's own hosts are slow from some networks; the official ones stay as fallbacks.
        maven("https://repo.huaweicloud.com/repository/maven/")
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven("https://repo.huaweicloud.com/repository/maven/")
        google()
        mavenCentral()
    }
}
rootProject.name = "AISpace"
include(":app")
