import { readFileSync } from 'node:fs';
import { createProgram } from '../../src/cli-program.js';

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

it('prints the package version with --version', async () => {
  const output = await parseVersionFlag('--version');
  expect(output.trim()).toBe(packageJson.version);
});

it('prints the package version with -v', async () => {
  const output = await parseVersionFlag('-v');
  expect(output.trim()).toBe(packageJson.version);
});

async function parseVersionFlag(flag: string): Promise<string> {
  const program = createProgram();
  let output = '';
  program.exitOverride();
  program.configureOutput({
    writeOut: (value) => {
      output += value;
    },
    writeErr: () => undefined
  });

  try {
    await program.parseAsync(['node', 'ollama-agent-router', flag], { from: 'node' });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'commander.version') {
      throw error;
    }
  }

  return output;
}
