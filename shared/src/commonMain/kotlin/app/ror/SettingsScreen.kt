package app.ror

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(app: AppState, showMessage: (String) -> Unit) {
    var serverUrl by remember { mutableStateOf(Settings.serverUrl()) }
    var accessCode by remember { mutableStateOf(Settings.accessCode()) }
    var testing by remember { mutableStateOf(false) }
    var testResult by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    fun save(): Boolean {
        val url = serverUrl.trim().trimEnd('/')
        if (url.isBlank() || !(url.startsWith("http://") || url.startsWith("https://"))) {
            showMessage("Enter the server address, starting with https://")
            return false
        }
        Settings.setServerUrl(url)
        Settings.setAccessCode(accessCode)
        app.ask.reset()
        app.courses.loaded = false
        app.configVersion++
        return true
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Column(Modifier.widthIn(max = 620.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("Settings", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
            Text(
                "The app talks to the ROR Answers server, which holds the archive and the Gemini key. Ask whoever runs it for the address and, if set, the access code.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                value = serverUrl,
                onValueChange = { serverUrl = it },
                label = { Text("Server address") },
                placeholder = { Text("https://ror-answers.vercel.app") },
                singleLine = true,
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = accessCode,
                onValueChange = { accessCode = it },
                label = { Text("Access code (if required)") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(onClick = {
                    if (save()) {
                        showMessage("Saved")
                        app.tab = Tab.Ask
                    }
                }) { Text("Save") }
                OutlinedButton(
                    enabled = !testing,
                    onClick = {
                        if (!save()) return@OutlinedButton
                        testing = true
                        testResult = ""
                        scope.launch {
                            try {
                                val health = Api.health()
                                testResult = buildString {
                                    append("Connected: ${health.archive.posts} posts, ${health.archive.comments} comments")
                                    append(if (health.archive.vectors) ", semantic search on" else ", keyword search only")
                                    append(if (health.gemini.configured) ", Gemini ready (${health.gemini.chatModel})." else ", but no Gemini key on the server yet.")
                                    if (health.accessCode && accessCode.isBlank()) append(" This server needs an access code.")
                                }
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                testResult = e.message ?: "Could not connect."
                            } finally {
                                testing = false
                            }
                        }
                    },
                ) { Text(if (testing) "Testing…" else "Test connection") }
            }
            if (testResult.isNotBlank()) Text(testResult, color = MaterialTheme.colorScheme.onSurfaceVariant)

            Spacer(Modifier.width(1.dp))
            Text("Appearance", style = MaterialTheme.typography.titleMedium)
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                ThemeMode.entries.forEachIndexed { index, mode ->
                    SegmentedButton(
                        selected = app.themeMode == mode,
                        onClick = {
                            app.themeMode = mode
                            Settings.setThemeMode(mode)
                        },
                        shape = SegmentedButtonDefaults.itemShape(index = index, count = ThemeMode.entries.size),
                    ) { Text(mode.name) }
                }
            }

            Spacer(Modifier.width(1.dp))
            Text("About", style = MaterialTheme.typography.titleMedium)
            Text(
                "ROR Answers searches the NYU Abu Dhabi Room of Requirement archive and writes answers grounded in real threads, with every claim cited. Answers can be wrong: open the cited posts before you rely on them.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
