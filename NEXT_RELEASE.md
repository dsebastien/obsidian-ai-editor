### CLI backends on Windows, Linux and macOS

If your vault syncs between devices, a Claude Code or Codex backend now keeps one executable path and one permission for each system. You no longer edit the path, or give the permission again, each time you change device.

- The path in the backend dialog is for the system of the device you are on.
- **Executables on other systems** lets you set the paths of your other devices from this one. Each of them still asks for permission once, on that device.
- A permission given on one system never allows a program on another.

Your current backends keep working: their path becomes the shared one, used by any system that has no path of its own.
