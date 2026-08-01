import type { RawFinding } from './contract'

/**
 * What makes two REPORTED findings the same observation.
 *
 * Backends may report a finding twice — once as a streamed `finding` event and
 * again inside the terminal `result` payload — so every consumer of an event
 * stream has to dedupe. The key must include the locating hints: the prompt
 * instructs models to disambiguate repeated text via
 * `occurrence`/`prefix`/`suffix`, so two findings on different occurrences of
 * the same quote are legitimately distinct and must not collapse into one.
 * Only true stream-vs-result duplicates (identical in every field that
 * identifies the observation) are deduped.
 *
 * Shared so the review pipeline and the background comment pipeline can never
 * disagree about what a duplicate is.
 */
export function rawFindingIdentity(raw: RawFinding): string {
    return JSON.stringify([
        raw.quote,
        raw.critique,
        // Proposal content participates in STREAM-vs-result dedupe identity
        // only. Cross-run identity (issue #19) must key on the observation and
        // exclude edits — contract v2 design doc §9.
        raw.edits.map((edit) => [
            edit.op,
            edit.quote ?? '',
            edit.text ?? '',
            edit.occurrence ?? null,
            edit.prefix ?? '',
            edit.suffix ?? ''
        ]),
        raw.occurrence ?? null,
        raw.prefix ?? '',
        raw.suffix ?? ''
    ])
}
