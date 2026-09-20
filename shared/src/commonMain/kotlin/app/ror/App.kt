package app.ror

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val Ink = Color(0xFF0F1216)
private val Panel = Color(0xFF171B20)
private val Raised = Color(0xFF222830)
private val Paper = Color(0xFFECEFF1)
private val Muted = Color(0xFF9AA5AE)
private val Amber = Color(0xFFF3B33D)
private val Sea = Color(0xFF73CFC5)
private val Danger = Color(0xFFFF8A80)

private val RorColors = darkColorScheme(
    primary = Amber,
    onPrimary = Ink,
    secondary = Sea,
    background = Ink,
    onBackground = Paper,
    surface = Panel,
    onSurface = Paper,
    surfaceVariant = Raised,
    onSurfaceVariant = Muted,
    error = Danger,
)

private enum class Screen { Keys, Ask }

private data class ChatEntry(val question: String, val answer: Answer)

@Composable
fun App() {
    var screen by remember {
        mutableStateOf(if (KeyStore.get("openai_key").isNullOrBlank()) Screen.Keys else Screen.Ask)
    }
    val history = remember { mutableStateListOf<ChatEntry>() }

    MaterialTheme(colorScheme = RorColors) {
        Surface(modifier = Modifier.fillMaxSize(), color = Ink) {
            Column(Modifier.fillMaxSize()) {
                Header(screen) { screen = Screen.Keys }
                when (screen) {
                    Screen.Keys -> KeysScreen { screen = Screen.Ask }
                    Screen.Ask -> AskScreen(history)
                }
            }
        }
    }
}

@Composable
private fun Header(screen: Screen, openKeys: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().height(68.dp).padding(horizontal = 28.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(13.dp).background(Amber))
        Spacer(Modifier.width(12.dp))
        Text("ROR", fontSize = 19.sp, fontWeight = FontWeight.Black, letterSpacing = 1.sp)
        Text(" Answers", color = Muted, fontSize = 19.sp)
        Spacer(Modifier.weight(1f))
        if (screen == Screen.Ask) {
            TextButton(onClick = openKeys) { Text("Keys  ⚙", color = Muted) }
        }
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(Raised))
}

