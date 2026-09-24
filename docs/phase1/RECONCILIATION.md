# Reconciliation — decisions that override the five design documents

Step 0 (the punch list in `00-OVERVIEW.md` §5) applied 21 deltas across the five
documents. Two items could not be settled by the per-document fixers, because the
punch list itself was written against a **stale revision of doc 04** and one delta was
backwards. They are settled here.

**Precedence: this file wins over all five design documents.** Where a design document
still says otherwise, this file is the implementation target.

---

## R-1 — Redaction marks: two independent flags, not a three-level enum

**Conflict.** Doc 04 §2.2 declares `restricted?: RestrictionMark` with
`level: 'stub' | 'masked' | 'propsRedacted'`. Doc 04 had flattened this to
`restricted?: true` in an earlier revision and then *reverted*, on doc 05's own R27
grounds. Doc 05 has since been edited (∆2) to the flat form plus a second flag. Applying
∆2 as written left the two documents disagreeing again — the exact failure Step 0 exists
to prevent.

**Decision: doc 05's shape wins.**

```ts
interface IrBase {
  // ...
  /** This object is hidden from the viewer: an entity stub, a masked field, or a
   *  badge-only index/constraint. Which of the three is recoverable from the
   *  object's TYPE, so it needs no level. */
  restricted?: true;
  /** This object's engineProps were blanked. ORTHOGONAL to `restricted` — a fully
   *  visible object can carry this. */
  propsRedacted?: true;
}
```

**Why, and why doc 04's restore argument does not survive it.** Doc 04 is right that the
three states are visually distinct: a stub renders a lock badge, a masked field renders
blanked, and a props-redacted object renders "some properties are hidden from you" and
**not** a lock badge. It is wrong that a `level` is how you distinguish them.

`propsRedacted` is **orthogonal to restriction, not a grade of it**. A fully visible
entity — one the viewer has every right to see — can have its `engineProps` blanked
because a `default` expression names a restricted column (R27, leaks L3–L6). Encoding
that as `restricted: { level: 'propsRedacted' }` forces a visible object to claim it is
restricted, so every `if (object.restricted)` check in the canvas, the exporter and the
AI serializer starts hiding objects the viewer is allowed to see. A three-value enum on
the wrong axis is a worse bug than a redundant boolean.

The distinction doc 04 wanted to keep is preserved without the level: a restricted
`Entity` is a stub, a restricted `Field` is masked, a restricted `Index`/`Constraint` is
badge-only. The object's own type carries it. The exporter's rule becomes
`skip if restricted && type === 'entity'`, `keep if propsRedacted` — which is what doc 04
asked for.

**Action for implementers:** declare both flags on `IrBase`. Treat doc 04 §2.2's
`RestrictionMark` and its `level` union as deleted. Doc 05 is already correct as edited.

---

## R-2 — Stub entities carry the DEFAULT namespaceId, and a namespace survives only if it holds a visible entity

**Conflict.** Punch-list ∆5 says a stub entity carries its real `id`, `kind` **and**
`namespaceId`. Doc 04 §10.2 rule 4 deliberately overrides doc 05 §8.3 and says a stub
carries the project's **default** `namespaceId`. The punch list does not cover the
namespace-survival rule at all, and the two documents state different ones.

**Decision: doc 04 wins on both halves.**

- A stub entity carries its **real `id`** (needed for "Request access", and it costs
  nothing) and its **real `kind`**, but the project's **default `namespaceId`**.
- A namespace survives redaction only if it contains **at least one visible entity**.
  Doc 05's weaker rule — survives if it contains at least one surviving entity, stub or
  full — is superseded.

**Why.** A namespace name is itself a name, and `payroll_private` leaks exactly what ∆4
spent the whole masked-field argument protecting. Doc 05's rule also keeps a namespace
alive purely to host a stub, or dangles the reference when the namespace was dropped for
holding no visible entity. This is the same security direction as ∆4, applied one level
up, and ∆5 was written without noticing doc 04 had already reasoned it through.

**Action for implementers:** `VisibilityFilter` assigns stubs the default namespace and
drops any namespace with no visible entity. Add a redaction test asserting that a
namespace holding only restricted entities does not appear in a `RedactedModel`.

---

## R-3 — `MAX_FIELD_DEPTH` is owned by `schema-model`, re-exported by `contracts`

**Conflict.** Build-order step 3 lists `MAX_FIELD_DEPTH` among the `packages/contracts`
exports; doc 02 §3003 says it is "declared in `packages/schema-model`".

**Decision: `schema-model` owns it; `contracts` re-exports.** C10 fixes the dependency as
`contracts -> schema-model`, so the reverse import the build order implies is impossible,
and `validateModel` is the primary consumer. `contracts` re-exports it so the API layer
has one import site for transport-adjacent constants.

**Status: already implemented** in `packages/schema-model/src/constants.ts`, re-exported
from `packages/contracts/src/index.ts`.

---

## Still open, not blocking Phase 1

Recorded so they are not rediscovered:

- **Doc 01's conformance options argument.** ∆9 resolved the name to
  `runEngineConformance(engine, fixtures)` and dropped a stray optional third parameter.
  If the suite genuinely needs options, doc 03 §17 owns that call and should say so.
- **`min(300s, validUntil)` is a remaining-lifetime subtraction.** Doc 01 §4.4 writes it
  as `min(300s, validUntil - now)`, which is the correct reading. A literal
  `min(300, validUntil)` against an absolute timestamp always picks 300, silently
  disabling the expiry-derived TTL. Implement it as remaining seconds.
