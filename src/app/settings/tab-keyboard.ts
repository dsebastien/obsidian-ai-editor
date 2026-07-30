/**
 * Keyboard navigation for the settings tab bar (plan M9).
 *
 * The bar declares `role="tablist"` with `role="tab"` buttons, and that
 * declaration is a PROMISE: a screen reader announces "tab, 3 of 7" and its
 * user reaches for the arrow keys, because that is what the ARIA tabs pattern
 * says a tablist does. Nothing handled them, so the promise was false and the
 * bar was harder to use with a keyboard than seven plain buttons would have
 * been — declaring the role made it worse, not better.
 *
 * The rest of the pattern is DOM work (roving `tabindex`, `aria-controls`,
 * a `tabpanel`); this module owns the one decision that is pure logic and can
 * therefore be pinned: which tab the key moves to.
 */

/** Keys the tab bar acts on. Anything else is left to the browser. */
export type TabNavigationKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'

const NAVIGATION_KEYS: readonly string[] = ['ArrowLeft', 'ArrowRight', 'Home', 'End']

export function isTabNavigationKey(key: string): key is TabNavigationKey {
    return NAVIGATION_KEYS.includes(key)
}

/**
 * The index the key selects, given where the selection is now.
 *
 * Arrows WRAP: the pattern specifies it, and a bar of seven short labels is
 * exactly the case where running off the end and having to reverse is more
 * annoying than reappearing at the other side. `Home`/`End` jump to the ends.
 *
 * Returns the current index unchanged when there is nothing to move to (an
 * empty or single-tab bar, an out-of-range current index), so the caller can
 * compare and skip the re-render rather than special-case each of them.
 */
export function nextTabIndex(key: TabNavigationKey, current: number, count: number): number {
    if (count <= 0) {
        return current
    }
    const from = current >= 0 && current < count ? current : 0
    switch (key) {
        case 'ArrowLeft':
            return (from - 1 + count) % count
        case 'ArrowRight':
            return (from + 1) % count
        case 'Home':
            return 0
        case 'End':
            return count - 1
    }
}
