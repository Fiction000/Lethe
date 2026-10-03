# Lethe Jev adapter

`src/jev/index.ts` is a side-effect-free integration boundary for TypeSafe System One.
It accepts a submitted `CaptureSnapshot`, sends only that snapshot's body/profile/fields/tags,
and returns typed judgments. It never writes notes, mutates snapshots, generates prose, or
invents author/director/title metadata.

## Parent integration

```ts
import { classifyCaptureSnapshot } from './src/jev';

const decision = await classifyCaptureSnapshot(snapshot, {
  apiKey, // supplied by the parent integration; this module never reads credentials
  approvedTags: [
    { tag: 'topic/reading', description: 'Substantively about reading or a book.' },
  ],
  model: 'jev-latest', // optional; validated identifier
  timeoutMs: 15_000, // optional, bounded to 1..120000 ms
  transport, // inject in tests; omit to use fetch
});
```

`JevClassifierOptions.transport` is a `JevTransport` function. A request is a single
`POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer ...`, JSON
`state`, `model`, and `questions`. The adapter does not retry. `JevAdapterError.retryable`
and `JevAdapterError.status` tell a coordinator whether retrying is appropriate without
including the key, request body, or provider error body in the error message.

## Judgment contract

- Auto captures without an active `type/book` or `type/movie` intent get one batched
  Choice with exactly `book`, `movie`, and `no-match`. `no-match` maps to the `plain`
  profile. Explicit profile selection and active primary type tags bypass that Choice.
- Each configured `ApprovedJevTag` gets an independent Noul in the same request. The
  returned `noul` is raw probability; no automatic threshold or write is applied.
- `JevTagJudgment.removed` and `eligibleForAddition` preserve user tag tombstones.
  `selectJevTagSuggestions(judgments, threshold)` is a caller-owned pure policy helper
  and never returns active or removed tags.
- Choice answers require the exact question ids, option labels, probability keys, a
  normalized probability sum, and a finite 0..1 confidence. Noul answers require a
  finite 0..1 `noul`; Noul has no confidence field.
- Response `usage.input_tokens` and `usage.output_tokens` are required non-negative
  safe integers. Unknown response keys, missing keys, wrong answer types, malformed
  JSON, and unknown labels are rejected.

## Offline evaluation

`test/fixtures/jev-eval-corpus.ts` is a frozen English/Japanese label set containing
clear, ambiguous, unrelated, false-positive, and explicit-override cases. It is not a
provider result. `scripts/jev-eval.ts` reads `TYPESAFE_API_KEY` only when explicitly run,
prints a separate `{ "kind": "live-evaluation" }` envelope with case ids and judgments,
and never prints the key or note bodies. It performs no request when the variable is absent.
