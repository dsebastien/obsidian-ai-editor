### API keys now live in Obsidian's secret storage

Your API keys are no longer stored in plain text in the plugin's `data.json`, which travels with your vault when it syncs (Obsidian Sync, iCloud, Syncthing, git…). Each backend now keeps its key in Obsidian's secret storage, on the device, and saves only the secret's name in the vault.

- **Nothing to do.** Every device moves its keys into its own secret storage the next time it starts, so all your synced devices keep working without re-entering anything.
- **The plain-text copy is removed after 60 days.** It stays in `data.json` during that time so devices that have not started the new version yet can still pick up the key. To remove it sooner, select **Remove plain-text copy now** in **Settings → AI Editors → Backends**, once all your devices run this version.
- **New key, new device.** The API key field is now Obsidian's secret picker. Secret storage does not sync: when you add a key later, set it once on each device. A backend whose key is missing on a device says so on its row and in a notice, instead of failing with an authentication error.
- Changing a key, or selecting **Clear** next to it, removes its plain-text copy right away.
- Exported settings contain neither keys nor secret names.
