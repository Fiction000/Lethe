import {
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_TIMEOUT_MS,
  JEV_PROBABILITY_SUM_EPSILON,
  JEV_SYSTEM_ONE_ENDPOINT,
  MAX_JEV_TIMEOUT_MS,
  JevAdapterError,
  type JevAnswer,
  type JevChoiceAnswer,
  type JevChoiceQuestion,
  type JevNoulAnswer,
  type JevNoulQuestion,
  type JevQuestion,
  type JevQuestionMap,
  type JevSystemOneRequestOptions,
  type JevSystemOneResponse,
  type JevTransport,
  type JevTransportRequest,
  type JevTransportResponse,
  type JevUsage,
} from './types';

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function invalidConfig(message: string): never {
  throw new JevAdapterError('invalid_config', `Invalid Jev adapter configuration: ${message}.`);
}

function invalidResponse(message: string): never {
  throw new JevAdapterError('invalid_response', `TypeSafe returned an invalid response (${message}).`);
}

function assertQuestionMap(questions: JevQuestionMap): void {
  if (!isRecord(questions)) {
    invalidConfig('questions must be an object');
  }

  const questionIds = Object.keys(questions);
  if (questionIds.length === 0) {
    invalidConfig('questions must contain at least one question');
  }

  for (const questionId of questionIds) {
    if (questionId.length === 0) {
      invalidConfig('question ids must not be empty');
    }
    const question = questions[questionId] as JevQuestion;
    if (!isRecord(question) || (question.type !== 'choice' && question.type !== 'noul')) {
      invalidConfig(`question ${questionId} has an unsupported type`);
    }
    if (!Object.prototype.hasOwnProperty.call(question, 'instructions') || question.instructions === undefined) {
      invalidConfig(`question ${questionId} is missing instructions`);
    }

    if (question.type === 'choice') {
      assertChoiceQuestion(questionId, question);
    } else {
      assertNoulQuestion(questionId, question);
    }
  }
}

function assertChoiceQuestion(questionId: string, question: JevChoiceQuestion): void {
  if (!isRecord(question.criteria)) {
    invalidConfig(`choice question ${questionId} is missing criteria`);
  }
  const labels = Object.keys(question.criteria);
  if (labels.length === 0 || labels.length > 255) {
    invalidConfig(`choice question ${questionId} must have between 1 and 255 options`);
  }
  for (const label of labels) {
    if (label.length === 0) {
      invalidConfig(`choice question ${questionId} has an empty option`);
    }
  }
}

function assertNoulQuestion(questionId: string, question: JevNoulQuestion): void {
  if (question.criteria !== undefined) {
    if (!isRecord(question.criteria) || !hasExactlyKeys(question.criteria, ['true', 'false'])) {
      invalidConfig(`noul question ${questionId} has malformed criteria`);
    }
  }
}

export function resolveJevModel(model: string | undefined): string {
  const resolved = model ?? DEFAULT_JEV_MODEL;
  if (typeof resolved !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/u.test(resolved)) {
    invalidConfig('model must be a non-empty identifier containing only letters, numbers, dot, underscore, or hyphen');
  }
  return resolved;
}

export function isRetryableJevStatus(status: number): boolean {
  return Number.isInteger(status) && RETRYABLE_STATUSES.has(status);
}

export function validateJevTimeout(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_JEV_TIMEOUT_MS) {
    invalidConfig(`timeoutMs must be an integer from 1 to ${MAX_JEV_TIMEOUT_MS}`);
  }
  return resolved;
}

export const fetchJevTransport: JevTransport = async (request: JevTransportRequest): Promise<JevTransportResponse> => {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('fetch is unavailable');
  }
  const response = await globalThis.fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
  });
  return {
    status: response.status,
    text: () => response.text(),
  };
};

function serializeRequest(options: JevSystemOneRequestOptions, model: string): string {
  try {
    const body = JSON.stringify({
      state: options.state,
      model,
      questions: options.questions,
    });
    if (typeof body !== 'string') {
      invalidConfig('state and questions must be JSON serializable');
    }
    return body;
  } catch {
    invalidConfig('state and questions must be JSON serializable');
  }
}

