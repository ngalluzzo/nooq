# Contributing to nooq

Thank you for helping build an editor that is actually open. The rules
below are short because they were all learned the hard way — each one
corresponds to a real incident that made `main` red or shipped someone's
half-finished work to a public repository.

## The covenant

- **License:** Apache-2.0. Every feature ships in this repository, under
  this license, in full — there is no XL tier and there will not be one.
- **Dependencies:** zero unpaid ones; MIT/Apache-2.0 only (see
  GOVERNANCE.md).
- **DCO:** every commit carries `Signed-off-by:` (`git commit -s`).
  CI rejects unsigned history mechanically. There is no CLA.

## The four rules (each one earned)

### 1. Stage files by name, never by directory

`git add packages/editor` once shipped three people's in-flight work to
a public repository. A dirty working tree is normal here — multiple
people share this checkout — so a directory-wide `add` sweeps whatever
else is in flight.

```sh
git add packages/editor/src/dom.ts packages/editor/test/dom.test.ts
```

### 2. If a commit won't build from a clean clone, it isn't done

More than once, a committed file imported a module that existed only as
an untracked file on someone's machine — green locally, red on CI for
everyone else. Before pushing:

```sh
git stash push --keep-index -u   # your staged tree, nothing else
bun run typecheck && bun test    # gates on EXACTLY what you staged
git stash pop                    # everyone's in-flight work restored
```

The `-u` matters: untracked files are exactly the ones CI will not have.

### 3. Run gates unmasked and read them before pushing

`bun run typecheck | tail -1` exits 0 even when typecheck fails — the
pipe returns the last command's status. This shipped a type error to
`main`. Gates run bare, with exit codes checked, and a dirty tail in a
verification run is a stop, not noise.

### 4. Specs change before code (DM-11)

Every behavioral change lands doc-first: the spec amendment cites the
finding that motivated it, then the implementation cites the spec. If
you can't name the section your change amends, you're changing the
wrong thing or you're changing it too early.

## Workflow

- **Every transaction is a nooq transaction** (PHILOSOPHY §1): new
  editor behavior enters through the engine, not around it.
- Tests: `bun test`. Types: `bun run typecheck`. Both green, both
  unmasked, before every push. CI runs them plus the experience-budget
  lab (report mode until budgets are met) and the DCO check.
- Significant changes (new modules, breaking APIs, dependencies,
  philosophy documents) need a public proposal issue open ≥7 days and
  maintainer majority (GOVERNANCE.md). The proposal file is canonical
  text; the issue is the decision of record.
- Performance claims come from the lab (`packages/editor/lab`), with
  its numbers written down. No budget is met because it feels met.

## The experience budgets

If your change touches the writing path, run the lab and look at the
numbers (EB-5/6/7 in EXPERIENCE-BUDGETS.md). The budgets are enforced
in measurement, not aspired to in comments — a change that regressions
a budget is a bug even when every test passes.
