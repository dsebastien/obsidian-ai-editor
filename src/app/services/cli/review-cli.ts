import type { EditorConfig, PluginSettingsV1 } from '../../domain/settings/settings-schema'
import type { DocumentSnapshot } from '../../domain/snapshot'
import { createSnapshot } from '../../domain/snapshot'
import { resolveTopFix, scorecardMembers } from '../../domain/panels/scorecard-model'
import type { TopFixCandidate } from '../../domain/panels/scorecard-model'
import type { PanelAggregationStatus, RunHandle } from '../orchestration/run-controller'
import type { EditorSkip, ReviewStart } from '../review-service'
import { skipReasonLabel } from '../review-service'
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
 * Pure core of the `ai-editor:review` CLI subcommand (design doc
 * "Interaction surfaces" §4). Obsidian-free by design: the vault, the
 * settings, and the review pipeline are injected as `ReviewCliDeps`, so arg
 * parsing, every typed error code, and both output formats are fully
 * unit-testable. The Obsidian glue (`cli/register-review-cli.ts`) binds the
 * deps to the live plugin and registers the handler.
 *
 * Contract (buffered — the CLI API returns a single string):
 * - Runs one review through the exact same `startReview` pipeline as the
 *   `Review current note` command (shared refusals: exclusions, size guard,
 *   editor/backend resolution), waits for the run to settle — including the
 *   scorecard when the run is a panel run — and returns one JSON document
 *   (default) or one line per finding (`--format text`).
 * - Errors are typed codes (`file-not-found`, `excluded`, `rule-disabled`,
 *   `needs-confirmation`, `no-editors`, `backend-error`, `timeout`) with
 *   status-only messages: per-editor failure messages already passed the
 *   run's redaction seam (Business Rules #12), and unexpected pipeline
 *   failures are reported without echoing their message at all.
 * - Nothing runs without an explicit user action (Business Rules #1): a CLI
 *   invocation IS the explicit action, and the size guard still refuses
 *   oversized notes unless `--confirm-large` is passed.
 */

// ---------------------------------------------------------------------------
// Command metadata (consumed by the registration glue)
// ---------------------------------------------------------------------------

export const REVIEW_CLI_COMMAND = 'ai-editor:review'

export const REVIEW_CLI_DESCRIPTION = 'Review a note with the configured AI editors'

export const REVIEW_CLI_FLAGS: Record<string, CliFlagSpec> = {
    'file': {
        value: '<path>',
        description: 'Vault path of the note to review',
        required: true
    },
    'editors': {
        value: '<ids-or-names>',
        description: 'Comma-separated editor ids or names (default: every enabled editor)'
    },
    'format': {
        value: '<json|text>',
        description: 'Output format: json (default) or text (one line per finding)'
    },
    'confirm-large': {
        description: 'Confirm reviewing a note above the size warning threshold'
    }
}

// ---------------------------------------------------------------------------
// Output shape (design §4 — one document, machine-readable)
// ---------------------------------------------------------------------------

export type ReviewCliErrorCode =
    | 'bad-args'
    | 'file-not-found'
    | 'excluded'
    | 'rule-disabled'
    | 'needs-confirmation'
    | 'no-editors'
    | 'panel-unavailable'
    | 'backend-error'
    | 'timeout'

/**
 * The finding shape is shared with `ai-editor:status` (`cli-shared.ts`) so
 * both subcommands report byte-identical finding documents.
 */
export type ReviewCliFinding = CliFinding

/**
 * One editor that produced no findings and why: pre-run skips carry the
 * review service's `SkipReason` codes; editors that failed after the run
 * started are reported as `backend-error`, `timeout`, or `cancelled`; an
 * editor whose per-editor retry is still in flight when the one-shot output
 * is shaped is reported as `retrying` (read its outcome via
 * `ai-editor:status`).
 */
export interface ReviewCliSkip {
    readonly editor: string
    readonly reason: string
}

export interface ReviewCliError {
    readonly code: ReviewCliErrorCode
    readonly message: string
}

/**
 * The panel's scorecard, when the run was a panel run (plan M6).
 *
 * The CLI waits for it rather than shaping the members alone: the aggregation
 * is dispatched the moment the members settle, so a CLI that returned without
 * it would bill the user for a request whose answer nothing ever shows. Every
 * non-`done` status still renders — a scorecard that failed costs a synthesis,
 * never the member reviews, which are in `findings` either way.
 */
export interface ReviewCliPanel {
    readonly name: string
    readonly status: PanelAggregationStatus
    /** The panel's overall verdict; `null` until a scorecard exists. */
    readonly verdict: string | null
    readonly rationale: string | null
    /**
     * One entry per member the scorecard names, reconciled against the run's
     * roster: a name the panel invented is dropped, and a member it never
     * mentioned appears with a null verdict.
     */
    readonly members: readonly ReviewCliPanelMember[]
    /** Ranked, most important first, as the panel ordered them. */
    readonly topFixes: readonly ReviewCliPanelFix[]
    readonly dissent: readonly ReviewCliPanelDissent[]
    /** Members that produced no review and were therefore not weighed. */
    readonly missingMembers: readonly string[]
    /** Redacted failure message when `status` is `error`. */
    readonly error: string | null
}

export interface ReviewCliPanelMember {
    readonly editor: string
    readonly verdict: string | null
    readonly keyPoint: string | null
    /** True when the member produced no review at all. */
    readonly missing: boolean
}

export interface ReviewCliPanelFix {
    readonly rank: number
    readonly action: string
    /** The member credited with the underlying finding, when named. */
    readonly editor: string | null
    /** That finding's quote, so a script can locate the span. */
    readonly quote: string | null
}

export interface ReviewCliPanelDissent {
    readonly subject: string
    readonly positions: readonly { readonly editor: string; readonly stance: string }[]
}

export interface ReviewCliOutput {
    readonly ok: boolean
    readonly file: string
    readonly findings: readonly ReviewCliFinding[]
    readonly skips: readonly ReviewCliSkip[]
    readonly summaryByEditor: Readonly<Record<string, string>>
    /** The scorecard for a panel run; `null` for a solo run. */
    readonly panel: ReviewCliPanel | null
    readonly error: ReviewCliError | null
}

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

export interface ReviewCliRunInput {
    readonly settings: PluginSettingsV1
    readonly snapshot: DocumentSnapshot
    readonly confirmedLargeNote: boolean
}

export interface ReviewCliDeps {
    readonly getSettings: () => PluginSettingsV1
    /**
     * Resolves user input (vault path, with or without `.md`, or link text)
     * to the vault-relative path of an existing markdown note. `null` when
     * no such note exists.
     */
    readonly resolveFile: (file: string) => string | null
    /** Reads a note's raw markdown; `null` when it cannot be read. */
    readonly readNote: (path: string) => Promise<string | null>
    /**
     * Dispatches the review run. Production binds this to the review
     * service's `startReview` (closing over the vault reader, the shared
     * `RunController`, and the network seam) so the CLI shares every refusal
     * and guarantee with the command surfaces. The production glue may
     * substitute a live editor-buffer snapshot for `input.snapshot` when the
     * note is open in a view (the buffer, not the saved vault state, is what
     * decorations must anchor against) and binds the started run to the view
     * glue synchronously so edits typed during the run keep remapping
     * anchors.
     */
    readonly runReview: (input: ReviewCliRunInput) => Promise<ReviewStart>
    /**
     * Called once per started run, after it settled and the output document
     * was shaped. Production discards the run from the `RunController` when
     * the note is not open in any view — a CLI-only run has no UI surface to
     * live on, and retained runs pin the full snapshot text plus the finding
     * store for the lifetime of the plugin (batch CLI usage would accumulate
     * unboundedly). Runs on open notes are kept: they show in the
     * rail/panel/highlights like any other run. The settled run handle is
     * passed so the glue can verify it still owns the controller slot — a
     * newer run started while this one settled must never be discarded.
     */
    readonly releaseRun?: (path: string, run: RunHandle) => void
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export type ReviewCliFormat = CliFormat

export interface ReviewCliArgs {
    /** `null` when the required flag is missing or blank. */
    readonly file: string | null
    /** Requested editor ids/names; `null` = every enabled editor. */
    readonly editors: readonly string[] | null
    readonly format: ReviewCliFormat
    readonly confirmLarge: boolean
}

/**
 * Parses `CliData`-shaped args (values are strings; boolean flags arrive as
 * `'true'`). Tolerant by design: an unknown `format` value falls back to
 * `json`, a present `confirm-large` flag counts as confirmation regardless
 * of its value, and blank list entries are dropped.
 */
export function parseReviewCliArgs(
    params: Readonly<Record<string, string | undefined>>
): ReviewCliArgs {
    const file = parseFileFlag(params)

    const editorsRaw = params['editors']
    const editors =
        typeof editorsRaw === 'string'
            ? editorsRaw
                  .split(',')
                  .map((token) => token.trim())
                  .filter((token) => token.length > 0)
            : []

    return {
        file,
        editors: editors.length > 0 ? editors : null,
        format: parseFormatFlag(params),
        confirmLarge: params['confirm-large'] !== undefined
    }
}

// ---------------------------------------------------------------------------
// Editor selection (--editors)
// ---------------------------------------------------------------------------

export type EditorSelection =
    | { readonly ok: true; readonly settings: PluginSettingsV1 }
    | {
          readonly ok: false
          readonly unknown: readonly string[]
          readonly disabled: readonly string[]
      }

/**
 * Narrows the settings to the requested editors. Tokens match an editor id
 * exactly or an editor name case-insensitively (first match wins on
 * duplicate names); duplicates collapse. Any unknown OR disabled token fails
 * the whole selection: a partial review behind a typo would be silent data
 * loss for scripts, and an explicitly requested disabled editor would
 * otherwise be dropped by the pipeline without even a skip entry (the run
 * only reports skips for ENABLED editors that cannot participate).
 */
export function selectEditors(
    settings: PluginSettingsV1,
    requested: readonly string[] | null
): EditorSelection {
    if (requested === null) {
        return { ok: true, settings }
    }
    const matched: EditorConfig[] = []
    const unknown: string[] = []
    const disabled: string[] = []
    for (const token of requested) {
        const editor = settings.editors.find(
            (candidate) =>
                candidate.id === token || candidate.name.toLowerCase() === token.toLowerCase()
        )
        if (!editor) {
            unknown.push(token)
            continue
        }
        if (!editor.enabled) {
            if (!disabled.includes(editor.name)) {
                disabled.push(editor.name)
            }
            continue
        }
        if (!matched.includes(editor)) {
            matched.push(editor)
        }
    }
    if (unknown.length > 0 || disabled.length > 0) {
        return { ok: false, unknown, disabled }
    }
    return { ok: true, settings: { ...settings, editors: matched } }
}

// ---------------------------------------------------------------------------
// Output shaping
// ---------------------------------------------------------------------------

function errorOutput(
    file: string,
    code: ReviewCliErrorCode,
    message: string,
    skips: readonly ReviewCliSkip[] = []
): ReviewCliOutput {
    return {
        ok: false,
        file,
        findings: [],
        skips,
        summaryByEditor: {},
        panel: null,
        error: { code, message }
    }
}

function toCliSkips(skips: readonly EditorSkip[]): ReviewCliSkip[] {
    return skips.map((skip) => ({ editor: skip.editorName, reason: skip.reason }))
}

/**
 * Shapes a settled run into the CLI output document. Every participating
 * editor is accounted for exactly once: its findings appear in `findings`,
 * its note-level summary in `summaryByEditor` (keyed by editor name), and a
 * post-run failure joins the pre-run skips (`backend-error` / `timeout` /
 * `cancelled`). `ok` is true when at least one editor completed; when none
 * did, the overall error code is `timeout` only if every failure was a
 * timeout, `backend-error` otherwise — with the (already redacted,
 * Business Rules #12) per-editor messages joined.
 *
 * Non-terminal editors are possible here even though the CLI awaits the
 * run's settle: `settled` keeps FIRST-settle semantics (a promise cannot
 * un-resolve), while a per-editor retry started from the rail/panel of an
 * open note flips that editor back to pending/running. Such an editor is
 * reported as a `retrying` skip — never silently dropped — and its final
 * findings stay readable via `ai-editor:status`.
 */
export function shapeRunOutput(
    file: string,
    run: RunHandle,
    skips: readonly EditorSkip[]
): ReviewCliOutput {
    const states = run.getEditorStates()
    const findings = shapeFindings(run)
    const summaryByEditor = shapeSummaryByEditor(states)

    const allSkips: ReviewCliSkip[] = toCliSkips(skips)
    for (const state of states) {
        if (state.status === 'error') {
            allSkips.push({
                editor: state.editorName,
                reason: state.error?.code === 'timeout' ? 'timeout' : 'backend-error'
            })
        } else if (state.status === 'cancelled') {
            allSkips.push({ editor: state.editorName, reason: 'cancelled' })
        } else if (state.status !== 'done') {
            // pending/running = a retry in flight (see the doc comment).
            allSkips.push({ editor: state.editorName, reason: 'retrying' })
        }
    }

    const panel = shapePanel(run)

    const anyDone = states.some((state) => state.status === 'done')
    if (anyDone) {
        return { ok: true, file, findings, skips: allSkips, summaryByEditor, panel, error: null }
    }

    const failed = states.filter((state) => state.status === 'error')
    const retrying = states.some(
        (state) => state.status === 'pending' || state.status === 'running'
    )
    const code: ReviewCliErrorCode =
        failed.length > 0 && failed.every((state) => state.error?.code === 'timeout')
            ? 'timeout'
            : 'backend-error'
    const message =
        failed.length > 0
            ? failed
                  .map((state) => `${state.editorName}: ${state.error?.message ?? 'failed'}`)
                  .join('; ')
            : retrying
              ? 'A retry is still in flight — read the final result with ai-editor:status'
              : 'The run was cancelled before any editor completed'
    return {
        ok: false,
        file,
        findings,
        skips: allSkips,
        summaryByEditor,
        panel,
        error: { code, message }
    }
}

/**
 * Shapes a panel run's aggregation state; `null` for a solo run.
 *
 * The two reconciliations come from the domain (`scorecardMembers`,
 * `resolveTopFix`) — the same ones the side panel renders — so the CLI and the
 * UI cannot disagree about which members a scorecard names or whom a fix
 * credits. Only the wire vocabulary is decided here.
 */
function shapePanel(run: RunHandle): ReviewCliPanel | null {
    const state = run.getPanelState()
    if (state === null) {
        return null
    }
    const candidates = topFixCandidates(run)
    const result = state.result
    return {
        name: state.panelName,
        status: state.status,
        verdict: result?.recommendation ?? null,
        rationale: result?.rationale ?? null,
        members: scorecardMembers({
            memberNames: state.memberNames,
            missingMembers: state.missingMembers,
            memberVerdicts: result?.memberVerdicts ?? []
        }).map((member) => ({
            editor: member.editorName,
            verdict: member.verdict,
            keyPoint: member.keyPoint,
            missing: member.missing
        })),
        topFixes: (result?.topFixes ?? []).map((fix, index) => ({
            rank: index + 1,
            action: fix.action,
            // The RESOLVED owner, not the credited one: the cross-member
            // fallback may have matched another member's finding, and the
            // quote below is that finding's.
            editor: resolveTopFix(fix, candidates)?.editorName ?? fix.editorName ?? null,
            quote: fix.quote ?? null
        })),
        dissent: (result?.dissent ?? []).map((entry) => ({
            subject: entry.subject,
            positions: entry.positions.map((position) => ({
                editor: position.editorName,
                stance: position.stance
            }))
        })),
        missingMembers: state.missingMembers,
        error: state.error
    }
}

/** Live findings a top fix may point at, in the shared candidate shape. */
function topFixCandidates(run: RunHandle): TopFixCandidate[] {
    const candidates: TopFixCandidate[] = []
    for (const state of run.getEditorStates()) {
        for (const id of state.findingIds) {
            const finding = run.findings.get(id)
            if (finding === null || (finding.status !== 'open' && finding.status !== 'preview')) {
                continue
            }
            candidates.push({
                id: finding.id,
                editorName: state.editorName,
                quote: finding.raw.quote
            })
        }
    }
    return candidates
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Text rendering: one line per finding (`[severity] Editor 12-45: "quote" —
 * critique -> suggestion`), one `Skipped …` line per skip, a single `Error
 * (code): …` line on failure, and `No findings.` when a successful run found
 * nothing.
 */
export function formatTextOutput(output: ReviewCliOutput): string {
    const lines: string[] = []
    if (output.error) {
        lines.push(`Error (${output.error.code}): ${oneLine(output.error.message)}`)
    } else if (output.findings.length === 0) {
        lines.push('No findings.')
    }
    for (const finding of output.findings) {
        lines.push(formatFindingLine(finding))
    }
    for (const skip of output.skips) {
        lines.push(`Skipped ${skip.editor}: ${skip.reason}`)
    }
    lines.push(...panelTextLines(output.panel))
    return lines.join('\n')
}

/**
 * The scorecard's text rendering: the verdict line, one line per member, the
 * ranked fixes, then each disagreement. Nothing is folded away on a non-`done`
 * status — "the scorecard was cancelled" is the answer a script needs, and the
 * member findings above it are unaffected either way.
 */
function panelTextLines(panel: ReviewCliPanel | null): string[] {
    if (panel === null) {
        return []
    }
    const lines = [
        panel.verdict === null
            ? `Panel ${panel.name}: ${panel.status}`
            : `Panel ${panel.name}: ${panel.verdict} (${panel.status})`
    ]
    if (panel.error !== null) {
        lines.push(`Panel error: ${oneLine(panel.error)}`)
    }
    if (panel.rationale !== null) {
        lines.push(`Panel rationale: ${oneLine(panel.rationale)}`)
    }
    for (const member of panel.members) {
        lines.push(
            `Member ${member.editor}: ${member.missing ? 'no review' : (member.verdict ?? 'no verdict')}`
        )
    }
    for (const fix of panel.topFixes) {
        lines.push(
            `Fix ${fix.rank}${fix.editor === null ? '' : ` (${fix.editor})`}: ${oneLine(fix.action)}`
        )
    }
    for (const entry of panel.dissent) {
        lines.push(
            `Dissent — ${oneLine(entry.subject)}: ${entry.positions
                .map((position) => `${position.editor}: ${oneLine(position.stance)}`)
                .join('; ')}`
        )
    }
    return lines
}

function render(output: ReviewCliOutput, format: ReviewCliFormat): string {
    return format === 'text' ? formatTextOutput(output) : JSON.stringify(output)
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles one `ai-editor:review` invocation end to end: parse args, resolve
 * and read the note, narrow to the requested editors, dispatch through the
 * injected review pipeline, wait for settle, and render the result in the
 * requested format. Never throws — every failure renders as a typed error
 * document (the CLI surface must always answer with parseable output).
 */
export async function handleReviewCli(
    params: Readonly<Record<string, string | undefined>>,
    deps: ReviewCliDeps
): Promise<string> {
    const args = parseReviewCliArgs(params)

    if (args.file === null) {
        // Distinct from file-not-found so scripts can tell "I forgot the
        // flag" from "the note does not exist" by code alone.
        return render(errorOutput('', 'bad-args', 'Missing required flag: file'), args.format)
    }

    const path = deps.resolveFile(args.file)
    if (path === null) {
        return render(
            errorOutput(args.file, 'file-not-found', `File not found: ${args.file}`),
            args.format
        )
    }

    const text = await deps.readNote(path)
    if (text === null) {
        return render(
            errorOutput(path, 'file-not-found', `File could not be read: ${path}`),
            args.format
        )
    }

    const selection = selectEditors(deps.getSettings(), args.editors)
    if (!selection.ok) {
        const parts: string[] = []
        if (selection.unknown.length > 0) {
            parts.push(`Unknown editors: ${selection.unknown.join(', ')}`)
        }
        if (selection.disabled.length > 0) {
            parts.push(
                `Disabled editors: ${selection.disabled.join(', ')} — enable them in the settings`
            )
        }
        return render(errorOutput(path, 'no-editors', parts.join('; ')), args.format)
    }

    const snapshot = createSnapshot({ filePath: path, text })
    let start: ReviewStart
    try {
        start = await deps.runReview({
            settings: selection.settings,
            snapshot,
            confirmedLargeNote: args.confirmLarge
        })
        if (start.status === 'started') {
            // The scorecard too, not just the members: a panel run dispatches
            // its aggregation the moment the members settle, so returning here
            // would abandon (and `releaseRun` would abort) a request the user
            // has already paid for. Solo runs resolve `panelSettled` at once.
            await Promise.all([start.run.settled, start.run.panelSettled])
        }
    } catch {
        // Status-only on purpose: an unexpected pipeline failure has not
        // passed any redaction seam, so its message is never echoed
        // (Business Rules #12).
        return render(
            errorOutput(path, 'backend-error', 'The review failed unexpectedly'),
            args.format
        )
    }

    switch (start.status) {
        case 'aborted':
            // Only reachable when a runner passes `abortWhen` (the daemon's
            // superseded guard); the CLI runner never does. Handled for
            // exhaustiveness — status-only, nothing was started.
            return render(
                errorOutput(path, 'backend-error', 'The review was aborted before it started'),
                args.format
            )
        case 'excluded':
            return render(
                errorOutput(
                    path,
                    'excluded',
                    'This note is excluded from AI review by the privacy settings'
                ),
                args.format
            )
        case 'rule-disabled':
            return render(
                errorOutput(
                    path,
                    'rule-disabled',
                    `AI Editor is disabled for this note by the rule ${start.ruleLabel}`
                ),
                args.format
            )
        case 'needs-confirmation':
            return render(
                errorOutput(
                    path,
                    'needs-confirmation',
                    `The note has ${start.wordCount} words (warning threshold ${start.limit}) — pass confirm-large to review it anyway`
                ),
                args.format
            )
        case 'no-editors': {
            const details = start.skips
                .map((skip) => `${skip.editorName} — ${skipReasonLabel(skip.reason)}`)
                .join('; ')
            return render(
                errorOutput(
                    path,
                    'no-editors',
                    details.length > 0 ? `No editor could run: ${details}` : 'No enabled editors',
                    toCliSkips(start.skips)
                ),
                args.format
            )
        }
        case 'panel-unavailable':
            return render(
                errorOutput(
                    path,
                    'panel-unavailable',
                    start.reason === 'panel-missing'
                        ? 'The requested panel no longer exists'
                        : 'The requested panel is disabled'
                ),
                args.format
            )
        case 'started': {
            // Shape BEFORE releasing: the output reads the run's finding
            // store, which the release may discard.
            const output = shapeRunOutput(path, start.run, start.skips)
            deps.releaseRun?.(path, start.run)
            return render(output, args.format)
        }
    }
}
