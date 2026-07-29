import type { RunHandle } from '../orchestration/run-controller'
import type { CliFlagSpec } from './cli-shared'
import { parseFileFlag } from './cli-shared'

/**
 * Pure core of the `ai-editor:cancel` CLI subcommand (design doc
 * "Interaction surfaces" §4). Obsidian-free by design: file resolution and
 * run lookup are injected as `CancelCliDeps`, so the whole decision table is
 * unit-testable. The Obsidian glue (`cli/register-run-cli.ts`) binds the
 * deps to the live vault and the shared `RunController` and registers the
 * handler.
 *
 * Contract:
 * - Cancels the unsettled run for the note, when there is one. Cancelling
 *   NEVER discards the run: the findings collected so far stay inspectable
 *   through `ai-editor:status` and the review UI (rail/panel/highlights).
 *   Discard is a UI lifecycle concern (file closed/deleted), not a cancel
 *   side effect.
 * - Reports honestly when there was nothing to cancel: `cancelled: false`
 *   with `reason: 'no-run'` (no run tracked for the note) or
 *   `'already-settled'` (the run finished before the cancel arrived) —
 *   both are `ok: true` because the invocation itself worked.
 * - Output is always one JSON document (no `format` flag: there is nothing
 *   to list); errors are typed codes with status-only messages (Business
 *   Rules #12 — nothing model- or backend-derived is echoed here anyway).
 */

// ---------------------------------------------------------------------------
// Command metadata (consumed by the registration glue)
// ---------------------------------------------------------------------------

export const CANCEL_CLI_COMMAND = 'ai-editor:cancel'

export const CANCEL_CLI_DESCRIPTION = 'Cancel the in-flight AI review of a note'

export const CANCEL_CLI_FLAGS: Record<string, CliFlagSpec> = {
    file: {
        value: '<path>',
        description: 'Vault path of the note whose review run to cancel',
        required: true
    }
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export type CancelCliErrorCode = 'file-not-found'

export interface CancelCliError {
    readonly code: CancelCliErrorCode
    readonly message: string
}

/** Why nothing was cancelled even though the invocation succeeded. */
export type CancelCliSkipReason = 'no-run' | 'already-settled'

export type CancelCliOutput =
    | { readonly ok: true; readonly file: string; readonly cancelled: true }
    | {
          readonly ok: true
          readonly file: string
          readonly cancelled: false
          readonly reason: CancelCliSkipReason
      }
    | {
          readonly ok: false
          readonly file: string
          readonly cancelled: false
          readonly error: CancelCliError
      }

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

export interface CancelCliDeps {
    /**
     * Resolves user input (vault path, with or without `.md`, or link text)
     * to the vault-relative path of an existing markdown note. `null` when
     * no such note exists.
     */
    readonly resolveFile: (file: string) => string | null
    /**
     * The current run for a note, if any. Production binds this to
     * `RunController.getRun` — the same per-file slot every other surface
     * reads. Deliberately the ONLY run access the cancel handler gets:
     * there is no discard capability in these deps, so cancelling cannot
     * drop findings by construction.
     */
    readonly getRun: (path: string) => RunHandle | null
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles one `ai-editor:cancel` invocation: parse the `file` flag, resolve
 * the note, look up its run, and cancel it iff it has not settled. Never
 * throws — every outcome renders as one parseable JSON document.
 */
export function handleCancelCli(
    params: Readonly<Record<string, string | undefined>>,
    deps: CancelCliDeps
): string {
    const file = parseFileFlag(params)
    if (file === null) {
        return renderError('', 'Missing required flag: file')
    }

    const path = deps.resolveFile(file)
    if (path === null) {
        return renderError(file, `File not found: ${file}`)
    }

    const run = deps.getRun(path)
    if (run === null) {
        return render({ ok: true, file: path, cancelled: false, reason: 'no-run' })
    }
    if (run.isSettled()) {
        return render({ ok: true, file: path, cancelled: false, reason: 'already-settled' })
    }

    run.cancelRun()
    return render({ ok: true, file: path, cancelled: true })
}

function renderError(file: string, message: string): string {
    return render({
        ok: false,
        file,
        cancelled: false,
        error: { code: 'file-not-found', message }
    })
}

function render(output: CancelCliOutput): string {
    return JSON.stringify(output)
}
