/**
 * The CLI security boundary (Business Rules #9, plan M7).
 *
 * Everything that starts a local process goes through `spawnCliProcess`.
 * Per-tool adapters (Claude Code, Codex) build the argv and interpret the
 * output; they do not get to decide how the process is created, what it can
 * see, or how it is stopped.
 */
export { BoundedCapture, DEFAULT_MAX_STDERR_BYTES, DEFAULT_MAX_STDOUT_BYTES } from './capture'
export type { StderrDiagnostics } from './capture'
export { cliTimeoutMs, createCliEditorExecutor, resolveCliModel } from './cli-editor-backend'
export type {
    CliEditorExecutor,
    CreateCliEditorExecutorInput,
    SpawnCliProcessFn
} from './cli-editor-backend'
export { cliCandidatePaths, cliCommandName, detectCliExecutables, detectionSummary } from './detect'
export type { CliCandidate, CliDetectionResult } from './detect'
export { buildCliEnv } from './env'
export type { CliEnvResult, EnvProblem } from './env'
export { validateExecutablePath } from './executable'
export type { ExecutableProbe, ExecutableProblem, ExecutableValidation } from './executable'
export { DEFAULT_KILL_GRACE_MS, runKillEscalation } from './kill'
export type { KillResult } from './kill'
export { createTempRunDir, nodeExecutableProbe, nodeHomeDirectory } from './node-fs'
export type { CreateRunDir, RunDirHandle } from './node-fs'
export { killProcessTree } from './node-process'
export { currentCliPlatform, toCliPlatform } from './platform'
export type { CliPlatform } from './platform'
export { parseJsonDocument, parseJsonLines } from './protocol'
export type { CliProtocolProblem, CliProtocolResult } from './protocol'
export { MAX_ARGUMENT_LENGTH, spawnCliProcess, validateCliArguments } from './spawn'
export type { CliProcessFailureCode, CliProcessOutcome, SpawnCliProcessInput } from './spawn'
export {
    buildCliStdin,
    claudeCodeAdapter,
    codexAdapter,
    getCliToolAdapter,
    safeStatusToken
} from './tools'
export type {
    BuildCliInvocationInput,
    CliEnvelope,
    CliEnvelopeErrorCode,
    CliInvocation,
    CliOutputProtocol,
    CliToolAdapter,
    CliToolCapabilities,
    CliToolKind
} from './tools'
