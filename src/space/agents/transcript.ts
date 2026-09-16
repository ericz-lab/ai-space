/**
 * Past chat sessions are read from each runtime's own records; the readers
 * live with the runtime adapters (`../runtimes/transcripts.ts`). Kept as the
 * agents module's import path.
 */
export { SESSION_ID_RE, parseClaudeTranscript as parseTranscript, readClaudeTranscript as readTranscript, claudeTranscriptPath as transcriptPath } from "../runtimes/transcripts.ts";
export type { TranscriptMessage } from "../runtimes/types.ts";
