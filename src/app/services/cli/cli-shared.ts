import type { AnchorState } from '../../domain/anchoring/anchor'
import type { Severity } from '../../domain/operations/contract'
import type { EditorRunState, RunHandle } from '../orchestration/run-controller'

/**
 * Shared machinery for the `ai-editor:*` CLI subcommands (design doc
 * "Interaction surfaces" §4). The review, cancel, and status handlers must
 * stay in lockstep — a finding printed by `ai-editor:status` has the exact
 * same shape as one printed by `ai-editor:review` — so the common flag
 * parsing, finding/summary shaping, and text rendering live here instead of
 * being duplicated per subcommand. Obsidian-free by design, like every pure
 * CLI core in this directory.
 */

// ---------------------------------------------------------------------------
// Flag metadata + parsing
// ---------------------------------------------------------------------------

/** Structural twin of Obsidian's `CliFlag` (kept Obsidian-import-free). */
export interface CliFlagSpec {
    value?: string
    description: string
    required?: boolean
}

export type CliFormat = 'json' | 'text'

/**
 * Parses the required `file` flag from `CliData`-shaped params. `null` when
 * the flag is missing or blank; the value is trimmed otherwise.
 */
export function parseFileFlag(params: Readonly<Record<string, string | undefined>>): string | null {
    const raw = params['file']
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
}

/**
 * Parses the optional `format` flag. Tolerant by design: any value other
 * than `text` falls back to `json`.
 */
export function parseFormatFlag(params: Readonly<Record<string, string | undefined>>): CliFormat {
    return params['format'] === 'text' ? 'text' : 'json'
}

// ---------------------------------------------------------------------------
// Finding shape (design §4 — one shape across every subcommand)
// ---------------------------------------------------------------------------

export interface CliAnchor {
    readonly from: number
    readonly to: number
    readonly state: AnchorState
}

export interface CliFinding {
    readonly id: string
    /** Display name of the editor persona that produced the finding. */
    readonly editor: string
    readonly severity: Severity
    readonly quote: string
    readonly critique: string
    readonly suggestion: string | null
    /** `null` when the quote could not be located in the note. */
    readonly anchor: CliAnchor | null
}

/**
 * Shapes a run's finding store into the CLI finding documents, resolving
 * editor ids to display names through the run's editor states.
 */
export function shapeFindings(run: RunHandle): CliFinding[] {
    const nameByEditorId = new Map<string, string>()
    for (const state of run.getEditorStates()) {
        nameByEditorId.set(state.editorId, state.editorName)
    }
    return run.findings.list().map((finding) => ({
        id: finding.id,
        editor: nameByEditorId.get(finding.editorId) ?? finding.editorId,
        severity: finding.raw.severity,
        quote: finding.raw.quote,
        critique: finding.raw.critique,
        suggestion: finding.raw.suggestion ?? null,
        anchor: finding.anchor
            ? { from: finding.anchor.from, to: finding.anchor.to, state: finding.anchor.state }
            : null
    }))
}

/** Collects each editor's note-level summary, keyed by editor name. */
export function shapeSummaryByEditor(states: readonly EditorRunState[]): Record<string, string> {
    const summaryByEditor: Record<string, string> = {}
    for (const state of states) {
        if (state.summary !== null) {
            summaryByEditor[state.editorName] = state.summary
        }
    }
    return summaryByEditor
}

// ---------------------------------------------------------------------------
// Text rendering
// ---------------------------------------------------------------------------

/** Collapses all whitespace runs so multi-line model text stays on one line. */
export function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

/**
 * One finding as one text line (`[severity] Editor 12-45: "quote" — critique
 * -> suggestion`) — the single rendering shared by `--format text` across
 * subcommands.
 */
export function formatFindingLine(finding: CliFinding): string {
    const anchor = finding.anchor
        ? `${finding.anchor.from}-${finding.anchor.to}${
              finding.anchor.state === 'stale' ? ' (stale)' : ''
          }`
        : 'unanchored'
    const suggestion = finding.suggestion === null ? '' : ` -> ${oneLine(finding.suggestion)}`
    return `[${finding.severity}] ${finding.editor} ${anchor}: "${oneLine(finding.quote)}" — ${oneLine(
        finding.critique
    )}${suggestion}`
}
