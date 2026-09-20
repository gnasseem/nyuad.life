plugins {
    application
    alias(libs.plugins.kotlinJvm)
    alias(libs.plugins.kotlinxSerialization)
}

dependencies {
    implementation(projects.shared)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.ktor.client.core)
    implementation(libs.ktor.client.content.negotiation)
    implementation(libs.ktor.client.okhttp)
    implementation(libs.ktor.serialization.kotlinx.json)
}

application {
    mainClass = "app.ror.indexer.MainKt"
}
