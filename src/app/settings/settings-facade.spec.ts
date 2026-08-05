import { describe, expect, test } from 'bun:test'
import { createSettingsFacade } from './settings-facade'
import type { SettingsHost } from './settings-facade'
import { DEFAULT_PLUGIN_SETTINGS } from '../domain/settings/settings-schema'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'

interface FakeHost {
    host: SettingsHost
    getStored: () => unknown
}

const makeHost = (initial: unknown): FakeHost => {
    let stored = initial
    return {
        host: {
            loadData: () => Promise.resolve(stored),
            saveData: (data: unknown) => {
                stored = data
                return Promise.resolve()
            }
        },
        getStored: () => stored
    }
}

describe('createSettingsFacade (fallback over loadData/saveData)', () => {
    test('yields defaults when nothing is persisted', async () => {
        const { host } = makeHost(null)
        const { facade, ready } = createSettingsFacade(host)
        await ready
        expect(facade.getSettings()).toEqual(DEFAULT_PLUGIN_SETTINGS)
    })

    test('loads persisted settings', async () => {
        const { host } = makeHost({
            ...DEFAULT_PLUGIN_SETTINGS,
            behavior: { ...DEFAULT_PLUGIN_SETTINGS.behavior, maxConcurrentRequests: 7 }
        })
        const { facade, ready } = createSettingsFacade(host)
        await ready
        expect(facade.getSettings().behavior.maxConcurrentRequests).toBe(7)
    })

    test('update persists the mutation and preserves foreign keys', async () => {
        const { host, getStored } = makeHost({ enabled: false, someLegacyKey: 42 })
        const { facade, ready } = createSettingsFacade(host)
        await ready
        await facade.update((draft) => {
            draft.behavior.sizeWarningWords = 500
        })
        expect(facade.getSettings().behavior.sizeWarningWords).toBe(500)
        const stored = getStored() as Record<string, unknown>
        expect(stored['enabled']).toBe(false)
        expect(stored['someLegacyKey']).toBe(42)
        const behavior = stored['behavior'] as PluginSettingsV1['behavior']
        expect(behavior.sizeWarningWords).toBe(500)
    })

    test('update waits for the initial load (never clobbers unloaded data)', async () => {
        const { host, getStored } = makeHost({
            ...DEFAULT_PLUGIN_SETTINGS,
            voiceProfile: { text: 'persisted voice', notePaths: [] },
            foreign: 'kept'
        })
        const { facade } = createSettingsFacade(host)
        // No `await ready` on purpose: the mutation races the load.
        await facade.update((draft) => {
            draft.behavior.stripFrontmatter = true
        })
        expect(facade.getSettings().voiceProfile.text).toBe('persisted voice')
        expect(facade.getSettings().behavior.stripFrontmatter).toBe(true)
        expect((getStored() as Record<string, unknown>)['foreign']).toBe('kept')
    })

    test('falls back to defaults when loadData rejects', async () => {
        const { getStored } = makeHost(null)
        let saved: unknown = null
        const host: SettingsHost = {
            loadData: () => Promise.reject(new Error('corrupt')),
            saveData: (data: unknown) => {
                saved = data
                return Promise.resolve()
            }
        }
        const { facade, ready } = createSettingsFacade(host)
        await ready
        expect(facade.getSettings()).toEqual(DEFAULT_PLUGIN_SETTINGS)
        await facade.update((draft) => {
            draft.onboarded = true
        })
        expect((saved as Record<string, unknown>)['onboarded']).toBe(true)
        void getStored
    })

    const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
        try {
            await promise
            return null
        } catch (cause) {
            return cause
        }
    }

    test('rejects a schema-invalid mutation, keeps the previous value, saves nothing', async () => {
        const { host, getStored } = makeHost(null)
        const { facade, ready } = createSettingsFacade(host)
        await ready
        const rejection = await rejectionOf(
            facade.update((draft) => {
                // 51 chars — responseLanguageOverride caps at 50.
                draft.behavior.responseLanguageOverride = 'x'.repeat(51)
            })
        )
        expect(rejection).toBeInstanceOf(Error)
        expect((rejection as Error).message).toContain('schema validation')
        expect(facade.getSettings().behavior.responseLanguageOverride).toBe('')
        expect(getStored()).toBeNull()
    })

    test('rejects a rule mutation with an empty match value', async () => {
        const { host } = makeHost(null)
        const { facade, ready } = createSettingsFacade(host)
        await ready
        const rejection = await rejectionOf(
            facade.update((draft) => {
                draft.rules.push({
                    id: 'r1',
                    name: '',
                    match: { matchType: 'folder', value: '' },
                    effect: 'assign',
                    defaultTarget: null,
                    enabled: true
                })
            })
        )
        expect(rejection).toBeInstanceOf(Error)
        expect(facade.getSettings().rules).toEqual([])
    })

    test('notifies subscribers after every successful update', async () => {
        const { host } = makeHost(null)
        const { facade, ready } = createSettingsFacade(host)
        await ready
        let notifications = 0
        facade.subscribe(() => {
            notifications += 1
            // Notified AFTER commit: the new value is already readable.
            expect(facade.getSettings().behavior.stripFrontmatter).toBe(true)
        })
        await facade.update((draft) => {
            draft.behavior.stripFrontmatter = true
        })
        expect(notifications).toBe(1)
        await facade.update((draft) => {
            draft.onboarded = true
        })
        expect(notifications).toBe(2)
    })

    test('does not notify on a rejected update', async () => {
        const { host } = makeHost(null)
        const { facade, ready } = createSettingsFacade(host)
        await ready
        let notifications = 0
        facade.subscribe(() => {
            notifications += 1
        })
        const rejection = await rejectionOf(
            facade.update((draft) => {
                draft.behavior.responseLanguageOverride = 'x'.repeat(51)
            })
        )
        expect(rejection).toBeInstanceOf(Error)
        expect(notifications).toBe(0)
    })

    test('unsubscribe stops notifications', async () => {
        const { host } = makeHost(null)
        const { facade, ready } = createSettingsFacade(host)
        await ready
        let notifications = 0
        const unsubscribe = facade.subscribe(() => {
            notifications += 1
        })
        await facade.update((draft) => {
            draft.onboarded = true
        })
        unsubscribe()
        await facade.update((draft) => {
            draft.onboarded = false
        })
        expect(notifications).toBe(1)
    })

    test('a throwing listener neither breaks the update nor starves others', async () => {
        const { host } = makeHost(null)
        const { facade, ready } = createSettingsFacade(host)
        await ready
        let secondRan = false
        facade.subscribe(() => {
            throw new Error('observer bug')
        })
        facade.subscribe(() => {
            secondRan = true
        })
        await facade.update((draft) => {
            draft.onboarded = true
        })
        expect(secondRan).toBe(true)
        expect(facade.getSettings().onboarded).toBe(true)
    })

    test('successive updates compound', async () => {
        const { host } = makeHost(null)
        const { facade, ready } = createSettingsFacade(host)
        await ready
        await facade.update((draft) => {
            draft.behavior.excludedTags.push('private')
        })
        await facade.update((draft) => {
            draft.behavior.excludedTags.push('journal')
        })
        expect(facade.getSettings().behavior.excludedTags).toEqual(['private', 'journal'])
    })
})

