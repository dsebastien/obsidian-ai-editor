import type { Anchor, TextChange } from '../../domain/anchoring/anchor'
import { mapAnchorThroughChanges, verifyPrecondition } from '../../domain/anchoring/anchor'
import type { MatchStrategy } from '../../domain/anchoring/match'
import type { FindingId, RunId } from '../../domain/ids'
import type { RawFinding } from '../../domain/operations/contract'

/**
 * Finding lifecycle state machine (review minor #34).
 *
 * ```
 * open ⇄ preview
 * open|preview → accepted | rejected | dismissed | superseded   (terminal)
 * ```
 *
 * Staleness is orthogonal: it lives on the anchor (`anchor.state`), not on
 * the status. A stale or unanchored finding remains visible (display-only)
 * and can still be rejected/dismissed/superseded, but never previewed or
 * accepted — its suggestion was computed against text that no longer exists
 * (Business Rules #3).
 */
export type FindingStatus =
    | 'open'
    | 'preview'
    | 'accepted'
    | 'rejected'
    | 'dismissed'
    | 'superseded'

/**
 * A finding as tracked by the orchestrator: the raw backend payload plus
 * anchoring outcome and lifecycle status.
 */
export interface TrackedFinding {
    readonly id: FindingId
    /** Per-editor run this finding belongs to. */
    readonly runId: RunId
    readonly editorId: string
    readonly raw: RawFinding
    /** `null` when the quote could not be (unambiguously) located: display-only. */
    readonly anchor: Anchor | null
    /**
     * Snapshot text at the anchored range at anchor time — the accept
     * precondition. May differ from `raw.quote` for normalized matches.
     */
    readonly anchoredText: string | null
    readonly matchStrategy: MatchStrategy | null
    readonly status: FindingStatus
    /** Set when status is `superseded`: the finding that replaced this one. */
    readonly supersededBy: FindingId | null
}

/** Input for registering a freshly anchored finding (status starts at `open`). */
export interface NewFinding {
    readonly id: FindingId
    readonly runId: RunId
    readonly editorId: string
    readonly raw: RawFinding
    readonly anchor: Anchor | null
    readonly anchoredText: string | null
    readonly matchStrategy: MatchStrategy | null
}

export type AcceptFailureReason =
    | 'not-found'
    | 'invalid-status'
    | 'unanchored'
    | 'stale'
    | 'no-suggestion'
    | 'precondition-failed'

export type AcceptResult =
    | { readonly ok: true; readonly finding: TrackedFinding }
    | { readonly ok: false; readonly reason: AcceptFailureReason }

const TERMINAL_STATUSES: readonly FindingStatus[] = [
    'accepted',
    'rejected',
    'dismissed',
    'superseded'
]

/**
 * In-memory store for the findings of one review run, enforcing the status
 * state machine and Business Rules #3 (stale proposals are never applied).
 *
 * All mutations go through the transition methods; invalid transitions are
 * rejected (returning `null` / a failure result) rather than throwing, so UI
 * races (double-click accept, accept-after-edit) degrade gracefully. Every
 * successful mutation invokes `onChange` exactly once.
 */
export class FindingStore {
    private readonly findings = new Map<string, TrackedFinding>()
    private readonly onChange: (() => void) | undefined

    constructor(onChange?: () => void) {
        this.onChange = onChange
    }

    add(input: NewFinding): TrackedFinding {
        const finding: TrackedFinding = {
            id: input.id,
            runId: input.runId,
            editorId: input.editorId,
            raw: input.raw,
            anchor: input.anchor,
            anchoredText: input.anchoredText,
            matchStrategy: input.matchStrategy,
            status: 'open',
            supersededBy: null
        }
        this.findings.set(finding.id, finding)
        this.notify()
        return finding
    }

    get(id: FindingId): TrackedFinding | null {
        return this.findings.get(id) ?? null
    }

    /** All findings, in insertion (arrival) order. */
    list(): readonly TrackedFinding[] {
        return [...this.findings.values()]
    }

    listByEditor(editorId: string): readonly TrackedFinding[] {
        return this.list().filter((finding) => finding.editorId === editorId)
    }

    /**
     * Whether a finding's suggestion can currently be previewed/accepted:
     * non-terminal status, anchored, not stale, and a suggestion exists.
     */
    isActionable(id: FindingId): boolean {
        const finding = this.findings.get(id)
        if (!finding) {
            return false
        }
        return (
            !TERMINAL_STATUSES.includes(finding.status) &&
            finding.anchor !== null &&
            finding.anchor.state === 'anchored' &&
            typeof finding.raw.suggestion === 'string' &&
            finding.raw.suggestion.length > 0
        )
    }

