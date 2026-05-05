import { parseNvidiaSmi } from '../../src/gpu.js';
import { parseOllamaPs } from '../../src/ollama.js';

it('parses ollama ps output', () => {
  const rows = parseOllamaPs(`NAME                       ID              SIZE      PROCESSOR    UNTIL
qwen2.5-coder:7b           abc123          4.7 GB    100% GPU     4 minutes from now
gpt-oss:20b                def456          14 GB     63%/37% CPU/GPU  1 hour from now`);
  expect(rows[0]).toMatchObject({ name: 'qwen2.5-coder:7b', id: 'abc123', processor: '100% GPU' });
  expect(rows[1].processor).toContain('CPU/GPU');
});

it('parses nvidia-smi csv output', () => {
  const rows = parseNvidiaSmi('RTX 4000 SFF Ada, 20480, 1024, 19456, 12');
  expect(rows[0]).toEqual({
    name: 'RTX 4000 SFF Ada',
    vramTotalMb: 20480,
    vramUsedMb: 1024,
    vramFreeMb: 19456,
    utilizationPct: 12
  });
});
