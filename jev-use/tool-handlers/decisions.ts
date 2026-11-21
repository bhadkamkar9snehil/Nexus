import { decide } from '../decisions.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { ToolInvocation } from '../tool-context.js';

export function registerDecisionsTools(registry: ToolRegistry<ToolInvocation>) {
  registry.bind('jev_select_workflow', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    output = await decide(name, args, addUsage);
    return output;
  });
  registry.bind('jev_rank_results', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    output = await decide(name, args, addUsage);
    return output;
  });
  registry.bind('jev_classify_failure', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    output = await decide(name, args, addUsage);
    return output;
  });
  registry.bind('jev_verify_result', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    output = await decide(name, args, addUsage);
    return output;
  });
}
