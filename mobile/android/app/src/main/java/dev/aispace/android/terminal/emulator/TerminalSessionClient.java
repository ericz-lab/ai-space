/*
 * From Termux (https://github.com/termux/termux-app), tag v0.118.1,
 * terminal-emulator/src/main/java/com/termux/terminal/TerminalSessionClient.java. Licensed under the Apache License, Version 2.0
 * (see LICENSE-APACHE-2.0.txt in dev/aispace/android/terminal).
 * Modified for ai-space: package renamed; the callbacks naming the removed TerminalSession dropped.
 */
package dev.aispace.android.terminal.emulator;

/**
 * The interface for communication between {@link TerminalEmulator} and its client. It is used to
 * send cursor state and logs back to the client. (ai-space: the callbacks that named Termux's local
 * {@code TerminalSession} were removed with that class; a remote session gets them through
 * {@link TerminalOutput}.)
 */
public interface TerminalSessionClient {

    void onTerminalCursorStateChange(boolean state);



    Integer getTerminalCursorStyle();



    void logError(String tag, String message);

    void logWarn(String tag, String message);

    void logInfo(String tag, String message);

    void logDebug(String tag, String message);

    void logVerbose(String tag, String message);

    void logStackTraceWithMessage(String tag, String message, Exception e);

    void logStackTrace(String tag, Exception e);

}
