plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
}
android {
    namespace = "app.veguide"
    compileSdk = 37
    defaultConfig {
        applicationId = "app.veguide"
        minSdk = 26
        targetSdk = 36
        versionCode = providers.environmentVariable("VEGUIDE_VERSION_CODE").orNull?.toInt() ?: 4
        versionName = providers.environmentVariable("VEGUIDE_VERSION_NAME").orNull ?: "0.2.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    val releaseKeystore = providers.environmentVariable("VEGUIDE_KEYSTORE_PATH").orNull
    if (releaseKeystore != null) {
        signingConfigs.create("release") {
            storeFile = file(releaseKeystore)
            storePassword = providers.environmentVariable("VEGUIDE_KEYSTORE_PASSWORD").get()
            keyAlias = "veguide"
            keyPassword = providers.environmentVariable("VEGUIDE_KEYSTORE_PASSWORD").get()
        }
        buildTypes.getByName("release").signingConfig = signingConfigs.getByName("release")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true }
    sourceSets["main"].assets.directories.add("../../data")
    sourceSets["main"].assets.directories.add("../../contracts")
    testOptions { unitTests.all { it.systemProperty("veguide.repo", rootDir.parentFile.absolutePath) } }
    lint { abortOnError = true }
}
kotlin {
    jvmToolchain(21)
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}
dependencies {
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.compose.ui:ui:1.9.0")
    implementation("androidx.compose.ui:ui-tooling-preview:1.9.0")
    implementation("androidx.compose.material3:material3:1.4.0")
    implementation("androidx.compose.material:material-icons-extended:1.7.8")
    implementation("androidx.camera:camera-camera2:1.5.1")
    implementation("androidx.camera:camera-lifecycle:1.5.1")
    implementation("androidx.camera:camera-view:1.5.1")
    implementation("androidx.exifinterface:exifinterface:1.4.2")
    implementation("com.google.zxing:core:3.5.4")
    implementation("androidx.room:room-runtime:2.8.5")
    implementation("androidx.room:room-ktx:2.8.5")
    ksp("androidx.room:room-compiler:2.8.5")
    implementation("androidx.datastore:datastore-preferences:1.1.7")
    implementation("com.squareup.okhttp3:okhttp:5.5.0")
    implementation("com.nimbusds:nimbus-jose-jwt:10.10")
    implementation("cz.adaptech.tesseract4android:tesseract4android:4.9.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4:1.9.0")
    debugImplementation("androidx.compose.ui:ui-test-manifest:1.9.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260814")
    testImplementation("com.squareup.okhttp3:mockwebserver:5.5.0")
}

// Refresh once per seven days; a valid bundled snapshot also supports offline builds.
val prepareOfflineSnapshot = tasks.register<Exec>("prepareOfflineSnapshot") {
    workingDir(rootDir.parentFile)
    commandLine("bun", "scripts/offline-snapshot.ts")
    // Unit tests/lint use the checked-in snapshot without network access.
    onlyIf {
        gradle.startParameter.taskNames.any { requested ->
            val task = requested.substringAfterLast(':')
            task == "prepareOfflineSnapshot" || task.startsWith("assemble") || task.startsWith("bundle") || task.startsWith("build")
        }
    }
}
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach {
    dependsOn(prepareOfflineSnapshot)
}
