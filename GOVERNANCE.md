# nooq Governance

This document operationalizes the commitments in [`README.md`](README.md).
It exists so that nooq's openness survives contact with success.

Almost everything here is boring on purpose. The one interesting part is
**the Covenant**, which is deliberately hard to change.

---

## Roles

- **Contributor** — anyone who submits a change that gets merged. Ownership
  of contributions stays with their authors.
- **Maintainer** — a contributor with commit access, added by lazy
  consensus of existing maintainers after a record of sustained, quality
  contributions. Maintainers review, merge, and set technical direction
  within the philosophy documents.
- **Project lead** — initially the founder. The lead breaks ties and holds
  the `nooq` trademark on behalf of the project. **When nooq reaches five
  maintainers, the lead role converts to a council of maintainers** by
  simple majority vote of maintainers. This transition is expected and
  normal, not exceptional.

## Decision making

- **Routine changes** (bug fixes, docs, implementation details): any
  maintainer merges after one approving review.
- **Significant changes** (new modules, breaking API changes, dependency
  additions, philosophy documents): require a public proposal issue open
  for at least 7 days and majority approval of maintainers.
- **The Covenant** (below): entrenchment rules in its own section.

All decisions of record happen in public issues and pull requests. No
private backchannels for project decisions.

## The Covenant (entrenched commitments)

These four commitments are the reason nooq exists. They may not be amended
by ordinary governance:

1. **All source in this repository is Apache-2.0**, now and in every future
   version. No dual-licensing of any file, feature, or package that lives
   here.
2. **No CLA requiring copyright assignment or exclusive relicensing
   rights** will ever be adopted. The DCO is the only contribution
   agreement.
3. **No feature paywalls.** Nothing shipped in nooq will later be moved
   into a paid-only tier, and no source-level feature will be created
   paid-only.
4. **No dependencies on paywalled foundations.** nooq builds only on
   dependencies that are OSI-approved open source without feature-priced
   tiers.

**Amending the Covenant requires all of:** unanimous consent of every
active maintainer, a 90-day public comment period, and the change called
out by name in a release announcement. Any maintainer who disagrees should
vote no and say why. If the Covenant is ever amended in substance, the
project expects and encourages a fork — that is the system working.

## Contributions & the DCO

- Every commit must include a Developer Certificate of Origin sign-off:
  `git commit -s`, producing a `Signed-off-by: Name <email>` trailer.
  By signing off, contributors certify the DCO
  (https://developercertificate.org/), i.e., that they have the right to
  submit the code under Apache-2.0.
- **There is no CLA.** Contributors keep their copyright; contributions
  are licensed to everyone under Apache-2.0 (Section 5 of the LICENSE
  handles this without any additional paperwork).
- Third-party code may only be imported under licenses compatible with
  Apache-2.0 redistribution, with attribution preserved. Strong copyleft
  code (GPL family) must not be merged into this repository; linking to
  or using permissively-licensed (MIT/ISC/BSD/Apache-2.0) and
  file-level-copyleft (MPL-2.0) dependencies is fine, kept as separate
  upstream dependencies rather than vendored copies where possible.

## Trademark

The name `nooq`, the logo, and the project's identity are held by the
project lead on behalf of the project. This is the one thing nooq keeps
closed, and it is kept openly: **the code is unconditionally yours; the
name is not.** Hosted services and commercial support (see below) need the
name to be protectable to be fundable. Anyone may use the name to refer to
the project in good faith; producing a competing hosted service under the
nooq name is not good-faith use.

## Sustainability rules

Money may fund: operation of hosted collaboration infrastructure,
professional support contracts, and paid development of **open** features.

Money may never fund, purchase, or cause: feature gating, closed-source
add-ons, removal of a feature from core into a paid tier, or roadmap
priority that results in any of these. A paying customer may buy a
feature *existing sooner*; nobody can buy a feature *being closed*.

## Changes to this document

Non-Covenant sections follow the "significant change" process. The
Covenant follows the Covenant's own process. Changes are recorded in git
history, which is the point of putting this in writing before the first
line of code.
