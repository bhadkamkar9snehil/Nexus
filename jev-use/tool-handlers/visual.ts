import { visualTool } from '../visual-intelligence.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { ToolInvocation } from '../tool-context.js';

export function registerVisualTools(registry: ToolRegistry<ToolInvocation>) {
  for (const name of ["visual_verify","visual_compare","visual_classify","visual_route","visual_grade","visual_find","visual_extract","visual_diff","visual_remember","visual_search","visual_contract","visual_wait","visual_watch","visual_asset","visual_redact","visual_capture","visual_contract_registry","visual_recipe","visual_watch_manage"]) {
    registry.bind(name, async context => JSON.stringify(await visualTool(name, context.args, context.root, context.addUsage)));
  }
}
