/**
 * Re-export only. These ids used to be MIRRORED here by hand, and this file's own header
 * predicted how that ends: "a change to the seed's ids has to be made here too." One did
 * not, and five specs failed on a drift no type could catch, because the two copies were
 * structurally identical and merely disagreed about a string.
 *
 * `@schemaloom/contracts` is now the single source — see its `fixtures.ts` for why every
 * id there is opaque rather than readable.
 */
export {
  DEMO_PASSWORD,
  HIDDEN_FROM_FREELANCER,
  SEED,
  SEED_EMAILS,
} from '@schemaloom/contracts';
