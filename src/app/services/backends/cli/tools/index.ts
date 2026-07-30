import { claudeCodeAdapter } from './claude-code'
import { codexAdapter } from './codex'
import type { CliToolAdapter, CliToolKind } from './types'

/**
 * Tool registry: one stateless adapter per CLI tool profile.
 *
 * The counterpart of `providers/index.ts` — exhaustive over the settings
 * schema's tool vocabulary, so adding a tool to `cliBackendSchema` fails the
 * type check here until its adapter exists.
 */
export function getCliToolAdapter(kind: CliToolKind): CliToolAdapter {
    switch (kind) {
        case 'claude-code':
            return claudeCodeAdapter
        case 'codex':
            return codexAdapter
    }
}

export { claudeCodeAdapter } from './claude-code'
export { codexAdapter } from './codex'
export { buildCliStdin } from './prompt'
export { safeStatusToken } from './types'
export type {
    BuildCliInvocationInput,
    CliEnvelope,
    CliEnvelopeErrorCode,
    CliInvocation,
    CliOutputProtocol,
    CliToolAdapter,
    CliToolCapabilities,
    CliToolKind
} from './types'
