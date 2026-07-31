import type { EditorRunStatus, RunHandle } from '../orchestration/run-controller'
import type { CliFinding, CliFlagSpec, CliFormat } from './cli-shared'
import {
    formatFindingLine,
    oneLine,
    parseFileFlag,
    parseFormatFlag,
    shapeFindings,
    shapeSummaryByEditor
} from './cli-shared'

/**
 * Pure core of the `editor-ai-daemons:status` CLI subcommand (design doc
 * "Interaction surfaces" §4). Obsidian-free by design: file resolution and
 * run lookup are injected as `StatusCliDeps`, so the whole report — both
 * output formats included — is unit-testable. The Obsidian glue
 * (`cli/register-run-cli.ts`) binds the deps to the live vault and the
 * shared `RunController` and registers the handler.
 *
 * Contract:
 * - Reports the current run for a note WITHOUT running anything: an
 *   external agent polls `editor-ai-daemons:status` while a long `editor-ai-daemons:review`
 *   (or a UI-started run) is in flight, and reads the same document after
 *   settle or after `editor-ai-daemons:cancel` (cancel never discards the run).
 * - `run: null` (still `ok: true`) when no run is tracked for the note —
 *   absence of a run is an answer, not an error.
 * - Findings are shaped by the exact same `shapeFindings` as
 *   `editor-ai-daemons:review`, so the two subcommands stay in lockstep by
 *   construction; `summaryByEditor` likewise.
 * - Per-editor `error` entries already passed the run's redaction seam
 *   (Business Rules #12) before reaching `EditorRunState`; the handler
 *   itself never composes a message from anything model- or
 *   backend-derived.
 */

// ---------------------------------------------------------------------------
// Command metadata (consumed by the registration glue)
// ---------------------------------------------------------------------------

export const STATUS_CLI_COMMAND = 'editor-ai-daemons:status'

export const STATUS_CLI_DESCRIPTION = 'Show the state of the AI review run for a note'

