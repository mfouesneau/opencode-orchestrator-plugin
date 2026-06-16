/**
 * Server entry point for the OpenCode orchestrator plugin.
 *
 * Exports `plugin` under all three conventions OpenCode loaders may use:
 *   - `server`  — PluginModule convention (primary)
 *   - `default` — default-export convention
 *   - `plugin`  — named-export convention
 *
 * @example
 * // opencode.jsonc plugin entry
 * // { "plugin": "./path/to/dist/index.js" }
 */
export { plugin as server } from './plugin.js';   // PluginModule.server convention
export { plugin as default } from './plugin.js';  // default-export convention
export { plugin } from './plugin.js';             // named-export convention
