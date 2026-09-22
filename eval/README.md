# Evaluation set

Realistic stretches of activity with the outcome we expect. The fixtures are the contract for
"does the pipeline still behave?" and, later, the seed of a fine-tuning dataset.

Two ways to run them:

1. With the scripted fake model, on every change: `pnpm --dir app test src/core/eval.test.ts`.
   This checks everything the core decides: which reads are kept, what the model is allowed to
   see, what the guard lets through, and that nothing listed under mustNotAppear can leave.
2. With the real pinned model, as a release gate. The desktop app sub-project adds that runner.
   It ignores the "model" block and checks "expectReal" together with "outcomes",
   "modelMustNotSee" and "mustNotAppear".

Adding a fixture: copy the closest one, change the reads, write the expectation first, run it.
Add one for every wrong outcome found while tuning. All people, companies and credentials in
fixtures are invented. Never paste real screen text into this folder.

## Adversarial fixtures (09 and up)

Fixtures whose category starts with `adversarial-` reuse the reads of an earlier fixture, but the
scripted model tries to leak that fixture's forbidden terms, one per statement, next to one clean
statement. Only the clean one may reach the digest. They exist because a fixture whose scripted
model never misbehaves cannot fail the guard. Only terms the model could really have seen are used:
text that is scrubbed or excluded before the model never reaches it, so it cannot leak it.

## Running against the real model

`app/src/eval/runFixture.ts` plays a fixture through the pipeline with any `ModelPort` and
`judgeReal` holds the result to `expectReal`, `outcomes`, `modelMustNotSee` and `mustNotAppear`.
The desktop app wires it to the real model host as a release gate.

## Running the gate

The release gate runs the self-test and every non-adversarial fixture through the real pipeline with
the real model (about two minutes on an M2). pnpm runs scripts from `app/`, so give absolute paths:

    pnpm --dir app eval:gate "$HOME/.cache/clave-agent/models/hf_unsloth_Qwen3.5-4B.Q4_K_M.gguf" "$PWD/eval/fixtures"

Lines: `PASS`, `NOTE` (a quality finding: how many statements, for which targets), `FAIL` (a safety
problem: a forbidden string reached the model or could leave, or a read was kept or skipped wrongly),
`SKIP` (adversarial fixtures differ only in their scripted model, which a real run ignores).

Exit codes: `0` everything passed; `2` safe, with quality findings (tuning notes, not blockers);
`1` a safety problem or the gate could not run; `64` wrong arguments.
