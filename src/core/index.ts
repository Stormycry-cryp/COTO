export * from './types.js';
export * from './errors.js';
export * from './context.js';
export * from './session.js';

import type { Tool } from './types.js';
export function defineTool<T extends Tool>(tool: T): T {
  return tool;
}
