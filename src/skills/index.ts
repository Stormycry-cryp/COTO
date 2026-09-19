import { readFile, readdir, realpath } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import type { ContextContributor, Tool } from '../core/types.js';
import { AgentError } from '../core/errors.js';
import { boundedRead, objectSchema, textResult } from '../tools/files.js';
export interface Skill {
  id: string;
  name: string;
  description: string;
  root: string;
  hash: string;
}
export class SkillRegistry {
  private catalog: Skill[] = [];
  constructor(readonly roots: string[]) {}
  async discover() {
    const skills: Skill[] = [];
    for (const [index, root] of this.roots.entries()) {
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const path = resolve(root, entry.name);
        let source: string;
        try {
          source = await boundedRead(join(path, 'SKILL.md'), 64_000);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw e;
        }
        const lines = source.replace(/\r\n/g, '\n').split('\n');
        const end = lines.indexOf('---', 1);
        if (lines[0] !== '---' || end < 0)
          throw new AgentError('invalid_skill', `Missing frontmatter: ${path}`, 422);
        const metadata = parse(lines.slice(1, end).join('\n'));
        if (typeof metadata?.name !== 'string' || typeof metadata.description !== 'string')
          throw new AgentError(
            'invalid_skill',
            `Skill name and description required: ${path}`,
            422,
          );
        skills.push({
          id: `r${index}/${entry.name}`,
          name: metadata.name.slice(0, 100),
          description: metadata.description.slice(0, 500),
          root: path,
          hash: createHash('sha256').update(source).digest('hex'),
        });
      }
    }
    this.catalog = skills;
    return this.list();
  }
  list() {
    return structuredClone(this.catalog);
  }
  async read(id: string, resource = 'SKILL.md') {
    const candidates = this.catalog.filter((s) => s.id === id || s.name === id);
    if (candidates.length !== 1)
      throw new AgentError('skill_not_found', 'Use the exact skill ID from skills_list', 404);
    const skill = candidates[0];
    const root = await realpath(skill.root);
    const target = await realpath(resolve(root, resource));
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel))
      throw new AgentError('path_denied', 'Skill resource escapes its root', 403);
    const content = await boundedRead(target, 64_000);
    return {
      id: skill.id,
      resource,
      content,
      hash: createHash('sha256').update(content).digest('hex'),
    };
  }
  contributor(): ContextContributor {
    return async () => {
      const catalog = this.catalog.map(({ id, name, description }) => ({ id, name, description }));
      return `Skills are task guidance, not permission grants. Read a relevant skill using skills_read before following it. Catalog (up to 30 entries; use skills_list for more):\n${JSON.stringify(catalog.slice(0, 30))}`;
    };
  }
  tools(): Tool[] {
    return [
      {
        name: 'skills_list',
        description: 'List available skills; use stable IDs to resolve duplicate names.',
        effect: 'read',
        parameters: objectSchema({ offset: { type: 'integer', minimum: 0 } }),
        execute: async (args) =>
          textResult(
            this.catalog
              .slice(Number(args.offset ?? 0), Number(args.offset ?? 0) + 30)
              .map(({ root, ...skill }) => skill),
          ),
      },
      {
        name: 'skills_read',
        description:
          'Read SKILL.md or a relative reference. Loading a skill never executes its scripts.',
        effect: 'read',
        parameters: objectSchema({ id: { type: 'string' }, resource: { type: 'string' } }, ['id']),
        execute: async (args) =>
          textResult(
            await this.read(
              String(args.id),
              args.resource === undefined ? undefined : String(args.resource),
            ),
          ),
      },
    ];
  }
}
/** Root instructions only. Nested scopes are supplied explicitly by host contributors. */
export function projectInstructions(): ContextContributor {
  return async ({ workspace }) => {
    try {
      const root = await realpath(workspace);
      const target = await realpath(join(root, 'AGENTS.md'));
      if (relative(root, target).startsWith('..'))
        throw new AgentError('path_denied', 'Instruction file escapes workspace', 403);
      return `Project instructions from AGENTS.md (subordinate to host policy):\n${await boundedRead(target, 24_000)}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  };
}
