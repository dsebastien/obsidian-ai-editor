/**
 * Legacy alias surface for the versioned settings schema. New code imports
 * from `../domain/settings/settings-schema` directly; this module remains so
 * the historical import path keeps working.
 */
export type { PluginSettingsV1 as PluginSettings } from '../domain/settings/settings-schema'
export { DEFAULT_PLUGIN_SETTINGS as DEFAULT_SETTINGS } from '../domain/settings/settings-schema'