    /** `open` → `preview`. Requires an actionable suggestion. */
    preview(id: FindingId): TrackedFinding | null {
        const finding = this.findings.get(id)
        if (!finding || finding.status !== 'open' || !this.isActionable(id)) {
            return null
        }
        return this.update(finding, { status: 'preview' })
    }

    /** `preview` → `open` (user closed the diff without deciding). */
    closePreview(id: FindingId): TrackedFinding | null {
        const finding = this.findings.get(id)
        if (!finding || finding.status !== 'preview') {
            return null
        }
        return this.update(finding, { status: 'open' })
    }

    /**
     * `open|preview` → `accepted`, gated by the precondition check: the
     * current document must still contain the exact anchored text at the
     * anchor (Business Rules #3). Never fuzzy-relocates.
     */
    accept(id: FindingId, currentText: string): AcceptResult {
        const finding = this.findings.get(id)
        if (!finding) {
            return { ok: false, reason: 'not-found' }
        }
        if (finding.status !== 'open' && finding.status !== 'preview') {
            return { ok: false, reason: 'invalid-status' }
        }
        if (finding.anchor === null || finding.anchoredText === null) {
            return { ok: false, reason: 'unanchored' }
        }
        if (finding.anchor.state !== 'anchored') {
            return { ok: false, reason: 'stale' }
        }
        if (typeof finding.raw.suggestion !== 'string' || finding.raw.suggestion.length === 0) {
            return { ok: false, reason: 'no-suggestion' }
        }
        if (!verifyPrecondition(currentText, finding.anchor, finding.anchoredText)) {
            return { ok: false, reason: 'precondition-failed' }
        }
        return { ok: true, finding: this.update(finding, { status: 'accepted' }) }
    }

    /** `open|preview` → `rejected`. Allowed for stale/unanchored findings. */
    reject(id: FindingId): TrackedFinding | null {
        return this.close(id, 'rejected')
    }

    /** `open|preview` → `dismissed`. Allowed for stale/unanchored findings. */
    dismiss(id: FindingId): TrackedFinding | null {
        return this.close(id, 'dismissed')
    }

    /**
     * `open|preview` → `superseded`: a newer finding (e.g. from a refined
     * proposal or a thread turn) replaces this one. The successor must
     * already be registered so `supersededBy` never dangles.
     */
    supersede(id: FindingId, byId: FindingId): TrackedFinding | null {
        const finding = this.findings.get(id)
        const successor = this.findings.get(byId)
        if (!finding || !successor || id === byId) {
            return null
        }
        if (finding.status !== 'open' && finding.status !== 'preview') {
            return null
        }
        return this.update(finding, { status: 'superseded', supersededBy: byId })
    }

    /**
     * Removes findings outright — the per-editor retry path (`retryEditor`):
     * a retried attempt REPLACES the failed attempt's findings, so they leave
     * the store entirely (any status, terminal included — an accepted edit
     * stays in the document, only its record goes). Unknown ids are ignored;
     * `onChange` fires once when anything was removed.
     */
    removeMany(ids: readonly FindingId[]): void {
        let removed = false
        for (const id of ids) {
            if (this.findings.delete(id)) {
                removed = true
            }
        }
        if (removed) {
            this.notify()
        }
    }

    /**
     * Maps every anchored finding through a batch of document changes
     * (pre-change coordinates, sorted, non-overlapping — the CM6
     * `iterChanges` shape). A finding whose anchor goes stale while in
     * `preview` falls back to `open`: the diff on screen no longer reflects
     * reality and must not be one keypress away from Accept.
     */
    applyTextChanges(changes: readonly TextChange[]): void {
        if (changes.length === 0) {
            return
        }
        let changed = false
        for (const finding of this.findings.values()) {
            if (finding.anchor === null) {
                continue
            }
            const mapped = mapAnchorThroughChanges(finding.anchor, changes)
            if (
                mapped.from === finding.anchor.from &&
                mapped.to === finding.anchor.to &&
                mapped.state === finding.anchor.state
            ) {
                continue
            }
            const wentStale = finding.anchor.state === 'anchored' && mapped.state === 'stale'
            const status = wentStale && finding.status === 'preview' ? 'open' : finding.status
            this.findings.set(finding.id, { ...finding, anchor: mapped, status })
            changed = true
        }
        if (changed) {
            this.notify()
        }
    }

    private close(id: FindingId, status: 'rejected' | 'dismissed'): TrackedFinding | null {
        const finding = this.findings.get(id)
        if (!finding || (finding.status !== 'open' && finding.status !== 'preview')) {
            return null
        }
        return this.update(finding, { status })
    }

    private update(finding: TrackedFinding, patch: Partial<TrackedFinding>): TrackedFinding {
        const next: TrackedFinding = { ...finding, ...patch }
        this.findings.set(next.id, next)
        this.notify()
        return next
    }

    private notify(): void {
        this.onChange?.()
    }
}
