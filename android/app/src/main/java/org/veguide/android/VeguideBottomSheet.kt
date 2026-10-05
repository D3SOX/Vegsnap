package org.veguide.android

import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.unit.Velocity

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun VeguideBottomSheet(
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    dragHandle: @Composable () -> Unit = { BottomSheetDefaults.DragHandle() },
    content: @Composable ColumnScope.() -> Unit,
) {
    val scrollBoundary = remember {
        object : NestedScrollConnection {
            override suspend fun onPostFling(consumed: Velocity, available: Velocity): Velocity =
                // The sheet's pre-fling already handles upward movement needed to expand it.
                // At the end of the content, do not spring the expanded sheet with leftover
                // upward velocity. Downward velocity still reaches swipe-to-dismiss.
                if (available.y < 0f) Velocity(0f, available.y) else Velocity.Zero
        }
    }
    ModalBottomSheet(onDismissRequest = onDismissRequest, modifier = modifier,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), dragHandle = dragHandle) {
        Column(Modifier.nestedScroll(scrollBoundary), content = content)
    }
}
