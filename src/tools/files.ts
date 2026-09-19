import {
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
  rename,
  mkdir,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parsePatch, applyPatch } from 'diff';
import ignore from 'ignore';
import picomatch from 'picomatch';
import type { Tool, ToolResult } from '../core/types.js';
import { AgentError } from '../core/errors.js';

export const textResult = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
});
export const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str = { type: 'string' };
const positive = { type: 'integer', minimum: 1 };
export async function workspacePath(
  workspace: string,
  path: string,
  create = false,
): Promise<string> {
  const root = await realpath(workspace);
  const absolute = resolve(root, path);
  const inside = (target: string) => {
    const rel = relative(root, target);
    return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
  };
  if (!inside(absolute)) throw new AgentError('path_denied', 'Path is outside the workspace', 403);
  let actual: string;
  try {
    actual = await realpath(absolute);
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    let parent = dirname(absolute);
    while (true) {
      try {
        const canonical = await realpath(parent);
        if (!inside(canonical))
          throw new AgentError('path_denied', 'Parent resolves outside workspace', 403);
        actual = resolve(canonical, relative(parent, absolute));
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        const next = dirname(parent);
        if (next === parent) throw e;
        parent = next;
      }
    }
  }
  if (!inside(actual))
    throw new AgentError('path_denied', 'Symlink resolves outside workspace', 403);
  const segments = relative(root, actual).split(/[\\/]/);
  if (segments.some((s) => ['.git', '.coto', '.env.coto'].includes(s)))
    throw new AgentError(
      'path_denied',
      'Agent state, credentials and Git internals are not tool-accessible',
      403,
    );
  return actual;
}
export async function boundedRead(path: string, max = 1_048_576) {
  if ((await stat(path)).size > max)
    throw new AgentError('file_limit', 'File exceeds size limit', 422);
  const buffer = await readFile(path);
  if (buffer.includes(0))
    throw new AgentError('binary_file', 'Binary file cannot be read as text', 422);
  return buffer.toString('utf8');
}
async function atomicWrite(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let mode = 0o600;
  try {
    mode = (await stat(path)).mode;
  } catch {}
  try {
    await writeFile(temporary, content, { flag: 'wx', mode });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export async function walkFiles(root: string, signal: AbortSignal, limit = 5000) {
  const rules = ignore().add(['.git', '.coto', '.env.coto', 'node_modules']);
  try {
    rules.add(await boundedRead(join(root, '.gitignore'), 64_000));
  } catch {}
  const found: string[] = [];
  let visited = 0;
  const visit = async (dir: string) => {
    signal.throwIfAborted();
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      if (++visited > limit * 4)
        throw new AgentError(
          'scan_limit',
          'Directory scan limit reached; narrow the search root',
          422,
        );
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || rules.ignores(path + (entry.isDirectory() ? '/' : '')))
        continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        found.push(path);
        if (found.length >= limit) return;
      }
      if (found.length >= limit) return;
    }
  };
  await visit('');
  return found.sort();
}
export function fileTools(): Tool[] {
  return [
    {
      name: 'read_file',
      description: 'Read a bounded text file, optionally a line range.',
      effect: 'read',
      parallel: true,
      cancellable: true,
      parameters: objectSchema({ path: str, startLine: positive, endLine: positive }, ['path']),
      async execute(args, ctx) {
        const text = await boundedRead(await workspacePath(ctx.workspace, String(args.path)));
        const lines = text.split('\n');
        const start = Number(args.startLine ?? 1);
        const end = Number(args.endLine ?? start + 199);
        return textResult(
          lines
            .slice(start - 1, Math.min(end, start + 499))
            .map((line, i) => `${start + i}: ${line}`)
            .join('\n'),
        );
      },
    },
    {
      name: 'list_files',
      description: 'List workspace files, excluding symlinks, ignored files and agent state.',
      effect: 'read',
      parallel: true,
      cancellable: true,
      parameters: objectSchema({
        pattern: str,
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      }),
      async execute(args, ctx) {
        const matcher = picomatch(String(args.pattern ?? '**/*'), { dot: true });
        const files = (await walkFiles(ctx.workspace, ctx.signal)).filter((path) => matcher(path));
        const offset = Number(args.offset ?? 0),
          limit = Number(args.limit ?? 100);
        return textResult({
          files: files.slice(offset, offset + limit),
          nextOffset: offset + limit < files.length ? offset + limit : null,
        });
      },
    },
    {
      name: 'search_files',
      description: 'Search literal text in workspace files with bounded matches and optional glob.',
      effect: 'read',
      parallel: true,
      cancellable: true,
      parameters: objectSchema(
        {
          query: { type: 'string', minLength: 1 },
          pattern: str,
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        ['query'],
      ),
      async execute(args, ctx) {
        const matches: { path: string; line: number; text: string }[] = [];
        const matcher = picomatch(String(args.pattern ?? '**/*'), { dot: true });
        for (const path of (await walkFiles(ctx.workspace, ctx.signal)).filter((path) =>
          matcher(path),
        )) {
          ctx.signal.throwIfAborted();
          let content: string;
          try {
            content = await boundedRead(await workspacePath(ctx.workspace, path));
          } catch {
            continue;
          }
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && matches.length < Number(args.limit ?? 50); i++)
            if (lines[i].includes(String(args.query)))
              matches.push({ path, line: i + 1, text: lines[i].slice(0, 500) });
          if (matches.length >= Number(args.limit ?? 50)) break;
        }
        return textResult(matches);
      },
    },
    {
      name: 'write_file',
      description: 'Create a new file. To replace a file, provide its exact previous text.',
      effect: 'write',
      parameters: objectSchema(
        { path: str, content: { type: 'string', maxLength: 1_048_576 }, expectedContent: str },
        ['path', 'content'],
      ),
      async execute(args, ctx) {
        const path = await workspacePath(ctx.workspace, String(args.path), true);
        let existing: string | undefined;
        try {
          existing = await boundedRead(path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        if (existing !== undefined && args.expectedContent !== existing)
          throw new AgentError(
            'file_conflict',
            'Existing file changed or expectedContent was omitted',
            409,
          );
        ctx.signal.throwIfAborted();
        await atomicWrite(path, String(args.content));
        return textResult({ path: args.path, written: true });
      },
    },
    {
      name: 'edit_file',
      description: 'Replace one uniquely matching exact text segment.',
      effect: 'write',
      parameters: objectSchema(
        { path: str, oldText: { type: 'string', minLength: 1 }, newText: str },
        ['path', 'oldText', 'newText'],
      ),
      async execute(args, ctx) {
        const path = await workspacePath(ctx.workspace, String(args.path));
        const text = await boundedRead(path);
        const old = String(args.oldText),
          at = text.indexOf(old);
        if (at < 0 || text.indexOf(old, at + old.length) >= 0)
          throw new AgentError('edit_conflict', 'oldText must match exactly once', 409);
        ctx.signal.throwIfAborted();
        await atomicWrite(path, text.slice(0, at) + args.newText + text.slice(at + old.length));
        return textResult({ path: args.path, edited: true });
      },
    },
    {
      name: 'apply_patch',
      description:
        'Apply a standard unified diff. All hunks are checked before writes; this is not the Codex custom patch syntax.',
      effect: 'write',
      parameters: objectSchema({ patch: { type: 'string', maxLength: 1_048_576 } }, ['patch']),
      async execute(args, ctx) {
        const patches = parsePatch(String(args.patch));
        if (!patches.length || patches.length > 50)
          throw new AgentError('invalid_patch', 'Expected 1-50 unified diff files', 422);
        const root = await realpath(ctx.workspace);
        const prepared: { path: string; before?: string; after?: string }[] = [];
        for (const patch of patches) {
          const oldName = patch.oldFileName?.replace(/^a\//, ''),
            newName = patch.newFileName?.replace(/^b\//, '');
          const remove = newName === '/dev/null',
            create = oldName === '/dev/null';
          if (!oldName || !newName || (!create && !remove && oldName !== newName))
            throw new AgentError('invalid_patch', 'Renames are not supported; use add/delete', 422);
          const path = await workspacePath(ctx.workspace, remove ? oldName! : newName!, create);
          if (prepared.some((p) => p.path === path))
            throw new AgentError('invalid_patch', 'Duplicate target path', 422);
          let before: string | undefined;
          try {
            before = await boundedRead(path);
          } catch (e) {
            if (!create || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          }
          if (create && before !== undefined)
            throw new AgentError('file_conflict', 'New patch target already exists', 409);
          const after = applyPatch(before ?? '', patch);
          if (after === false)
            throw new AgentError('patch_conflict', 'Patch hunks do not match', 409);
          prepared.push({ path, before, after: remove ? undefined : after });
        }
        const applied: string[] = [];
        try {
          for (const item of prepared) {
            ctx.signal.throwIfAborted();
            if (item.before !== undefined && (await boundedRead(item.path)) !== item.before)
              throw new AgentError('file_conflict', 'File changed during patch', 409);
            if (item.after === undefined) await unlink(item.path);
            else await atomicWrite(item.path, item.after);
            applied.push(relative(root, item.path));
          }
        } catch (error) {
          return {
            ...textResult({
              applied,
              error: error instanceof Error ? error.message : String(error),
            }),
            isError: true,
          };
        }
        return textResult({ applied });
      },
    },
  ];
}
