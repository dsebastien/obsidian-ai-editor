/**
 * Label for the status-bar finding counter. Returns `null` when the item
 * must be hidden entirely (no findings — the plugin stays out of the way
 * rather than showing a zero). Pure so the plugin lifecycle stays free of
 * formatting logic.
 */
export function findingCountLabel(count: number): string | null {
    const whole = Math.floor(count)
    if (!Number.isFinite(whole) || whole <= 0) {
        return null
    }
    return whole === 1 ? '1 AI finding' : `${whole} AI findings`
}
