/*
 * From Termux (https://github.com/termux/termux-app), tag v0.118.1,
 * terminal-emulator/src/main/java/com/termux/terminal/Logger.java. Licensed under the Apache License, Version 2.0
 * (see LICENSE-APACHE-2.0.txt in dev/aispace/android/terminal).
 * Modified for ai-space: package renamed.
 */
package dev.aispace.android.terminal.emulator;

import android.util.Log;

import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;

public class Logger {

    public static void logError(TerminalSessionClient client, String logTag, String message) {
        if (client != null)
            client.logError(logTag, message);
        else
            Log.e(logTag, message);
    }

    public static void logWarn(TerminalSessionClient client, String logTag, String message) {
        if (client != null)
            client.logWarn(logTag, message);
        else
            Log.w(logTag, message);
    }

    public static void logInfo(TerminalSessionClient client, String logTag, String message) {
        if (client != null)
            client.logInfo(logTag, message);
        else
            Log.i(logTag, message);
    }

    public static void logDebug(TerminalSessionClient client, String logTag, String message) {
        if (client != null)
            client.logDebug(logTag, message);
        else
            Log.d(logTag, message);
    }

    public static void logVerbose(TerminalSessionClient client, String logTag, String message) {
        if (client != null)
            client.logVerbose(logTag, message);
        else
            Log.v(logTag, message);
    }

    public static void logStackTraceWithMessage(TerminalSessionClient client, String tag, String message, Throwable throwable) {
        logError(client, tag, getMessageAndStackTraceString(message, throwable));
    }

    public static String getMessageAndStackTraceString(String message, Throwable throwable) {
        if (message == null && throwable == null)
            return null;
        else if (message != null && throwable != null)
            return message + ":\n" + getStackTraceString(throwable);
        else if (throwable == null)
            return message;
        else
            return getStackTraceString(throwable);
    }

    public static String getStackTraceString(Throwable throwable) {
        if (throwable == null) return null;

        String stackTraceString = null;

        try {
            StringWriter errors = new StringWriter();
            PrintWriter pw = new PrintWriter(errors);
            throwable.printStackTrace(pw);
            pw.close();
            stackTraceString = errors.toString();
            errors.close();
        } catch (IOException e) {
            e.printStackTrace();
        }

        return stackTraceString;
    }

}