function validateResponseStatus(status: number): void {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new JevAdapterError('transport_error', 'TypeSafe returned an invalid HTTP status.', { retryable: true });
  }
}

function validateUsage(value: unknown): JevUsage {
  if (!isRecord(value) || !hasExactlyKeys(value, ['input_tokens', 'output_tokens'])) {
    invalidResponse('usage is missing required keys');
  }
  const inputTokens = value.input_tokens;
  const outputTokens = value.output_tokens;
  if (
    typeof inputTokens !== 'number' ||
    typeof outputTokens !== 'number' ||
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0
  ) {
    invalidResponse('usage token counts are invalid');
  }
  return { input_tokens: inputTokens as number, output_tokens: outputTokens as number };
}

function validateProbabilityMap(
  value: unknown,
  criteria: Readonly<Record<string, unknown>>,
): Readonly<Record<string, number>> {
  if (!isRecord(value)) {
    invalidResponse('choice probabilities are missing');
  }
  const labels = Object.keys(criteria);
  if (!hasExactlyKeys(value, labels)) {
    invalidResponse('choice probabilities do not match the requested options');
  }

  const probabilities: Record<string, number> = {};
  let sum = 0;
  for (const label of labels) {
    const probability = value[label];
    if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      invalidResponse('choice probabilities must be finite numbers from 0 to 1');
    }
    probabilities[label] = probability;
    sum += probability;
  }
  if (Math.abs(sum - 1) > JEV_PROBABILITY_SUM_EPSILON) {
    invalidResponse('choice probabilities must sum to 1');
  }
  return probabilities;
}

function validateChoiceAnswer(questionId: string, question: JevChoiceQuestion, value: unknown): JevChoiceAnswer {
  if (!isRecord(value) || !hasExactlyKeys(value, ['type', 'choice', 'probabilities', 'confidence'])) {
    invalidResponse(`answer ${questionId} is missing Choice fields`);
  }
  if (value.type !== 'choice' || typeof value.choice !== 'string') {
    invalidResponse(`answer ${questionId} has the wrong Choice shape`);
  }
  const labels = Object.keys(question.criteria);
  if (!labels.includes(value.choice)) {
    invalidResponse(`answer ${questionId} selected an unknown option`);
  }
  const probabilities = validateProbabilityMap(value.probabilities, question.criteria);
  const confidence = value.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    invalidResponse(`answer ${questionId} has an invalid confidence`);
  }
  const highest = Math.max(...Object.values(probabilities));
  if ((probabilities[value.choice] ?? -1) + JEV_PROBABILITY_SUM_EPSILON < highest) {
    invalidResponse(`answer ${questionId} choice is not the highest-probability option`);
  }
  return { type: 'choice', choice: value.choice, probabilities, confidence };
}

function validateNoulAnswer(questionId: string, value: unknown): JevNoulAnswer {
  if (!isRecord(value) || !hasExactlyKeys(value, ['type', 'noul'])) {
    invalidResponse(`answer ${questionId} is missing Noul fields`);
  }
  if (value.type !== 'noul' || typeof value.noul !== 'number' || !Number.isFinite(value.noul)) {
    invalidResponse(`answer ${questionId} has the wrong Noul shape`);
  }
  if (value.noul < 0 || value.noul > 1) {
    invalidResponse(`answer ${questionId} Noul probability is outside 0 to 1`);
  }
  return { type: 'noul', noul: value.noul };
}

function validateAnswer(questionId: string, question: JevQuestion, value: unknown): JevAnswer {
  return question.type === 'choice'
    ? validateChoiceAnswer(questionId, question, value)
    : validateNoulAnswer(questionId, value);
}

