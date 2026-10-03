declare const process: {
  readonly env: Readonly<Record<string, string | undefined>>;
  exitCode?: number;
};
declare const require: (moduleName: string) => unknown;

const { createHash } = require('node:crypto') as {
  readonly createHash: (algorithm: string) => {
    update(value: string, encoding: string): { digest(encoding: string): string };
    digest(encoding: string): string;
  };
};
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs') as {
  readonly existsSync: (path: string) => boolean;
  readonly mkdirSync: (path: string, options: { readonly recursive: true }) => void;
  readonly readFileSync: (path: string, encoding: 'utf8') => string;
  readonly writeFileSync: (path: string, data: string, encoding: 'utf8') => void;
};

import { createCaptureId, createDraftSnapshot } from '../src/capture/core';
import {
  DEFAULT_JEV_MODEL,
  JevAdapterError,
  classifyCaptureSnapshot,
  fetchJevTransport,
  requestSystemOne,
  type JevCaptureDecision,
  type JevQuestionMap,
  type JevTransport,
  type JevUsage,
} from '../src/jev';
import {
  JEV_PROFILE_CONFIDENCE_THRESHOLD,
  JEV_PROFILE_PROBABILITY_THRESHOLD,
  JEV_PROFILE_TAXONOMY,
  JEV_QUESTION_VERSION,
  JEV_TAG_PROBABILITY_THRESHOLD,
} from '../src/jev/qualityGate';
import { JEV_EVAL_APPROVED_TAGS, JEV_EVAL_CORPUS, type JevCorpusCase } from '../test/fixtures/jev-eval-corpus';

const REPORT_PATH = '/Users/kawana/.hermes/cache/scratch/lethe-jev-live-evaluation.json';
const MARKDOWN_REPORT_PATH = '/Users/kawana/.hermes/cache/scratch/lethe-jev-live-evaluation.md';
const PREREGISTRATION_PATH = '/Users/kawana/.hermes/cache/scratch/lethe-jev-preregistration.json';
const SYNTHETIC_NOW = '2026-09-23T00:00:00.000Z';

type FailureClass = 'schema' | 'service' | 'unknown';

type LiveCaseResult = {
  readonly id: string;
  readonly language: JevCorpusCase['language'];
  readonly kind: JevCorpusCase['kind'];
  readonly expected: JevCorpusCase['expected'];
  readonly elapsedMs: number;
  readonly requestSha256?: string;
  readonly observed:
    | {
        readonly model?: string;
        readonly profile:
          | {
              readonly source: JevCaptureDecision['profile']['source'];
              readonly profile: JevCaptureDecision['profile']['profile'];
              readonly choice?: string;
              readonly probabilities?: Readonly<Record<string, number>>;
              readonly winningProbability?: number;
              readonly confidence?: number;
            }
          | undefined;
        readonly tags: readonly {
          readonly tag: string;
          readonly questionId: string;
          readonly noul: number;
          readonly active: boolean;
          readonly removed: boolean;
          readonly eligibleForAddition: boolean;
        }[];
        readonly usage?: JevUsage;
      }
    | {
        readonly error: string;
        readonly failureClass: FailureClass;
        readonly retryable: boolean;
        readonly status?: number;
      };
};

type RequestRecord = {
  readonly caseId: string;
  readonly requestSha256: string;
  readonly status?: number;
};

type CategoryMetric = {
  readonly category: string;
  readonly kind: 'profile' | 'tag';
  readonly eligibleCases: number;
  readonly accepted: number;
  readonly correctAccepted: number;
  readonly falsePositiveAccepted: number;
  readonly precision: number | null;
  readonly abstention: number | null;
};

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function lastRequestFor(requests: readonly RequestRecord[], caseId: string): RequestRecord | undefined {
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index];
    if (request.caseId === caseId) {
      return request;
    }
  }
  return undefined;
}

function corpusSha256(): string {
  return sha256(canonicalJson(JEV_EVAL_CORPUS));
}

function nowIso(): string {
  return new Date().toISOString();
}

function snapshotFor(item: JevCorpusCase) {
  return createDraftSnapshot({
    id: createCaptureId(() => `jev-eval-${item.id}`),
    body: item.body,
    profile: item.profile,
    tags: item.tags,
    now: () => SYNTHETIC_NOW,
  });
}

function failureClassFor(error: JevAdapterError): FailureClass {
  return error.code === 'invalid_response' ? 'schema' : 'service';
}

