import { AbstractInputSuggest } from 'obsidian'
import type { App } from 'obsidian'
import { basenameOf, rankNotePaths } from './note-path-ranking'

/**
 * Vault note autocomplete for text inputs holding a note path (prompt
 * note refs, voice profile notes, panel charters). Suggests markdown files
 * ranked by `rankNotePaths`; picking one hands the path to `onPick` — the
 * host control decides what to do (the note-refs editor adds it directly).
 */
export class NotePathSuggest extends AbstractInputSuggest<string> {
    private readonly appRef: App
    private readonly onPick: (path: string) => void
    private readonly excludePaths: () => ReadonlySet<string>

    constructor(
        app: App,
        inputEl: HTMLInputElement,
        options: {
            onPick: (path: string) => void
            /** Paths never offered (already referenced). Re-read per query. */
            excludePaths?: () => ReadonlySet<string>
        }
    ) {
        super(app, inputEl)
        this.appRef = app
        this.onPick = options.onPick
        this.excludePaths = options.excludePaths ?? ((): ReadonlySet<string> => new Set())
    }

    protected getSuggestions(query: string): string[] {
        const paths = this.appRef.vault.getMarkdownFiles().map((file) => file.path)
        return rankNotePaths(query, paths, { exclude: this.excludePaths() })
    }

    override renderSuggestion(path: string, el: HTMLElement): void {
        el.addClass('ai-editor-note-suggestion')
        el.createDiv({ cls: 'ai-editor-note-suggestion-title', text: basenameOf(path) })
        el.createDiv({ cls: 'ai-editor-note-suggestion-path', text: path })
    }

    override selectSuggestion(path: string): void {
        this.onPick(path)
        this.setValue('')
        this.close()
    }
}
