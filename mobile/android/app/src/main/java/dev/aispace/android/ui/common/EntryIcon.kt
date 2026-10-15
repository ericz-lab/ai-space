package dev.aispace.android.ui.common

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.aispace.android.live.Icon as IconRules
import dev.aispace.android.live.IconImages
import dev.aispace.android.ui.theme.AiTheme

/**
 * An icon or avatar from the Space: an emoji, a loaded image, or a symbol while it loads. An app's icon
 * is a rounded square; an agent's avatar is a circle, as a person's is. It listens for its own icon
 * only, so one finished download does not redraw every tile.
 */
@Composable
fun EntryIcon(
    icon: String?,
    fallback: ImageVector,
    icons: IconImages,
    modifier: Modifier = Modifier,
    size: Dp = 60.dp,
    isRound: Boolean = false,
) {
    val t = AiTheme.tokens
    val shape = if (isRound) CircleShape else RoundedCornerShape(size * 0.26f)
    var image by remember(icon, icons) { mutableStateOf<ImageBitmap?>(icons.image(icon)) }
    LaunchedEffect(icon, icons) {
        icons.updates.collect { changed ->
            if (changed == null) image = null else if (changed == icon) image = icons.image(icon)
        }
    }
    val emoji = IconRules.emoji(icon)
    val fontSize = with(LocalDensity.current) { (size * 0.52f).toSp() }
    Box(
        modifier
            .size(size)
            .clip(shape)
            .background(t.glass, shape)
            .border(1.dp, t.hairline, shape)
            .clearAndSetSemantics {},
        contentAlignment = Alignment.Center,
    ) {
        val loaded = image
        when {
            emoji != null -> Text(emoji, fontSize = fontSize)
            loaded != null -> Image(loaded, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(size))
            else -> Icon(fallback, contentDescription = null, tint = t.secondaryText, modifier = Modifier.size(size * 0.4f))
        }
    }
}
