---
name: receipts
description: Check which of your code changes a test would actually notice. Use after changing source code and before saying the work is done, tested, or fixed; also when asked for proof that tests cover a change, or to review how well a diff is tested.
---

# Receipts

"The tests pass" says the suite is green. It does not say the suite would go red
if your change were wrong. Receipts measures that directly: for each piece of
source code you changed, it puts the old code back in a scratch copy of the
repository and runs the tests. Tests fail: that change is **proven**. Tests still
pass: nothing is checking it, and it is **unproven**.

## Running it

The CLI is in this plugin, two directories above this file: `../../bin/receipts.mjs`
relative to this skill's directory. Use `receipts` instead if it is on PATH.

```bash
node <skill directory>/../../bin/receipts.mjs prove             # uncommitted work
node <skill directory>/../../bin/receipts.mjs prove --base main # the whole branch
```

- The test command comes from `.receipts.json` (`{"test": "..."}`) or is detected.
  If neither works, pass `--test "<command>"`. Prefer a fast, fail-fast command.
- It runs the tests once per changed unit, so expect roughly
  (number of changes + 2) x the duration of one test run.
- Your working tree is never modified. Everything happens in a temporary copy.

## Reading the result

| Result | Meaning | What to do |
|---|---|---|
| proven | tests fail when this change is undone | nothing |
| UNPROVEN | tests pass with the old code | see below |
| trivial | comments or whitespace only | nothing |
| not run | budget or cap reached | say so; rerun with a larger `--budget` |
| "tests still pass" with the change reverted | the tests prove nothing about this change | treat every change as unproven |
| "TESTS FAIL" as delivered | the work is not done | fix it first |

For each UNPROVEN change, do exactly one of these:

1. **Write a test that fails without the change**, then run receipts again.
2. **Remove the change** if it is not needed for the task.
3. **Report it as unverified** to the user, by file and line, if a test is not
   practical (logging, wiring, UI glue).

## Rules

- Report the summary line and every UNPROVEN change and test integrity warning
  exactly as printed. Do not round up, and do not describe unproven code as tested.
- Never weaken, skip, or delete a test, or edit an expected value, to raise the
  score. Receipts reports those edits separately under "test integrity".
- A test written only to make a line count as proven is worse than an honest
  "unverified". Assert the behaviour the user asked for.
- "Proven" means the tests notice the change is missing. It does not mean the
  change is correct. Do not claim more than that.
