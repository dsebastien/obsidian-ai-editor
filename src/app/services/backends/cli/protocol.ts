/**
 * The output protocol: what a CLI agent is allowed to say on stdout.
 *
 * Two shapes, because the shipped tools disagree. A one-shot invocation
 * returns a single JSON document; a headless agent run streams one JSON
 * object per line as it works (`--output-format stream-json` and its
 * equivalents). WHICH shape each tool speaks is a per-tool fact and belongs
 * to the adapters; the parsing of both belongs here, once, so the failure
 * vocabulary is the same either way.
 *
 * Everything here is pure, and everything here treats stdout as untrusted
 * text: it is produced by a program the plugin does not control, from a model
 * that is not obliged to be well-formed. Nothing is coerced, nothing is
 * repaired, and no failure message ever quotes the payload — a malformed line
 * can contain anything the tool had in memory, including the key it was
 * configured with (Business Rules #12). Line numbers and counts only.
 */

export type CliProtocolProblem = 'empty-output' | 'malformed-json' | 'not-an-object'

export type CliProtocolResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly code: CliProtocolProblem; readonly message: string }

/**
 * Parses stdout as one JSON document.
 *
 * A trailing newline is tolerated (every well-behaved CLI writes one) and
 * nothing else is: a tool that prints a banner before its JSON is a tool
 * whose adapter needs fixing, not something to recover from by scanning for
 * the first `{`. Guessing where the payload starts is how a boundary ends up
 * parsing an attacker-chosen substring.
 */
export function parseJsonDocument(stdout: string): CliProtocolResult<unknown> {
    const text = stdout.trim()
    if (text.length === 0) {
        return {
            ok: false,
            code: 'empty-output',
            message: 'The tool produced no output.'
        }
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(text) as unknown
    } catch {
        return {
            ok: false,
            code: 'malformed-json',
            message: 'The tool did not produce valid JSON.'
        }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {
            ok: false,
            code: 'not-an-object',
            message: 'The tool produced JSON, but not an object.'
        }
    }
    return { ok: true, value: parsed }
}

/**
 * Parses stdout as newline-delimited JSON events.
 *
 * Blank lines are skipped (they carry no meaning in JSONL and tools emit them
 * around flushes). A line that is not a JSON object fails the whole stream
 * and says WHICH line — a stream of events where one is quietly dropped is a
 * stream that lies about what the agent did.
 */
export function parseJsonLines(stdout: string): CliProtocolResult<readonly unknown[]> {
    const events: unknown[] = []
    const lines = stdout.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
        const line = (lines[index] ?? '').trim()
        if (line.length === 0) {
            continue
        }
        let parsed: unknown
        try {
            parsed = JSON.parse(line) as unknown
        } catch {
            return {
                ok: false,
                code: 'malformed-json',
                message: `Line ${index + 1} of the tool's output is not valid JSON.`
            }
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return {
                ok: false,
                code: 'not-an-object',
                message: `Line ${index + 1} of the tool's output is not a JSON object.`
            }
        }
        events.push(parsed)
    }
    if (events.length === 0) {
        return {
            ok: false,
            code: 'empty-output',
            message: 'The tool produced no output.'
        }
    }
    return { ok: true, value: events }
}
