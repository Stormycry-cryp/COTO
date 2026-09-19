import { fileTools } from './files.js';
import { processTools } from './process.js';
import { httpTool } from './network.js';
export { fileTools, processTools, httpTool };
export { remoteTool } from './network.js';
export { defineTool } from '../core/index.js';
export function localTools(
  options: { env?: Record<string, string>; allowPrivateNetwork?: boolean } = {},
) {
  return [
    ...fileTools(),
    ...processTools(options.env),
    httpTool({ allowPrivate: options.allowPrivateNetwork }),
  ];
}
