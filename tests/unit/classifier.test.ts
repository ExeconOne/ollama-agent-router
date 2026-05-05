import { classifyTask } from '../../src/classifier.js';

it('classifies code generation', () => {
  const out = classifyTask({ messages: [{ role: 'user', content: 'Write a TypeScript function to parse JSON' }] });
  expect(out.taskType).toBe('code_generate');
  expect(out.complexity).toBe('medium');
});

it('honors explicit task type', () => {
  const out = classifyTask({ messages: [{ role: 'user', content: 'hello' }] }, 'agentic_reasoning');
  expect(out.taskType).toBe('agentic_reasoning');
  expect(out.confidence).toBe(1);
});
