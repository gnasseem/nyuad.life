package app.ror

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.LinkInteractionListener
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.BaselineShift
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val Inline = Regex("(\\*\\*[^*]+\\*\\*|__[^_]+__|`[^`]+`|\\*[^*\\s][^*]*\\*|\\[\\d+(?:\\]\\[\\d+)*\\]|\\[\\d+(?:,\\s*\\d+)+\\]|https?://[^\\s)]+)")

@Composable
fun MarkdownText(text: String, onCitation: (Int) -> Unit, modifier: Modifier = Modifier) {
    val blocks = parseMarkdown(text)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (block in blocks) {
            when (block) {
                is MdBlock.Paragraph -> Text(inline(block.text, onCitation), style = MaterialTheme.typography.bodyLarge)
                is MdBlock.Heading -> Text(
                    inline(block.text, onCitation),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(top = 6.dp),
                )
                is MdBlock.Quote -> Text(
                    inline(block.text, onCitation),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 12.dp),
                )
                is MdBlock.Bullets -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    block.items.forEach { item -> ListLine("•", inline(item, onCitation)) }
                }
                is MdBlock.Numbered -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    block.items.forEachIndexed { index, item -> ListLine("${block.start + index}.", inline(item, onCitation)) }
                }
            }
        }
    }
}

@Composable
private fun ListLine(marker: String, text: AnnotatedString) {
    Row {
        Text(marker, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold, modifier = Modifier.width(22.dp), style = MaterialTheme.typography.bodyLarge)
        Spacer(Modifier.width(2.dp))
        Text(text, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun inline(text: String, onCitation: (Int) -> Unit): AnnotatedString {
    val colors = MaterialTheme.colorScheme
    val citeStyle = TextLinkStyles(
        style = SpanStyle(
            color = colors.onPrimaryContainer,
            background = colors.primaryContainer,
            fontWeight = FontWeight.Bold,
            fontSize = 11.sp,
            baselineShift = BaselineShift(0.25f),
            fontFamily = FontFamily.Monospace,
        ),
    )
    val linkStyle = TextLinkStyles(style = SpanStyle(color = colors.primary))
    return buildAnnotatedString {
        var cursor = 0
        for (match in Inline.findAll(text)) {
            if (match.range.first > cursor) append(text.substring(cursor, match.range.first))
            val token = match.value
            when {
                token.startsWith("**") || token.startsWith("__") ->
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(token.substring(2, token.length - 2)) }
                token.startsWith("`") ->
                    withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = colors.surfaceContainerHigh)) { append(token.substring(1, token.length - 1)) }
                token.startsWith("*") ->
                    withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(token.substring(1, token.length - 1)) }
                token.startsWith("[") -> {
                    val numbers = Regex("\\d+").findAll(token).map { it.value.toInt() }.toList()
                    numbers.forEachIndexed { index, n ->
                        if (index > 0) append(" ")
                        withLink(LinkAnnotation.Clickable("cite:$n", citeStyle, LinkInteractionListener { onCitation(n) })) { append(" $n ") }
                    }
                }
                else -> withLink(LinkAnnotation.Url(token, linkStyle)) { append(token.removePrefix("https://").removePrefix("http://").take(60)) }
            }
            cursor = match.range.last + 1
        }
        if (cursor < text.length) append(text.substring(cursor))
    }
}
