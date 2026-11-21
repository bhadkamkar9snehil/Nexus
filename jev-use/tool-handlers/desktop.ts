import { withDesktopLock } from '../desktop-lock.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { ToolInvocation } from '../tool-context.js';

export function registerDesktopTools(registry: ToolRegistry<ToolInvocation>) {
  registry.bind('jev_desktop', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    const windowId = args.window_id;
          if (windowId !== undefined && (typeof windowId !== 'number' || !Number.isSafeInteger(windowId) || windowId < 1)) throw new Error('Invalid window_id');
          const aumid = args.launch_aumid === undefined ? undefined : required('launch_aumid');
          if (aumid && (!/^[\w.-]+![\w.-]+$/.test(aumid) || windowId !== undefined)) throw new Error('Use a packaged app AUMID without window_id');
          const app = required('app');
          // One desktop task at a time across all agents, not only within this process.
          output = await withDesktopLock(`jev_desktop ${app}`.slice(0, 80), () => desktopTask(goal, app, required('expect'), args.text === undefined ? undefined : required('text'), limit, addUsage, windowId, aumid));
    return output;
  });
}
