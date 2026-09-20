import com.android.build.api.dsl.KotlinMultiplatformAndroidLibraryTarget
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.composeMultiplatform)
    alias(libs.plugins.composeCompiler)
    alias(libs.plugins.kotlinxSerialization)
}

val hasAndroidSdk =
    System.getenv("ANDROID_HOME") != null ||
        System.getenv("ANDROID_SDK_ROOT") != null ||
        rootProject.file("local.properties").let { it.exists() && it.readText().contains("sdk.dir") }

if (hasAndroidSdk) {
    apply(plugin = "com.android.kotlin.multiplatform.library")
}

kotlin {
    jvm()

    if (hasAndroidSdk) {
        extensions.configure<KotlinMultiplatformAndroidLibraryTarget>("androidLibrary") {
            namespace = "app.ror.shared"
            compileSdk = libs.versions.android.compileSdk.get().toInt()
            minSdk = libs.versions.android.minSdk.get().toInt()

            compilerOptions {
                jvmTarget = JvmTarget.JVM_11
            }
            androidResources {
                enable = true
            }
        }
    }

    sourceSets {
        jvmMain.dependencies {
            implementation(libs.ktor.client.okhttp)
        }
        if (hasAndroidSdk) {
            getByName("androidMain").dependencies {
                implementation(libs.ktor.client.okhttp)
            }
        }
        commonMain.dependencies {
            implementation(libs.compose.runtime)
            implementation(libs.compose.foundation)
            implementation(libs.compose.material3)
            implementation(libs.compose.ui)
            implementation(libs.compose.components.resources)
            implementation(libs.compose.uiToolingPreview)

            implementation(libs.kotlinx.coroutines.core)
            implementation(libs.kotlinx.serialization.json)
            implementation(libs.ktor.client.core)
            implementation(libs.ktor.client.content.negotiation)
            implementation(libs.ktor.serialization.kotlinx.json)
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
        }
    }
}

compose.resources {
    packageOfResClass = "app.ror.generated.resources"
}
