import type { Command } from 'commander';
import { registerSkillsSearchCommand } from './search.js';
import { registerSkillsInstallCommand } from './install.js';
import { addExamples } from '../../utils/commander-helpers.js';
import { formatCmd } from '../../utils/runtime-mode.js';

export { skillsSearchAction, registerSkillsSearchCommand } from './search.js';
export { skillsInstallAction, registerSkillsInstallCommand } from './install.js';

export function registerSkillsCommands(program: Command): void {
  const skills = program.command('skills').description('Discover and install skills from SkillHub');

  const search = registerSkillsSearchCommand(skills);

  addExamples(search, [
    formatCmd('skills search qianwen'),
    formatCmd('skills search qianwen --limit 10 --format json'),
  ]);

  const install = registerSkillsInstallCommand(skills);

  addExamples(install, [
    formatCmd('skills install my-skill'),
    formatCmd('skills install my-skill --dir ./skills --format json'),
  ]);

  skills.action(() => {
    skills.outputHelp();
    process.stdout.write('\n');
  });
}