function observedDecision(
  decision: JevCaptureDecision,
): Extract<LiveCaseResult['observed'], { readonly tags: readonly unknown[] }> {
  const profile = decision.profile;
  return {
    ...(decision.model === undefined ? {} : { model: decision.model }),
    profile:
      profile.source === 'jev'
        ? {
            source: profile.source,
            profile: profile.profile,
            choice: profile.choice,
            probabilities: { ...profile.probabilities },
            winningProbability: profile.probabilities[profile.choice],
            confidence: profile.confidence,
          }
        : {
            source: profile.source,
            profile: profile.profile,
            ...(profile.source === 'explicit-profile' ? {} : {}),
          },
    tags: decision.tags.map((judgment) => ({
      tag: judgment.tag,
      questionId: judgment.questionId,
      noul: judgment.noul,
      active: judgment.active,
      removed: judgment.removed,
      eligibleForAddition: judgment.eligibleForAddition,
    })),
    ...(decision.usage === undefined ? {} : { usage: decision.usage }),
  };
}

function errorObserved(error: unknown): Extract<LiveCaseResult['observed'], { readonly error: string }> {
  if (error instanceof JevAdapterError) {
    return {
      error: error.code,
      failureClass: failureClassFor(error),
      retryable: error.retryable,
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }
  return { error: 'unknown', failureClass: 'unknown', retryable: true };
}

function profileAccepted(result: LiveCaseResult, profile: 'book' | 'movie' | 'no-match'): boolean {
  if ('error' in result.observed || result.observed.profile === undefined) {
    return false;
  }
  const observed = result.observed.profile;
  return (
    observed.source === 'jev' &&
    observed.profile === profile &&
    (observed.winningProbability ?? 0) >= JEV_PROFILE_PROBABILITY_THRESHOLD &&
    (observed.confidence ?? 0) >= JEV_PROFILE_CONFIDENCE_THRESHOLD
  );
}

function tagAccepted(result: LiveCaseResult, tag: string): boolean {
  if ('error' in result.observed) {
    return false;
  }
  const judgment = result.observed.tags.find((candidate) => candidate.tag === tag);
  return (
    judgment !== undefined &&
    judgment.eligibleForAddition &&
    !judgment.active &&
    !judgment.removed &&
    judgment.noul >= JEV_TAG_PROBABILITY_THRESHOLD
  );
}

function metricForProfile(results: readonly LiveCaseResult[], profile: 'book' | 'movie' | 'no-match'): CategoryMetric {
  const eligible = results.filter((result) => result.expected.source === 'jev');
  const acceptedResults = eligible.filter((result) => profileAccepted(result, profile));
  const correctAccepted = acceptedResults.filter((result) => result.expected.profile === profile).length;
  const falsePositiveAccepted = acceptedResults.length - correctAccepted;
  const positives = eligible.filter((result) => result.expected.profile === profile);
  return {
    category: `profile/${profile}`,
    kind: 'profile',
    eligibleCases: positives.length,
    accepted: acceptedResults.length,
    correctAccepted,
    falsePositiveAccepted,
    precision: acceptedResults.length === 0 ? null : correctAccepted / acceptedResults.length,
    abstention: positives.length === 0 ? null : (positives.length - correctAccepted) / positives.length,
  };
}

function metricForTag(results: readonly LiveCaseResult[], tag: string): CategoryMetric {
  const eligible = results.filter((result) => result.expected.source === 'jev' || result.kind === 'false-positive');
  const acceptedResults = eligible.filter((result) => tagAccepted(result, tag));
  const correctAccepted = acceptedResults.filter((result) => result.expected.tags.includes(tag)).length;
  const falsePositiveAccepted = acceptedResults.length - correctAccepted;
  const positives = eligible.filter((result) => result.expected.tags.includes(tag));
  return {
    category: `tag/${tag}`,
    kind: 'tag',
    eligibleCases: positives.length,
    accepted: acceptedResults.length,
    correctAccepted,
    falsePositiveAccepted,
    precision: acceptedResults.length === 0 ? null : correctAccepted / acceptedResults.length,
    abstention: positives.length === 0 ? null : (positives.length - correctAccepted) / positives.length,
  };
}

function errorsPresent(results: readonly LiveCaseResult[]): boolean {
  return results.some((result) => 'error' in result.observed);
}

function explicitOverridesRespected(results: readonly LiveCaseResult[]): boolean {
  return results
    .filter((result) => result.kind === 'explicit-override')
    .every(
      (result) =>
        !('error' in result.observed) &&
        result.observed.profile !== undefined &&
        result.observed.profile.profile ===
          (result.expected.profile === 'no-match' ? 'plain' : result.expected.profile) &&
        result.observed.profile.source === result.expected.source,
    );
}

function positiveAcceptedInBothLanguages(
  results: readonly LiveCaseResult[],
  profile: 'book' | 'movie' | 'no-match',
): boolean {
  return (['en', 'ja'] as const).every((language) =>
    results.some(
      (result) =>
        result.language === language && result.expected.profile === profile && profileAccepted(result, profile),
    ),
  );
}

function tagAcceptedInBothLanguages(results: readonly LiveCaseResult[], tag: string): boolean {
  return (['en', 'ja'] as const).every((language) =>
    results.some(
      (result) => result.language === language && result.expected.tags.includes(tag) && tagAccepted(result, tag),
    ),
  );
}

function eligibilityForMetric(
  metric: CategoryMetric,
  results: readonly LiveCaseResult[],
  allExplicitOverridesRespected: boolean,
): {
  readonly eligible: boolean;
  readonly reasons: readonly string[];
} {
  const reasons: string[] = [];
  const enoughPositiveCases = metric.correctAccepted >= 2;
  if (!enoughPositiveCases) reasons.push('fewer-than-two-correct-accepted-positive-cases');
  if (metric.falsePositiveAccepted !== 0) reasons.push('false-positive-accepted-action');
  if (errorsPresent(results)) reasons.push('service-or-schema-failure');
  if (!allExplicitOverridesRespected) reasons.push('explicit-override-not-respected');
  const bothLanguages =
    metric.kind === 'profile'
      ? positiveAcceptedInBothLanguages(
          results,
          metric.category.slice('profile/'.length) as 'book' | 'movie' | 'no-match',
        )
      : tagAcceptedInBothLanguages(results, metric.category.slice('tag/'.length));
  if (!bothLanguages) reasons.push('missing-correct-english-and-japanese-positive-acceptances');
  return { eligible: reasons.length === 0, reasons };
}

function recalculateDerivedMetrics(report: Record<string, unknown>): void {
  const results = report.results as readonly LiveCaseResult[];
  const categoryMetrics = [
    metricForProfile(results, 'book'),
    metricForProfile(results, 'movie'),
    metricForProfile(results, 'no-match'),
    ...JEV_EVAL_APPROVED_TAGS.map((entry) => metricForTag(results, entry.tag)),
  ];
  const allExplicitOverridesRespected = explicitOverridesRespected(results);
  const categoryEligibility: Record<string, { readonly eligible: boolean; readonly reasons: readonly string[] }> =
    Object.fromEntries(
      categoryMetrics.map((metric) => [
        metric.category,
        eligibilityForMetric(metric, results, allExplicitOverridesRespected),
      ]),
    );
  report.categoryMetrics = categoryMetrics;
  report.categoryEligibility = categoryEligibility;
  report.allExplicitOverridesRespected = allExplicitOverridesRespected;
  report.zeroServiceOrSchemaFailures = !errorsPresent(results);
  report.qualityGateCandidate = buildQualityGateCandidate(
    report.actualModels as readonly string[],
    categoryMetrics,
    categoryEligibility,
  );
}

function buildQualityGateCandidate(
  actualModels: readonly string[],
  categoryMetrics: readonly CategoryMetric[],
  categoryEligibility: Readonly<Record<string, { readonly eligible: boolean; readonly reasons: readonly string[] }>>,
): Record<string, unknown> | null {
  if (actualModels.length !== 1) {
    return null;
  }
  return {
    model: actualModels[0],
    questionVersion: JEV_QUESTION_VERSION,
    qualifiedProfiles: categoryMetrics
      .filter(
        (metric) =>
          metric.kind === 'profile' &&
          metric.category !== 'profile/no-match' &&
          categoryEligibility[metric.category]?.eligible,
      )
      .map((metric) => ({
        profile: metric.category.slice('profile/'.length),
        meaning: JEV_PROFILE_TAXONOMY[metric.category.slice('profile/'.length) as 'book' | 'movie'],
      })),
    qualifiedTags: categoryMetrics
      .filter((metric) => metric.kind === 'tag' && categoryEligibility[metric.category]?.eligible)
      .map((metric) => {
        const tag = metric.category.slice('tag/'.length);
        const approved = JEV_EVAL_APPROVED_TAGS.find((entry) => entry.tag === tag);
        return { tag, ...(approved?.description === undefined ? {} : { description: approved.description }) };
      }),
  };
}

function preregistration(): Record<string, unknown> {
  return {
    kind: 'jev-live-preregistration',
    createdAt: nowIso(),
    sample: 'small synthetic smoke corpus only; not a general accuracy claim',
    corpus: {
      fixture: 'test/fixtures/jev-eval-corpus.ts',
      sha256: corpusSha256(),
      caseIds: JEV_EVAL_CORPUS.map((item) => item.id),
    },
    questionVersion: JEV_QUESTION_VERSION,
    thresholds: {
      profileWinningProbability: JEV_PROFILE_PROBABILITY_THRESHOLD,
      profileChoiceConfidence: JEV_PROFILE_CONFIDENCE_THRESHOLD,
      noulTagProbability: JEV_TAG_PROBABILITY_THRESHOLD,
    },
    profileTaxonomy: JEV_PROFILE_TAXONOMY,
    approvedTags: JEV_EVAL_APPROVED_TAGS,
    requestBudget: {
      corpusPasses: 1,
      maxCorpusRequests: JEV_EVAL_CORPUS.length,
      diagnosticRequests: 'at most one, only when every corpus response is invalid_response',
      retries: 0,
    },
    labelCorrectionsBeforeProviderCalls: [
      'Mixed novel-plus-film cases are substantively about both approved tag meanings; expected tags were corrected from [] to [topic/reading, topic/cinema]. Their profile remains no-match because the profile taxonomy requires one specific medium.',
    ],
    tuning: 'thresholds, question meanings, and corpus cases are fixed before the live request pass',
  };
}

function loadOrCreatePreregistration(): Record<string, unknown> {
  const expected = preregistration();
  if (!existsSync(PREREGISTRATION_PATH)) {
    mkdirSync('/Users/kawana/.hermes/cache/scratch', { recursive: true });
    writeFileSync(PREREGISTRATION_PATH, `${JSON.stringify(expected, null, 2)}\n`, 'utf8');
    return expected;
  }
  const stored = JSON.parse(readFileSync(PREREGISTRATION_PATH, 'utf8')) as Record<string, unknown>;
  if (canonicalJson(stored) !== canonicalJson({ ...expected, createdAt: stored.createdAt })) {
    throw new Error('preregistration does not match the fixed live-evaluation contract');
  }
  return stored;
}

async function diagnosticRequest(apiKey: string, transport: JevTransport): Promise<Record<string, unknown>> {
  const questions: JevQuestionMap = {
    schema_probe: {
      type: 'noul',
      instructions: 'For this synthetic diagnostic only, is the word "probe" present in the supplied state?',
      criteria: { true: 'The word is present.', false: 'The word is absent.' },
    },
  };
  try {
    const response = await requestSystemOne({
      apiKey,
      state: { syntheticDiagnostic: 'probe' },
      questions,
      model: DEFAULT_JEV_MODEL,
      transport,
    });
    return {
      status: 'passed-schema-check',
      model: response.model,
      usage: response.usage,
      answer: response.answers.schema_probe,
    };
  } catch (error) {
    return { status: 'failed-schema-check', observed: errorObserved(error) };
  }
}

function markdownReport(report: Record<string, unknown>): string {
  const results = report.results as readonly LiveCaseResult[];
  const eligibility = report.categoryEligibility as Record<string, { eligible: boolean; reasons: readonly string[] }>;
  const qualityGateCandidate = report.qualityGateCandidate as
    | {
        readonly qualifiedProfiles?: readonly { readonly profile: string }[];
        readonly qualifiedTags?: readonly { readonly tag: string }[];
      }
    | null
    | undefined;
  const lines = [
    '# Jev live evaluation',
    '',
    '- Scope: small synthetic English/Japanese smoke corpus only; this is not a general accuracy claim.',
    `- Timestamp: ${String(report.timestamp)}`,
    `- Actual model(s): ${JSON.stringify(report.actualModels)}`,
    `- Corpus SHA256: ${String(report.corpusSha256)}`,
    `- Request aggregate SHA256: ${String(report.requestSha256)}`,
    `- Status: ${String(report.status)}`,
    `- Live-qualified categories: ${
      qualityGateCandidate === null || qualityGateCandidate === undefined
        ? 'none'
        : [
            ...(qualityGateCandidate.qualifiedProfiles ?? []).map((entry) => `profile/${entry.profile}`),
            ...(qualityGateCandidate.qualifiedTags ?? []).map((entry) => `tag/${entry.tag}`),
          ].join(', ')
    }`,
    '- Cost: unavailable (provider prices were not verified).',
    '',
    '## Fixed preregistration',
    '',
    `- Profile gate: winning probability >= ${JEV_PROFILE_PROBABILITY_THRESHOLD} and Choice confidence >= ${JEV_PROFILE_CONFIDENCE_THRESHOLD}.`,
    `- Tag gate: Noul >= ${JEV_TAG_PROBABILITY_THRESHOLD}.`,
    `- Question version: ${JEV_QUESTION_VERSION}.`,
    '- No threshold/prompt/case tuning was performed after provider calls.',
    '',
    '## Category metrics',
    '',
    '| Category | Accepted | Correct | False positive | Precision | Abstention | Eligible |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const metric of report.categoryMetrics as readonly CategoryMetric[]) {
    const category = metric.category;
    const eligibilityForCategory = eligibility[category];
    lines.push(
      `| ${category} | ${metric.accepted} | ${metric.correctAccepted} | ${metric.falsePositiveAccepted} | ${
        metric.precision === null ? 'n/a' : metric.precision.toFixed(3)
      } | ${metric.abstention === null ? 'n/a' : metric.abstention.toFixed(3)} | ${
        eligibilityForCategory?.eligible ? 'yes' : 'no'
      } |`,
    );
  }
  lines.push('', '## Cases', '', '| Case | Kind | Elapsed ms | Model / result |', '| --- | --- | ---: | --- |');
  for (const result of results) {
    const outcome =
      'error' in result.observed
        ? `error:${result.observed.error}`
        : `${result.observed.profile?.source ?? 'unknown'}:${result.observed.profile?.profile ?? 'unknown'}`;
    lines.push(`| ${result.id} | ${result.kind} | ${result.elapsedMs} | ${outcome} |`);
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const replayPath = process.env.JEV_REPLAY_REPORT_PATH;
  if (typeof replayPath === 'string' && replayPath.length > 0) {
    if (replayPath !== REPORT_PATH) {
      throw new Error('JEV_REPLAY_REPORT_PATH must point to the saved Jev report');
    }
    const report = JSON.parse(readFileSync(REPORT_PATH, 'utf8')) as Record<string, unknown>;
    recalculateDerivedMetrics(report);
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    writeFileSync(MARKDOWN_REPORT_PATH, markdownReport(report), 'utf8');
    console.log(`Replayed saved Jev report without provider requests: ${REPORT_PATH}`);
    return;
  }

  const apiKey = process.env.TYPESAFE_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    console.error('Set TYPESAFE_API_KEY to run the live Jev evaluation. No request was made.');
    process.exitCode = 2;
    return;
  }

  const preregistered = loadOrCreatePreregistration();
  const requestRecords: RequestRecord[] = [];
  let activeCaseId = 'unassigned';
  const transport: JevTransport = async (request) => {
    const record: { caseId: string; requestSha256: string; status?: number } = {
      caseId: activeCaseId,
      requestSha256: sha256(request.body),
    };
    try {
      const response = await fetchJevTransport(request);
      record.status = response.status;
      return response;
    } finally {
      requestRecords.push(record);
    }
  };

  const results: LiveCaseResult[] = [];
  for (const item of JEV_EVAL_CORPUS) {
    const snapshot = snapshotFor(item);
    const started = performance.now();
    activeCaseId = item.id;
    try {
      const decision = await classifyCaptureSnapshot(snapshot, {
        apiKey,
        approvedTags: JEV_EVAL_APPROVED_TAGS,
        transport,
      });
      const request = lastRequestFor(requestRecords, item.id);
      results.push({
        id: item.id,
        language: item.language,
        kind: item.kind,
        expected: item.expected,
        elapsedMs: Number((performance.now() - started).toFixed(3)),
        ...(request === undefined ? {} : { requestSha256: request.requestSha256 }),
        observed: observedDecision(decision),
      });
    } catch (error) {
      const request = lastRequestFor(requestRecords, item.id);
      results.push({
        id: item.id,
        language: item.language,
        kind: item.kind,
        expected: item.expected,
        elapsedMs: Number((performance.now() - started).toFixed(3)),
        ...(request === undefined ? {} : { requestSha256: request.requestSha256 }),
        observed: errorObserved(error),
      });
    } finally {
      activeCaseId = 'unassigned';
    }
  }

  const allSchemaFailures =
    results.length === JEV_EVAL_CORPUS.length &&
    results.every((result) => {
      return 'error' in result.observed && result.observed.error === 'invalid_response';
    });
  let diagnostic: Record<string, unknown> | undefined;
  if (allSchemaFailures) {
    activeCaseId = 'diagnostic';
    diagnostic = await diagnosticRequest(apiKey, transport);
    activeCaseId = 'unassigned';
  }

  const categoryMetrics = [
    metricForProfile(results, 'book'),
    metricForProfile(results, 'movie'),
    metricForProfile(results, 'no-match'),
    ...JEV_EVAL_APPROVED_TAGS.map((entry) => metricForTag(results, entry.tag)),
  ];
  const allExplicitOverridesRespected = explicitOverridesRespected(results);
  const categoryEligibility: Record<string, { readonly eligible: boolean; readonly reasons: readonly string[] }> =
    Object.fromEntries(
      categoryMetrics.map((metric) => [
        metric.category,
        eligibilityForMetric(metric, results, allExplicitOverridesRespected),
      ]),
    );
  const actualModels = [
    ...new Set(
      results.flatMap((result) =>
        'error' in result.observed || result.observed.model === undefined ? [] : [result.observed.model],
      ),
    ),
  ];
  if (diagnostic?.status === 'passed-schema-check' && typeof diagnostic.model === 'string') {
    actualModels.push(diagnostic.model);
  }
  const uniqueModels = [...new Set(actualModels)];
  const failures = results
    .filter((result) => 'error' in result.observed)
    .map((result) => ({
      caseId: result.id,
      ...result.observed,
    }));
  const requestSha256 = sha256(canonicalJson(requestRecords));
  const qualityGateCandidate = buildQualityGateCandidate(uniqueModels, categoryMetrics, categoryEligibility);
  const report: Record<string, unknown> = {
    kind: 'live-evaluation',
    status: failures.length === 0 ? 'complete' : 'blocked-by-provider-or-schema-failures',
    timestamp: nowIso(),
    sample: 'small synthetic smoke corpus only; not a general accuracy claim',
    preregistrationPath: PREREGISTRATION_PATH,
    preregistration: preregistered,
    corpusFixture: 'test/fixtures/jev-eval-corpus.ts',
    corpusSha256: corpusSha256(),
    actualModels: uniqueModels,
    requestSha256,
    requests: requestRecords,
    requestBudget: {
      corpusRequests: requestRecords.filter((request) => request.caseId !== 'diagnostic').length,
      expectedCorpusRequests: JEV_EVAL_CORPUS.length,
      diagnosticRequests: requestRecords.filter((request) => request.caseId === 'diagnostic').length,
      retries: 0,
    },
    thresholds: {
      profileWinningProbability: JEV_PROFILE_PROBABILITY_THRESHOLD,
      profileChoiceConfidence: JEV_PROFILE_CONFIDENCE_THRESHOLD,
      noulTagProbability: JEV_TAG_PROBABILITY_THRESHOLD,
    },
    questionVersion: JEV_QUESTION_VERSION,
    profileTaxonomy: JEV_PROFILE_TAXONOMY,
    categoryMetrics,
    categoryEligibility,
    qualityGateCandidate,
    allExplicitOverridesRespected,
    zeroServiceOrSchemaFailures: failures.length === 0,
    cost: { status: 'unavailable-unverified-provider-prices', monetaryCostUsd: null },
    diagnostic,
    failures,
    results,
  };

  mkdirSync('/Users/kawana/.hermes/cache/scratch', { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(MARKDOWN_REPORT_PATH, markdownReport(report), 'utf8');
  console.log(`Wrote bounded Jev evaluation report: ${REPORT_PATH}`);
  console.log(`Wrote concise Jev evaluation summary: ${MARKDOWN_REPORT_PATH}`);
  console.log(`Cases: ${results.length}; requests: ${requestRecords.length}; failures: ${failures.length}`);
  if (diagnostic !== undefined) {
    console.log(`Schema diagnostic: ${String(diagnostic.status)}`);
  }
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Live Jev evaluation failed before report creation.');
  process.exitCode = 1;
});
