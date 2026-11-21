import { tools } from '../tool-catalog.js';
import { ToolRegistry } from '../tool-registry.js';
import type { ToolInvocation } from '../tool-context.js';
import { registerDecisionsTools } from './decisions.js';
import { registerBrowserTools } from './browser.js';
import { registerSearchTools } from './search.js';
import { registerTerminalTools } from './terminal.js';
import { registerCollaborationTools } from './collaboration.js';
import { registerNetworkTools } from './network.js';
import { registerDesktopTools } from './desktop.js';

export function createCoreRegistry() {
  const registry = new ToolRegistry<ToolInvocation>(tools);
  registerDecisionsTools(registry);
  registerBrowserTools(registry);
  registerSearchTools(registry);
  registerTerminalTools(registry);
  registerCollaborationTools(registry);
  registerNetworkTools(registry);
  registerDesktopTools(registry);
  registry.assertReady();
  return registry;
}
