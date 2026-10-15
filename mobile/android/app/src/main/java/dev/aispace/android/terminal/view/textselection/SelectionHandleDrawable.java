package dev.aispace.android.terminal.view.textselection;

import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.drawable.Drawable;

/**
 * A text selection handle drawn in code, in place of Termux's two vector resources: a disc with
 * the corner that points at the selection squared off (the top right one for the start handle,
 * the top left one for the end handle). 48dp by 24dp like the originals, so the hotspots in
 * {@link TextSelectionHandleView} (3/4 and 1/4 of the width) still land on the corner.
 */
public final class SelectionHandleDrawable extends Drawable {

    /** The handles' colour; {@code TerminalSurface} sets it to the theme's accent. */
    private static volatile int sColor = 0xFF8B5CF6;

    private final Paint mPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path mPath = new Path();
    private final int mWidth;
    private final int mHeight;
    private final boolean mLeft;

    SelectionHandleDrawable(float density, boolean left) {
        mWidth = Math.round(48 * density);
        mHeight = Math.round(24 * density);
        mLeft = left;
    }

    /** Sets the colour of the handles drawn from now on. */
    public static void setColor(int argb) {
        sColor = argb;
    }

    @Override
    public int getIntrinsicWidth() {
        return mWidth;
    }

    @Override
    public int getIntrinsicHeight() {
        return mHeight;
    }

    @Override
    public void draw(Canvas canvas) {
        float r = mHeight / 2f;
        float cx = mWidth / 2f;
        mPath.reset();
        mPath.addCircle(cx, r, r, Path.Direction.CW);
        if (mLeft) {
            mPath.addRect(cx, 0, cx + r, r, Path.Direction.CW);
        } else {
            mPath.addRect(cx - r, 0, cx, r, Path.Direction.CW);
        }
        mPaint.setColor(sColor);
        canvas.drawPath(mPath, mPaint);
    }

    @Override
    public void setAlpha(int alpha) {
        mPaint.setAlpha(alpha);
    }

    @Override
    public void setColorFilter(ColorFilter colorFilter) {
        mPaint.setColorFilter(colorFilter);
    }

    @Override
    @SuppressWarnings("deprecation")
    public int getOpacity() {
        return PixelFormat.TRANSLUCENT;
    }
}
