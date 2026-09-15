# Architecture decision records

Why the system is shaped the way it is, one decision per file.

The commit history explains what changed and why at the time. These records
explain the decisions that are still load-bearing — the ones a contributor
would otherwise have to re-derive from the code, or would reasonably propose
reversing because the cost is visible and the benefit is not.

**Format.** Each record has a status, a date, the context, the decision, the
alternatives that were rejected, and the consequences including the costs that
were accepted. The consequences section is the point: a decision recorded without
its cost is an advertisement, not a record.

**When to add one.** When a choice would be expensive to reverse, when a reader
would plausibly assume the wrong thing, or when something looks like an omission
and is not. A decision that is cheap to reverse belongs in a commit message.

---

## Index

| ADR | Decision | The cost that was accepted |
| --- | --- | --- |
| [0001](0001-commit-reveal-claim-codes.md) | Commit-reveal claim codes; the escrow stores `sha256(code)` | The commit is only as strong as the client's entropy, and anyone holding the code can claim |
| [0002](0002-extract-shared-contract-interfaces.md) | Extract shared contract interfaces into an `rlib`-only crate | One more crate, and the trait is load-bearing for the cross-contract ABI |
| [0003](0003-integer-money-end-to-end.md) | Integer money everywhere; **strings** on the JSON wire | An explicit conversion at every boundary, with no lint to catch a regression |
| [0004](0004-permissionless-refunds.md) | `refund_expired` is callable by anyone | A caller can refund the instant a transfer expires, and pays the fee to do it |
| [0005](0005-separate-attester-and-admin-keys.md) | The attester key is not the admin key | Two secrets to rotate, and a legitimate tier change needs the cold key |
| [0006](0006-split-compliance-check-from-commit.md) | Split the pure check from the volume commitment | Two cross-contract calls per transfer, and a caller restriction that had to be added |
| [0007](0007-share-based-pool-accounting.md) | Share-based pool accounting before it is needed | Two numbers to keep consistent everywhere, and rounding dust on each deposit |
| [0008](0008-upgrade-nextjs-rather-than-document-advisories.md) | Move the console to Next.js 16 / Tailwind v4 | Deviates from the brief's Next 14, and deletes the familiar Tailwind config file |

---

## Reversing a decision

If you think one of these is wrong, the useful thing to bring is the concrete
case it fails: the actor, the preconditions and the outcome. Several of these
records deliberately list the experiments that would falsify them — start there.
A record that can be falsified is worth more than one that can only be argued
with.
