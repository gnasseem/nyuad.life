package app.ror

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

data class Message(
    val id: Long,
    val role: String,
    val content: String = "",
    val sources: List<SourceCard> = emptyList(),
    val followups: List<String> = emptyList(),
    val status: String = "",
    val error: String = "",
    val pending: Boolean = false,
)

class AskState {
    val messages = mutableStateListOf<Message>()
    var input by mutableStateOf("")
    var running by mutableStateOf(false)
    var hot by mutableStateOf<Int?>(null)
    var job: Job? = null
    private var nextId = 1L

    fun newId(): Long = nextId++

    fun update(id: Long, transform: (Message) -> Message) {
        val index = messages.indexOfFirst { it.id == id }
        if (index >= 0) messages[index] = transform(messages[index])
    }

    fun history(): List<ChatTurn> = messages
        .filter { !it.pending && it.error.isEmpty() && it.content.isNotBlank() }
        .map { ChatTurn(it.role, it.content) }

    fun reset() {
        job?.cancel()
        job = null
        running = false
        messages.clear()
        input = ""
        hot = null
    }
}

@Composable
fun AskScreen(app: AppState, wide: Boolean, onError: (Throwable) -> Unit) {
    val state = app.ask
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    val sourcesState = rememberLazyListState()

    fun send(question: String) {
        val trimmed = question.trim()
        if (trimmed.isEmpty() || state.running) return
        val history = state.history()
        val userId = state.newId()
        val modelId = state.newId()
        state.messages += Message(userId, "user", trimmed)
        state.messages += Message(modelId, "model", pending = true, status = "Starting")
        state.input = ""
        state.running = true
        state.job = scope.launch {
            try {
                Api.ask(
                    trimmed,
                    history,
                    AskHandlers(
                        onStatus = { status -> state.update(modelId) { it.copy(status = status) } },
                        onSources = { sources -> state.update(modelId) { it.copy(sources = sources) } },
                        onDelta = { delta -> state.update(modelId) { it.copy(content = it.content + delta, status = "") } },
                        onFollowups = { followups -> state.update(modelId) { it.copy(followups = followups) } },
                    ),
                )
                state.update(modelId) { it.copy(pending = false, status = "") }
            } catch (e: CancellationException) {
                state.update(modelId) { it.copy(pending = false, status = "", error = if (it.content.isBlank()) "Stopped." else "") }
                throw e
            } catch (e: Exception) {
                state.update(modelId) { it.copy(pending = false, status = "", error = e.message ?: "Something went wrong.") }
                onError(e)
            } finally {
                state.running = false
            }
        }
    }

    LaunchedEffect(app.pendingQuestion) {
        val pending = app.pendingQuestion ?: return@LaunchedEffect
        app.pendingQuestion = null
        if (pending.autoSend) send(pending.question) else state.input = pending.question
    }

    LaunchedEffect(Unit) {
        snapshotFlow { state.messages.size to (state.messages.lastOrNull()?.content?.length ?: 0) }.collect {
            val count = listState.layoutInfo.totalItemsCount
            if (count > 0 && state.running) listState.animateScrollToItem(count - 1)
        }
    }

    val latestSources = state.messages.lastOrNull { it.sources.isNotEmpty() }?.sources.orEmpty()
    val onCitation: (Message, Int) -> Unit = { message, n ->
        val source = message.sources.firstOrNull { it.n == n }
        if (wide) {
            state.hot = n
            scope.launch { if (n - 1 in latestSources.indices) sourcesState.animateScrollToItem(n - 1) }
        } else if (source != null) {
            app.open(Overlay.Post(source.postId))
        }
    }

    Row(Modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).fillMaxHeight()) {
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 20.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                if (state.messages.isEmpty()) {
                    item { Hero(app, onAsk = ::send) }
                } else {
                    item {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                state.messages.first().content,
                                style = MaterialTheme.typography.titleMedium,
                                modifier = Modifier.weight(1f),
                                maxLines = 1,
                                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                            )
                            TextButton(onClick = { state.reset() }) {
                                Icon(RorIcons.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(6.dp))
                                Text("New question")
                            }
                        }
                    }
                }
                items(state.messages, key = { it.id }) { message ->
                    if (message.role == "user") {
                        UserBubble(message.content)
                    } else {
                        ModelTurn(
                            message = message,
                            showInlineSources = !wide,
                            hot = state.hot,
                            onCitation = { n -> onCitation(message, n) },
                            onFollowup = ::send,
                            onOpenPost = { app.open(Overlay.Post(it)) },
                            running = state.running,
                        )
                    }
                }
            }
            Composer(state, onSend = { send(state.input) }, onStop = { state.job?.cancel() })
        }
        if (wide && latestSources.isNotEmpty()) {
            LazyColumn(
                state = sourcesState,
                modifier = Modifier.width(340.dp).fillMaxHeight(),
                contentPadding = PaddingValues(start = 4.dp, end = 20.dp, top = 20.dp, bottom = 20.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                item { SectionTitle("Sources · ${latestSources.size} threads") }
                items(latestSources, key = { it.n }) { source ->
                    SourceItem(source, hot = state.hot == source.n, onOpen = { app.open(Overlay.Post(it)) })
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Hero(app: AppState, onAsk: (String) -> Unit) {
    val stats = app.home?.stats
    Column(Modifier.widthIn(max = 760.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(
            "Ask the Room of Requirement",
            style = MaterialTheme.typography.headlineLarge,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            buildString {
                append("Every answer is built only from what NYUAD students have already posted")
                if (stats != null && stats.posts > 0) append(" — ${stats.posts} threads and ${stats.comments} comments")
                append(", with the original posts cited so you can check for yourself.")
            },
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (app.homeError.isNotBlank()) ErrorBanner(app.homeError)
        val suggestions = app.home?.suggestions.orEmpty()
        if (suggestions.isNotEmpty()) {
            SectionTitle("Try asking")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                suggestions.forEach { suggestion ->
                    Card(
                        onClick = { onAsk(suggestion.question) },
                        modifier = Modifier.widthIn(min = 200.dp, max = 260.dp),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
                        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                        shape = RoundedCornerShape(12.dp),
                    ) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(
                                suggestion.topic.replace('-', ' ').uppercase(),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(suggestion.question, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun UserBubble(text: String) {
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
        Surface(
            color = MaterialTheme.colorScheme.primaryContainer,
            shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomStart = 18.dp, bottomEnd = 4.dp),
            modifier = Modifier.widthIn(max = 560.dp),
        ) {
            Text(
                text,
                modifier = Modifier.padding(horizontal = 15.dp, vertical = 11.dp),
                color = MaterialTheme.colorScheme.onPrimaryContainer,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ModelTurn(
    message: Message,
    showInlineSources: Boolean,
    hot: Int?,
    onCitation: (Int) -> Unit,
    onFollowup: (String) -> Unit,
    onOpenPost: (String) -> Unit,
    running: Boolean,
) {
    var sourcesOpen by remember(message.id) { mutableStateOf(false) }
    Column(Modifier.widthIn(max = 760.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (message.status.isNotBlank()) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                Text("${message.status}…", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (message.content.isNotBlank()) {
            SelectionContainer {
                MarkdownText(message.content, onCitation = onCitation)
            }
        }
        if (message.error.isNotBlank()) ErrorBanner(message.error)
        if (!message.pending && message.content.isNotBlank()) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { copyText(message.content) }) {
                    Icon(RorIcons.Copy, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Copy")
                }
                if (message.sources.isNotEmpty()) {
                    Text(
                        "${message.sources.size} sources · tap a number to open the post",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontStyle = FontStyle.Italic,
                    )
                }
            }
        }
        if (!message.pending && message.followups.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                message.followups.forEach { question ->
                    AssistChip(onClick = { onFollowup(question) }, enabled = !running, label = { Text(question) })
                }
            }
        }
        if (showInlineSources && message.sources.isNotEmpty()) {
            TextButton(onClick = { sourcesOpen = !sourcesOpen }, contentPadding = PaddingValues(0.dp)) {
                Text(if (sourcesOpen) "Hide sources" else "Show ${message.sources.size} sources")
            }
            if (sourcesOpen) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    message.sources.forEach { source -> SourceItem(source, hot = hot == source.n, onOpen = onOpenPost) }
                }
            }
        }
    }
}

@Composable
private fun Composer(state: AskState, onSend: () -> Unit, onStop: () -> Unit) {
    Column(Modifier.fillMaxWidth().imePadding().padding(horizontal = 20.dp, vertical = 12.dp)) {
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = state.input,
                onValueChange = { state.input = it.take(600) },
                modifier = Modifier.weight(1f).onPreviewKeyEvent { event ->
                    if (event.key == Key.Enter && event.type == KeyEventType.KeyDown && !event.isShiftPressed) {
                        onSend()
                        true
                    } else {
                        false
                    }
                },
                placeholder = { Text(if (state.messages.isEmpty()) "Ask about a course, a professor, housing, visas…" else "Ask a follow-up…") },
                maxLines = 5,
                shape = RoundedCornerShape(18.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                ),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { onSend() }),
            )
            if (state.running) {
                FilledIconButton(
                    onClick = onStop,
                    colors = IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
                ) { Icon(RorIcons.Stop, contentDescription = "Stop") }
            } else {
                FilledIconButton(onClick = onSend, enabled = state.input.isNotBlank()) {
                    Icon(RorIcons.Send, contentDescription = "Send")
                }
            }
        }
        Spacer(Modifier.height(4.dp))
        Text(
            "Enter to send · Shift+Enter for a new line · answers can be wrong, check the cited posts",
            style = MaterialTheme.typography.labelSmall.copy(fontSize = 11.sp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
