/**
 * Pure model for the settings color field (no `obsidian` import, so it is
 * testable under `bun test` — same pattern as `setup-wizard-model.ts`).
 * Owns the preset roster and the string logic `renderColorField` needs:
 * hex detection, preset labels, computed-style → hex resolution, and the
 * screen-reader announcement for a chosen color.
 */

/**
 * Theme-variable colors paired with a human label: the label is what screen
 * readers announce, so the raw CSS token never reaches assistive technology.
 */
export const COLOR_PRESETS: readonly { readonly value: string; readonly label: string }[] = [
    { value: 'var(--color-red)', label: 'red' },
    { value: 'var(--color-orange)', label: 'orange' },
    { value: 'var(--color-yellow)', label: 'yellow' },
    { value: 'var(--color-green)', label: 'green' },
    { value: 'var(--color-cyan)', label: 'cyan' },
    { value: 'var(--color-blue)', label: 'blue' },
    { value: 'var(--color-purple)', label: 'purple' },
    { value: 'var(--color-pink)', label: 'pink' }
]

/** `#rrggbb` exactly — the only custom-color shape the picker produces. */
export function isHexColor(value: string): boolean {
    return /^#[0-9a-fA-F]{6}$/.test(value)
}

/** Human label for a preset value; `null` when the value is not a preset. */
export function presetLabel(value: string): string | null {
    const preset = COLOR_PRESETS.find((entry) => entry.value === value)
    return preset ? preset.label : null
}

/**
 * Parses `rgb(r, g, b)` / `rgba(r, g, b, a)` (the shapes `getComputedStyle`
 * returns for a resolved backgroundColor) into lowercase `#rrggbb`. Returns
 * `null` for anything else — out-of-range channels, other color functions,
 * empty strings — so callers fall back to leaving the picker unseeded.
 */
export function rgbStringToHex(rgb: string): string | null {
    const match =
        /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/.exec(
            rgb.trim()
        )
    if (!match) {
        return null
    }
    const channels: string[] = []
    for (const raw of [match[1], match[2], match[3]]) {
        if (raw === undefined) {
            return null
        }
        const channel = Number(raw)
        if (channel > 255) {
            return null
        }
        channels.push(channel.toString(16).padStart(2, '0'))
    }
    return `#${channels.join('')}`
}

/**
 * What the live region announces after a color is chosen: the preset's human
 * label when it has one, the hex when the value is a custom color, and a
 * bare confirmation for anything else (defensive — settings are validated).
 */
export function colorAnnouncement(value: string): string {
    const label = presetLabel(value)
    if (label) {
        return `Color set to ${label}`
    }
    if (isHexColor(value)) {
        return `Color set to ${value}`
    }
    return 'Color set'
}
