import { ChatCompletionRequest, Classification, TaskType } from './types.js';

const codeMarkers = [
  'typescript',
  'javascript',
  'node.js',
  'python',
  'function',
  'class ',
  'stack trace',
  'exception',
  'compile',
  'refactor',
  'pull request',
  'diff --git',
  '```'
];

const toolMarkers = ['tool', 'function call', 'json schema', 'api call', 'webhook', 'bash', 'shell command'];
const reasoningMarkers = ['plan', 'architecture', 'design', 'debug', 'investigate', 'root cause', 'step by step'];
const summarizeMarkers = ['summarize', 'summary', 'tl;dr', 'extract key points'];
const reviewMarkers = ['review', 'audit', 'risks', 'find bugs', 'code review'];
const fixMarkers = ['fix', 'bug', 'failing test', 'patch', 'regression'];
const generateMarkers = ['write', 'implement', 'create', 'generate', 'build'];

export function classifyTask(request: ChatCompletionRequest, explicitTaskType?: TaskType | 'auto'): Classification {
  if (explicitTaskType && explicitTaskType !== 'auto') {
    return {
      taskType: explicitTaskType,
      complexity: explicitTaskType === 'agentic_reasoning' || explicitTaskType === 'large_context' ? 'heavy' : 'medium',
      requiresLargeContext: explicitTaskType === 'large_context',
      requiresToolUse: explicitTaskType === 'tool_use',
      confidence: 1
    };
  }

  const text = extractMessageText(request).toLowerCase();
  const tokenEstimate = Math.ceil(text.length / 4);
  const hasCode = containsAny(text, codeMarkers);
  const requiresToolUse = containsAny(text, toolMarkers);
  const requiresLargeContext = tokenEstimate > 12000 || text.includes('large context') || text.includes('entire repository');

  let taskType: TaskType = 'simple_chat';
  let confidence = 0.55;

  if (requiresLargeContext) {
    taskType = 'large_context';
    confidence = 0.8;
  } else if (requiresToolUse) {
    taskType = 'tool_use';
    confidence = 0.75;
  } else if (containsAny(text, reviewMarkers) && hasCode) {
    taskType = 'code_review';
    confidence = 0.82;
  } else if (containsAny(text, fixMarkers) && hasCode) {
    taskType = 'code_fix';
    confidence = 0.8;
  } else if (containsAny(text, generateMarkers) && hasCode) {
    taskType = 'code_generate';
    confidence = 0.78;
  } else if (containsAny(text, summarizeMarkers)) {
    taskType = 'summarize';
    confidence = 0.86;
  } else if (containsAny(text, reasoningMarkers) && (text.length > 1200 || text.includes('multi-step'))) {
    taskType = 'agentic_reasoning';
    confidence = 0.72;
  } else if (text.length < 180 && (text.includes('classify') || text.includes('route') || text.includes('triage'))) {
    taskType = 'triage';
    confidence = 0.7;
  }

  const complexity = classifyComplexity(text, taskType, tokenEstimate);
  return { taskType, complexity, requiresLargeContext, requiresToolUse, confidence };
}

export function extractMessageText(request: Pick<ChatCompletionRequest, 'messages'>): string {
  return request.messages
    .map((message) => {
      if (typeof message.content === 'string') return message.content;
      if (Array.isArray(message.content)) {
        return message.content
          .map((part) => {
            if (typeof part === 'string') return part;
            if (part && typeof part === 'object' && 'text' in part) return String(part.text ?? '');
            return '';
          })
          .join('\n');
      }
      return JSON.stringify(message.content ?? '');
    })
    .join('\n');
}

function classifyComplexity(text: string, taskType: TaskType, tokenEstimate: number): Classification['complexity'] {
  if (taskType === 'large_context' || taskType === 'agentic_reasoning' || tokenEstimate > 12000) return 'heavy';
  if (tokenEstimate > 3000 || text.includes('architecture') || text.includes('debug')) return 'medium';
  if (taskType.startsWith('code_') || taskType === 'tool_use') return 'medium';
  return 'light';
}

function containsAny(text: string, markers: string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}