export const STATUS_CLI_FLAGS: Record<string, CliFlagSpec> = {
    file: {
        value: '<path>',
        description: 'Vault path of the note whose review run to inspect',
        required: true
    },
    format: {
        value: '<json|text>',
        description:
            'Output format: json (default) or text (status headline + one line per finding)'
    }
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export type StatusCliErrorCode = 'bad-args' | 'file-not-found'

export interface StatusCliError {
    readonly code: StatusCliErrorCode
    readonly message: string
}

export interface StatusCliEditor {
    readonly id: string
    readonly name: string
    readonly status: EditorRunStatus
    /** Redacted per-editor failure (BR #12); `null` unless status is error. */
    readonly error: { readonly code: string; readonly message: string } | null
}

export interface StatusCliRun {
    /** Whether every editor stream has reached a terminal state. */
    readonly settled: boolean
    readonly editors: readonly StatusCliEditor[]
    /** Same shape as the `editor-ai-daemons:review` output (`cli-shared.ts`). */
    readonly findings: readonly CliFinding[]
    readonly summaryByEditor: Readonly<Record<string, string>>
}

export interface StatusCliOutput {
    readonly ok: boolean
    readonly file: string
    /** `null` when no run is tracked for the note (still `ok: true`). */
    readonly run: StatusCliRun | null
    readonly error: StatusCliError | null
}

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

export interface StatusCliDeps {
    /**
     * Resolves user input (vault path, with or without `.md`, or link text)
     * to the vault-relative path of an existing markdown note. `null` when
     * no such note exists.
     */
    readonly resolveFile: (file: string) => string | null
    /**
     * The current run for a note, if any. Production binds this to
     * `RunController.getRun` — read-only access to the same per-file slot
     * every other surface reads; status never mutates run state.
     */
    readonly getRun: (path: string) => RunHandle | null
}

// ---------------------------------------------------------------------------
// Output shaping
// ---------------------------------------------------------------------------

/** Editor statuses that count as terminal for the `settled` report. */
const TERMINAL_STATUSES: ReadonlySet<EditorRunStatus> = new Set(['done', 'error', 'cancelled'])

/** Shapes a (possibly still running) run into the status report document. */
export function shapeStatusRun(run: RunHandle): StatusCliRun {
    const states = run.getEditorStates()
    return {
        // Derived from the editor states, not `run.isSettled()`: cancelRun
        // marks every editor terminal synchronously, but the settle promise
        // resolves only after the aborted loops unwind — a cancel followed
        // quickly by a status poll must not report "in progress" while every
        // editor already shows cancelled.
        settled: states.length > 0 && states.every((state) => TERMINAL_STATUSES.has(state.status)),
        editors: states.map((state) => ({
            id: state.editorId,
            name: state.editorName,
            status: state.status,
            error: state.error ? { code: state.error.code, message: state.error.message } : null
        })),
        findings: shapeFindings(run),
        summaryByEditor: shapeSummaryByEditor(states)
    }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const EDITOR_STATUS_ORDER: readonly EditorRunStatus[] = [
    'running',
    'pending',
    'done',
    'error',
    'cancelled'
]

/**
 * The status headline: run phase, per-status editor counts, and the finding
 * count so far — e.g. `Run in progress (1 running, 1 done) — 2 findings so
 * far` / `Run settled (2 done, 1 error) — 5 findings`.
 */
export function formatStatusHeadline(run: StatusCliRun): string {
    const counts = new Map<EditorRunStatus, number>()
    for (const editor of run.editors) {
        counts.set(editor.status, (counts.get(editor.status) ?? 0) + 1)
    }
    const breakdown = EDITOR_STATUS_ORDER.filter((status) => (counts.get(status) ?? 0) > 0)
        .map((status) => `${counts.get(status)} ${status}`)
        .join(', ')
    const findings = `${run.findings.length} ${run.findings.length === 1 ? 'finding' : 'findings'}`
    return run.settled
        ? `Run settled (${breakdown}) — ${findings}`
        : `Run in progress (${breakdown}) — ${findings} so far`
}

/**
 * Text rendering: a single status headline followed by one line per finding
 * (same line format as `editor-ai-daemons:review --format text`); `No run for …`
 * when nothing is tracked; a single `Error (code): …` line on failure.
 */
export function formatStatusText(output: StatusCliOutput): string {
    if (output.error) {
        return `Error (${output.error.code}): ${oneLine(output.error.message)}`
    }
    if (output.run === null) {
        return `No run for ${output.file}.`
    }
    const lines: string[] = [formatStatusHeadline(output.run)]
    for (const finding of output.run.findings) {
        lines.push(formatFindingLine(finding))
    }
    return lines.join('\n')
}

function render(output: StatusCliOutput, format: CliFormat): string {
    return format === 'text' ? formatStatusText(output) : JSON.stringify(output)
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles one `editor-ai-daemons:status` invocation: parse the flags, resolve the
 * note, look up its run, and render the report in the requested format.
 * Never throws — every outcome renders as parseable output.
 */
export function handleStatusCli(
    params: Readonly<Record<string, string | undefined>>,
    deps: StatusCliDeps
): string {
    const format = parseFormatFlag(params)

    const file = parseFileFlag(params)
    if (file === null) {
        // Distinct from file-not-found so scripts can tell "I forgot the
        // flag" from "the note does not exist" by code alone. Mostly
        // defensive: Obsidian enforces required flags before the handler.
        return render(errorOutput('bad-args', '', 'Missing required flag: file'), format)
    }

    const path = deps.resolveFile(file)
    if (path === null) {
        return render(errorOutput('file-not-found', file, `File not found: ${file}`), format)
    }

    const run = deps.getRun(path)
    if (run === null) {
        return render({ ok: true, file: path, run: null, error: null }, format)
    }
    return render({ ok: true, file: path, run: shapeStatusRun(run), error: null }, format)
}

function errorOutput(code: StatusCliErrorCode, file: string, message: string): StatusCliOutput {
    return { ok: false, file, run: null, error: { code, message } }
}
