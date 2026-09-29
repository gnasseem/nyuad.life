package app.ror

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
fun Tag(text: String, accent: Boolean = false) {
    val colors = MaterialTheme.colorScheme
    Surface(
        shape = RoundedCornerShape(999.dp),
        color = if (accent) colors.primaryContainer else colors.surfaceContainerHigh,
    ) {
        Text(
            text,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
            style = MaterialTheme.typography.labelSmall,
            color = if (accent) colors.onPrimaryContainer else colors.onSurfaceVariant,
            fontFamily = if (accent) FontFamily.Monospace else null,
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PostCard(post: PostSummary, showSnippet: Boolean = true, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = colors.surfaceContainer),
        border = BorderStroke(1.dp, colors.outlineVariant),
        shape = RoundedCornerShape(14.dp),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(post.author.ifBlank { "Unknown" }, style = MaterialTheme.typography.titleSmall)
                Text(formatDate(post.date), style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
                post.topics.filter { it != "general" }.take(2).forEach { Tag(topicLabel(it)) }
            }
            Text(
                if (showSnippet && post.snippet.isNotBlank()) post.snippet else post.preview,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 5,
                overflow = TextOverflow.Ellipsis,
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(RorIcons.Comment, contentDescription = null, modifier = Modifier.size(14.dp), tint = colors.onSurfaceVariant)
                    Spacer(Modifier.width(4.dp))
                    Text(compact(post.commentCount), style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
                }
                if (post.reactions > 0) {
                    Text("♥ ${compact(post.reactions)}", style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
                }
                post.courses.take(3).forEach { Tag(it, accent = true) }
            }
        }
    }
}

@Composable
fun SourceItem(source: SourceCard, hot: Boolean, onOpen: (String) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val uriHandler = LocalUriHandler.current
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = colors.surfaceContainer),
        border = BorderStroke(if (hot) 2.dp else 1.dp, if (hot) colors.primary else colors.outlineVariant),
        shape = RoundedCornerShape(12.dp),
    ) {
        Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Surface(shape = RoundedCornerShape(7.dp), color = colors.primaryContainer) {
                    Text(
                        source.n.toString(),
                        modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp),
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.onPrimaryContainer,
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold,
                    )
                }
                Text(source.author.ifBlank { "Unknown" }, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(formatDate(source.date), style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
            }
            Text(source.snippet.ifBlank { source.text }, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant, maxLines = 6, overflow = TextOverflow.Ellipsis)
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { onOpen(source.postId) }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
                    Text("Thread · ${source.commentCount} ${if (source.commentCount == 1) "comment" else "comments"}", style = MaterialTheme.typography.labelMedium)
                }
                if (source.url.isNotBlank()) {
                    TextButton(onClick = { uriHandler.openUri(source.url) }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
                        Text("Facebook ↗", style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
        }
    }
}

@Composable
fun ErrorBanner(message: String) {
    val colors = MaterialTheme.colorScheme
    Surface(shape = RoundedCornerShape(10.dp), color = colors.errorContainer, modifier = Modifier.fillMaxWidth()) {
        Text(message, modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp), color = colors.onErrorContainer, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
fun SectionTitle(text: String) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 12.dp, bottom = 2.dp),
    )
}