@Composable
private fun KeysScreen(onSaved: () -> Unit) {
    var openAi by remember { mutableStateOf(KeyStore.get("openai_key").orEmpty()) }
    var voyage by remember { mutableStateOf(KeyStore.get("voyage_key").orEmpty()) }
    var model by remember { mutableStateOf(KeyStore.get("openai_model").orEmpty().ifBlank { "gpt-4.1" }) }
    var error by remember { mutableStateOf("") }

    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(
            modifier = Modifier.widthIn(max = 620.dp).fillMaxWidth().verticalScroll(rememberScrollState())
                .padding(horizontal = 28.dp, vertical = 52.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Text("Connect the two services", fontSize = 32.sp, lineHeight = 37.sp, fontWeight = FontWeight.SemiBold)
            Text(
                "Voyage finds the right Room of Requirement posts. OpenAI writes the grounded answer.",
                color = Muted,
                fontSize = 16.sp,
                lineHeight = 24.sp,
            )
            Spacer(Modifier.height(8.dp))
            SecretField("OpenAI API key", openAi) { openAi = it }
            SecretField("Voyage AI API key", voyage) { voyage = it }
            OutlinedTextField(
                value = model,
                onValueChange = { model = it },
                label = { Text("OpenAI model") },
                placeholder = { Text("gpt-4.1") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "Keys are stored only on this device in ~/.ror-answers/keys.properties.",
                color = Muted,
                fontSize = 13.sp,
            )
            if (error.isNotEmpty()) Text(error, color = Danger)
            Button(
                onClick = {
                    if (openAi.isBlank() || voyage.isBlank() || model.isBlank()) {
                        error = "Add both API keys and a model name."
                    } else {
                        KeyStore.set("openai_key", openAi.trim())
                        KeyStore.set("voyage_key", voyage.trim())
                        KeyStore.set("openai_model", model.trim())
                        onSaved()
                    }
                },
                colors = ButtonDefaults.buttonColors(containerColor = Amber, contentColor = Ink),
                contentPadding = PaddingValues(horizontal = 24.dp, vertical = 13.dp),
            ) {
                Text("Save keys", fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
private fun SecretField(label: String, value: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        visualTransformation = PasswordVisualTransformation(),
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun AskScreen(history: MutableList<ChatEntry>) {
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    var question by remember { mutableStateOf("") }
    var progress by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    var running by remember { mutableStateOf(false) }

    val submit: () -> Unit = submit@{
        val prompt = question.trim()
        if (prompt.isEmpty() || running) return@submit
        scope.launch {
            running = true
            error = ""
            progress = "Starting…"
            runCatching { ask(prompt) { progress = it } }
                .onSuccess {
                    history.add(ChatEntry(prompt, it))
                    question = ""
                    progress = ""
                    delay(60)
                    listState.animateScrollToItem(history.size)
                }
                .onFailure {
                    progress = ""
                    error = it.message ?: "The request failed."
                }
            running = false
        }
    }

    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        contentPadding = PaddingValues(horizontal = 24.dp, vertical = 30.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        item {
            Column(
                modifier = Modifier.widthIn(max = 820.dp).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text("Ask the archive", fontSize = 29.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    "Answers are drawn from matching ROR posts and comments, with the original threads attached.",
                    color = Muted,
                    lineHeight = 22.sp,
                )
                OutlinedTextField(
                    value = question,
                    onValueChange = { question = it },
                    placeholder = { Text("Ask anything about NYUAD courses, professors, study away, housing…") },
                    minLines = 3,
                    maxLines = 7,
                    enabled = !running,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { submit() }),
                    modifier = Modifier.fillMaxWidth().onPreviewKeyEvent {
                        if (it.key == Key.Enter && it.type == KeyEventType.KeyUp) {
                            submit()
                            true
                        } else {
                            false
                        }
                    },
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Button(
                        onClick = submit,
                        enabled = question.isNotBlank() && !running,
                        colors = ButtonDefaults.buttonColors(containerColor = Amber, contentColor = Ink),
                    ) {
                        Text("Ask ROR", fontWeight = FontWeight.Bold)
                    }
                    if (running) {
                        Spacer(Modifier.width(14.dp))
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = Sea)
                        Spacer(Modifier.width(9.dp))
                        Text(progress, color = Sea, fontSize = 14.sp)
                    }
                }
                if (error.isNotEmpty()) Text(error, color = Danger, lineHeight = 21.sp)
            }
        }

        items(history) { entry ->
            Conversation(entry, Modifier.widthIn(max = 820.dp).fillMaxWidth())
        }
    }
}

@Composable
private fun Conversation(entry: ChatEntry, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(entry.question, color = Sea, fontSize = 17.sp, fontWeight = FontWeight.Medium)
        Surface(color = Panel, shape = MaterialTheme.shapes.large) {
            Column(Modifier.padding(22.dp)) {
                MarkdownText(entry.answer.text)
            }
        }
        Sources(entry.answer.sources)
    }
}

@Composable
private fun MarkdownText(text: String) {
    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        text.lines().forEach { rawLine ->
            val line = rawLine.trimEnd()
            when {
                line.isBlank() -> Spacer(Modifier.height(4.dp))
                line.startsWith("- ") -> MarkdownLine("•", line.drop(2))
                Regex("^\\d+\\.\\s+").containsMatchIn(line) -> {
                    val marker = line.substringBefore('.') + "."
                    MarkdownLine(marker, line.substringAfter('.').trimStart())
                }
                else -> Text(boldText(line), lineHeight = 23.sp)
            }
        }
    }
}

@Composable
private fun MarkdownLine(marker: String, text: String) {
    Row {
        Text(marker, color = Amber, modifier = Modifier.width(26.dp), fontWeight = FontWeight.Bold)
        Text(boldText(text), lineHeight = 23.sp, modifier = Modifier.weight(1f))
    }
}

private fun boldText(text: String) = buildAnnotatedString {
    val matches = Regex("\\*\\*(.+?)\\*\\*").findAll(text)
    var cursor = 0
    for (match in matches) {
        append(text.substring(cursor, match.range.first))
        withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = Paper)) {
            append(match.groupValues[1])
        }
        cursor = match.range.last + 1
    }
    append(text.substring(cursor))
}

@Composable
private fun Sources(sources: List<Chunk>) {
    var open by remember { mutableStateOf(false) }
    val expanded = remember { mutableStateMapOf<String, Boolean>() }
    val uriHandler = LocalUriHandler.current
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        TextButton(onClick = { open = !open }, contentPadding = PaddingValues(0.dp)) {
            Text("Sources (${sources.size}) ${if (open) "▴" else "▾"}", color = Amber)
        }
        if (open) {
            sources.forEach { source ->
                val isExpanded = expanded[source.id] == true
                Surface(
                    color = Raised,
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth().clickable { expanded[source.id] = !isExpanded },
                ) {
                    Column(Modifier.padding(horizontal = 17.dp, vertical = 14.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(source.author, fontWeight = FontWeight.SemiBold)
                            Spacer(Modifier.width(9.dp))
                            Text(source.date, color = Muted, fontSize = 13.sp)
                            Spacer(Modifier.weight(1f))
                            if (source.url.isNotBlank()) {
                                TextButton(onClick = { uriHandler.openUri(source.url) }) {
                                    Text("Open post", color = Sea, fontSize = 13.sp)
                                }
                            }
                        }
                        Text(
                            source.text,
                            color = Paper.copy(alpha = 0.88f),
                            fontSize = 14.sp,
                            lineHeight = 20.sp,
                            maxLines = if (isExpanded) Int.MAX_VALUE else 4,
                        )
                    }
                }
            }
        }
    }
}
