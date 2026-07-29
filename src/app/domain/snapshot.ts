import type { SnapshotId } from './ids'
import { asSnapshotId, generateId } from './ids'

/**
 * An immutable capture of a document's text at the moment an operation was
 * requested. Every quote, anchor, and precondition refers to a snapshot —
 * never to "the current document", which the user keeps editing while
 * backends run.
 */
export interface DocumentSnapshot {
    readonly id: SnapshotId
    /** Vault-relative path of the source file. */
    readonly filePath: string
    /** Full raw markdown text at capture time. */
    readonly text: string
    /** Content hash of `text`, used to detect stale results cheaply. */
    readonly hash: string
    /** Selection at capture time, when the operation was selection-scoped. */
    readonly selection?: { readonly from: number; readonly to: number }
}

/**
 * cyrb53 hash, hex-encoded (53-bit, split over two 32-bit halves).
 *
 * Not cryptographic — used only to detect content drift between a snapshot
 * and the live document. Deterministic across sessions and platforms.
 */
export function hashText(text: string, seed = 0): string {
    let h1 = 0xdeadbeef ^ seed
    let h2 = 0x41c6ce57 ^ seed
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i)
        h1 = Math.imul(h1 ^ ch, 2654435761)
        h2 = Math.imul(h2 ^ ch, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    const value = 4294967296 * (2097151 & h2) + (h1 >>> 0)
    return value.toString(16).padStart(14, '0')
}

export function createSnapshot(input: {
    filePath: string
    text: string
    selection?: { from: number; to: number }
}): DocumentSnapshot {
    return {
        id: asSnapshotId(generateId()),
        filePath: input.filePath,
        text: input.text,
        hash: hashText(input.text),
        ...(input.selection ? { selection: { ...input.selection } } : {})
    }
}
