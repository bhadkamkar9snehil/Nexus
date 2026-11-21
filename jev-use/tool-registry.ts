/**
 * Shared MCP tool catalog and handler registry.
 * The catalog is stable for existing clients. A handler cannot be advertised
 * until it is bound. New providers must use an explicit registration path.
 */
export type ToolSchema = {
  readonly type: 'object';
  readonly properties: Record<string, any>;
  readonly required: string[];
  readonly additionalProperties: false;
};

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolSchema;
};

export type ToolHandler<Context> = (context: Context) => Promise<string>;

export class ToolRegistry<Context> {
  private readonly definitions = new Map<string, ToolDefinition>();
  private readonly handlers = new Map<string, ToolHandler<Context>>();

  constructor(definitions: readonly ToolDefinition[]) {
    for (const definition of definitions) this.add(definition);
  }

  add(definition: ToolDefinition): void {
    if (!/^[a-z][a-z0-9_]*$/.test(definition.name)) {
      throw new Error('Invalid tool name: ' + definition.name);
    }
    if (this.definitions.has(definition.name)) {
      throw new Error('Duplicate tool definition: ' + definition.name);
    }
    if (!definition.description || definition.inputSchema.type !== 'object' ||
        definition.inputSchema.additionalProperties !== false ||
        !Array.isArray(definition.inputSchema.required)) {
      throw new Error('Invalid tool schema: ' + definition.name);
    }
    this.definitions.set(definition.name, definition);
  }

  bind(name: string, handler: ToolHandler<Context>): void {
    if (!this.definitions.has(name)) throw new Error('No tool definition: ' + name);
    if (this.handlers.has(name)) throw new Error('Duplicate tool handler: ' + name);
    this.handlers.set(name, handler);
  }

  has(name: string): boolean {
    return this.definitions.has(name) && this.handlers.has(name);
  }

  list(): ToolDefinition[] {
    return [...this.definitions.values()].filter(tool => this.handlers.has(tool.name));
  }

  assertReady(): void {
    const unbound = [...this.definitions.keys()].filter(name => !this.handlers.has(name));
    if (unbound.length) throw new Error('Unbound tool handlers: ' + unbound.join(', '));
  }

  async execute(name: string, context: Context): Promise<string> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error('Unknown tool');
    return handler(context);
  }
}