describe('createSettingsFacade (host-provided facade)', () => {
    test('delegates to the host when it implements the facade', async () => {
        const settings: PluginSettingsV1 = {
            ...DEFAULT_PLUGIN_SETTINGS,
            onboarded: true
        }
        let updateCalls = 0
        const host: SettingsHost = {
            loadData: () => Promise.reject(new Error('must not be called')),
            saveData: () => Promise.reject(new Error('must not be called')),
            getSettings: () => settings,
            update: () => {
                updateCalls += 1
                return Promise.resolve()
            }
        }
        const { facade, ready } = createSettingsFacade(host)
        await ready
        expect(facade.getSettings().onboarded).toBe(true)
        await facade.update(() => {})
        expect(updateCalls).toBe(1)
    })

    test('wraps a host without subscribe: local subscribers see successful updates', async () => {
        const host: SettingsHost = {
            loadData: () => Promise.reject(new Error('must not be called')),
            saveData: () => Promise.reject(new Error('must not be called')),
            getSettings: () => DEFAULT_PLUGIN_SETTINGS,
            update: () => Promise.resolve()
        }
        const { facade, ready } = createSettingsFacade(host)
        await ready
        let notifications = 0
        facade.subscribe(() => {
            notifications += 1
        })
        await facade.update(() => {})
        expect(notifications).toBe(1)
    })

    test('wrapped host update: no notification when the host update rejects', async () => {
        const host: SettingsHost = {
            loadData: () => Promise.reject(new Error('must not be called')),
            saveData: () => Promise.reject(new Error('must not be called')),
            getSettings: () => DEFAULT_PLUGIN_SETTINGS,
            update: () => Promise.reject(new Error('invalid'))
        }
        const { facade, ready } = createSettingsFacade(host)
        await ready
        let notifications = 0
        facade.subscribe(() => {
            notifications += 1
        })
        let rejection: unknown = null
        try {
            await facade.update(() => {})
        } catch (cause) {
            rejection = cause
        }
        expect(rejection).toBeInstanceOf(Error)
        expect((rejection as Error).message).toBe('invalid')
        expect(notifications).toBe(0)
    })

    test('delegates subscribe to the host when it provides one', async () => {
        let hostSubscribeCalls = 0
        const host: SettingsHost = {
            loadData: () => Promise.reject(new Error('must not be called')),
            saveData: () => Promise.reject(new Error('must not be called')),
            getSettings: () => DEFAULT_PLUGIN_SETTINGS,
            update: () => Promise.resolve(),
            subscribe: () => {
                hostSubscribeCalls += 1
                return () => {}
            }
        }
        const { facade } = createSettingsFacade(host)
        facade.subscribe(() => {})
        expect(hostSubscribeCalls).toBe(1)
    })
})
