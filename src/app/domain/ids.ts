/**
 * Branded identifier types for configuration and runtime entities.
 *
 * All persisted entities carry stable UUIDs so that renames never break
 * references (panels → editors, action bindings → editors/panels, …) and so
 * that imports can detect collisions and remap deterministically.
 */

declare const brand: unique symbol

type Branded<T, B extends string> = T & { readonly [brand]: B }

export type EditorId = Branded<string, 'EditorId'>
export type PanelId = Branded<string, 'PanelId'>
export type BackendInstanceId = Branded<string, 'BackendInstanceId'>
export type ActionId = Branded<string, 'ActionId'>
export type BindingRuleId = Branded<string, 'BindingRuleId'>
export type RunId = Branded<string, 'RunId'>
export type FindingId = Branded<string, 'FindingId'>
export type CommentId = Branded<string, 'CommentId'>
export type SnapshotId = Branded<string, 'SnapshotId'>

/**
 * Generates a random UUID v4.
 *
 * Uses the Web Crypto API, available both in the Obsidian renderer and in the
 * Bun test runtime.
 */
export function generateId(): string {
    return crypto.randomUUID()
}

export const asEditorId = (v: string): EditorId => v as EditorId
export const asPanelId = (v: string): PanelId => v as PanelId
export const asBackendInstanceId = (v: string): BackendInstanceId => v as BackendInstanceId
export const asActionId = (v: string): ActionId => v as ActionId
export const asBindingRuleId = (v: string): BindingRuleId => v as BindingRuleId
export const asRunId = (v: string): RunId => v as RunId
export const asFindingId = (v: string): FindingId => v as FindingId
export const asCommentId = (v: string): CommentId => v as CommentId
export const asSnapshotId = (v: string): SnapshotId => v as SnapshotId