/** Validate a decoded System One response against the exact questions sent. */
export function validateJevSystemOneResponse(value: unknown, questions: JevQuestionMap): JevSystemOneResponse {
  assertQuestionMap(questions);
  if (!isRecord(value) || !hasExactlyKeys(value, ['model', 'answers', 'usage'])) {
    invalidResponse('response is missing required top-level keys');
  }
  if (typeof value.model !== 'string' || value.model.length === 0) {
    invalidResponse('response model is missing');
  }
  if (!isRecord(value.answers)) {
    invalidResponse('answers is missing');
  }

  const questionIds = Object.keys(questions);
  if (!hasExactlyKeys(value.answers, questionIds)) {
    invalidResponse('answers do not match the requested question ids');
  }
  const answers: Record<string, JevAnswer> = {};
  for (const questionId of questionIds) {
    answers[questionId] = validateAnswer(questionId, questions[questionId], value.answers[questionId]);
  }
  return {
    model: value.model,
    answers,
    usage: validateUsage(value.usage),
  };
}

function parseAndValidateResponse(text: string, questions: JevQuestionMap): JevSystemOneResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    invalidResponse('response body is not valid JSON');
  }
  return validateJevSystemOneResponse(parsed, questions);
}

/**
 * Make one authenticated, non-retrying System One request.
 * Retry coordination belongs to the caller; retryable is exposed on errors.
 */
export async function requestSystemOne(options: JevSystemOneRequestOptions): Promise<JevSystemOneResponse> {
  if (typeof options.apiKey !== 'string' || options.apiKey.trim().length === 0) {
    invalidConfig('apiKey must be provided by the caller');
  }
  const model = resolveJevModel(options.model);
  const timeoutMs = validateJevTimeout(options.timeoutMs);
  assertQuestionMap(options.questions);
  const body = serializeRequest(options, model);
  const transport = options.transport ?? fetchJevTransport;
  if (typeof transport !== 'function') {
    invalidConfig('transport must be a function');
  }
  if (options.signal?.aborted) {
    throw new JevAdapterError('aborted', 'The Jev request was aborted by the caller.');
  }

  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new JevAdapterError('timeout', 'The Jev request exceeded its timeout.', { retryable: true }));
    }, timeoutMs);
  });
  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (options.signal !== undefined) {
      const onAbort = (): void => {
        callerAborted = true;
        controller.abort();
        reject(new JevAdapterError('aborted', 'The Jev request was aborted by the caller.'));
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort);
    }
  });

  const request: JevTransportRequest = {
    url: JEV_SYSTEM_ONE_ENDPOINT,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body,
    signal: controller.signal,
  };

  const transportPromise = Promise.resolve().then(() => transport(request));
  // A transport that ignores AbortSignal can settle after the bounded race. Attach
  // a rejection handler so a late network failure is never reported as an unhandled rejection.
  void transportPromise.catch(() => undefined);

  const cleanup = (): void => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    removeAbortListener?.();
  };

  const throwRaceError = (error: unknown): never => {
    cleanup();
    if (timedOut) {
      throw new JevAdapterError('timeout', 'The Jev request exceeded its timeout.', { retryable: true });
    }
    if (callerAborted) {
      throw new JevAdapterError('aborted', 'The Jev request was aborted by the caller.');
    }
    if (error instanceof JevAdapterError) {
      throw error;
    }
    throw new JevAdapterError('transport_error', 'The Jev request failed before a response was received.', {
      retryable: true,
    });
  };

  let response: JevTransportResponse;
  try {
    response = await Promise.race([transportPromise, timeoutPromise, abortPromise]);
  } catch (error) {
    throwRaceError(error);
  }

  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    cleanup();
    validateResponseStatus(response.status);
  }
  if (response.status < 200 || response.status >= 300) {
    cleanup();
    throw new JevAdapterError('http_error', `TypeSafe returned HTTP ${response.status}.`, {
      status: response.status,
      retryable: isRetryableJevStatus(response.status),
    });
  }

  let text: string;
  try {
    const textPromise = Promise.resolve().then(() => response.text());
    void textPromise.catch(() => undefined);
    text = await Promise.race([textPromise, timeoutPromise, abortPromise]);
  } catch (error) {
    throwRaceError(error);
  }
  cleanup();
  if (typeof text !== 'string') {
    throw new JevAdapterError('transport_error', 'The Jev response body could not be read.', { retryable: true });
  }
  return parseAndValidateResponse(text, options.questions);
}

export type { JevSystemOneRequestOptions } from './types';
