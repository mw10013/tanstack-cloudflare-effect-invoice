# Organization Bootstrap Fault Tolerance Research

## TL;DR

- Assume the required Better Auth calls are discrete, can fail independently, and are not idempotent.
- Therefore the only viable design is a single bootstrap owner that runs synchronously at the auth boundary.
- Do not let the user into the app until bootstrap invariants are true.
- Do not depend on a background reconciler for immediate correctness.
- After any ambiguous failure, do not blindly retry writes. Read current durable state first, then continue from the first unmet invariant.
- Queue and Durable Object updates are projection work. They cannot be allowed to decide whether the account is usable.

## First-Principles Constraints

We need a workflow that turns:

1. authenticated user

into:

1. authenticated user
2. organization exists
3. owner membership exists
4. active organization is set
5. app authorization works

The hard constraints are:

- the Better Auth calls are separate calls
- any one of them can fail
- a failure may happen after the side effect already committed
- immediate success matters; this cannot be left to eventual repair later
- if the user gets into the app before bootstrap completes, the system is broken

Those constraints eliminate a lot of fake solutions.

## What Is Not Good Enough

## Not a background reconciler

A periodic background scanner is not the primary solution.

Reason:

- if the user is authenticated but not provisioned, the app is already unusable
- waiting for some future repair cycle is too late

A repair path can exist as a safety net, but it cannot be the thing that makes bootstrap work.

## Not queue-first correctness

Queues are useful for projection and retry.

Queues are not good enough for immediate correctness because:

- delivery is asynchronous
- lag is normal
- retries are normal
- duplicates are normal

If the first usable request depends on a queue having already run, the design is brittle.

## Not free-floating API calls

The Better Auth calls cannot be scattered across random hooks, page loads, or route handlers.

If login is one call, create organization is another, and set active organization is another, then one thing must own that chain.

Without one owner, there is no place to reason about retries, partial success, or completion.

## The Correct Owner

From first principles, the correct owner is:

> the boundary that converts "user has authenticated" into "user may enter the app"

That boundary must synchronously own bootstrap.

In practice, that means the auth callback or post-login handoff path, not some later page and not some best-effort background process.

The flow should be:

1. authenticate user
2. enter bootstrap owner
3. finish or verify provisioning
4. only then redirect to app

If bootstrap cannot be completed, the user should stay on a dedicated "setting up your account" or error state, not proceed into the app.

## Required Invariants

Bootstrap is complete only when all of these are true:

1. user exists
2. account exists if the login method requires one
3. exactly one intended organization exists for bootstrap purposes
4. owner membership exists for that user in that organization
5. active organization is set for the session, or equivalent app state is ready
6. the app can authorize the user immediately after redirect

These invariants define completion. API success responses do not.

## Core Design Rule

The workflow must be:

> verify state, do one write, verify state again

That is the only safe pattern when writes may have ambiguous outcomes.

## Bootstrap State Machine

Use a single bootstrap runner with this shape:

1. Read current durable state.
2. Find the first unmet invariant.
3. Perform exactly one write aimed at that invariant.
4. Read durable state again.
5. Repeat until all invariants are true.
6. Only then let the user enter the app.

This is a convergent state machine.

It does not assume any call is idempotent.
It only assumes we can observe durable truth after each step.

## Safe Retry Rule

If a write call fails, times out, or returns an ambiguous result:

1. do not retry immediately
2. read current durable state
3. if the target invariant is now true, continue
4. if the target invariant is still false, retry the next write

This avoids double-creating or double-mutating when an API call succeeded but the caller did not observe success.

## The Necessary Read Side

This architecture only works if we have a reliable way to observe durable truth.

For each write step, we need a corresponding read that can answer questions like:

- does the user already have the intended organization?
- does owner membership already exist?
- is the session already associated with the organization?
- is the app-visible authorization state already usable?

If we cannot read those truths, then safe retry is impossible.

That is not a code-style preference. That is a correctness requirement.

## Viable Immediate Workflow

From first principles, the immediate workflow should look like this:

## Phase 1: authentication

- run the Better Auth login flow
- once auth succeeds, do not redirect to the app yet

## Phase 2: synchronous bootstrap gate

The bootstrap owner now runs the state machine.

Example structure:

1. Check whether the required organization already exists for this user.
2. If not, call Better Auth organization creation.
3. Re-read durable state.
4. Check whether owner membership exists.
5. If not, create or repair it through the correct Better Auth path.
6. Re-read durable state.
7. Check whether active organization is set.
8. If not, set it.
9. Re-read durable state.
10. Check whether the app can authorize immediately.
11. If yes, redirect to the app.
12. If no, stay in bootstrap and continue repair or fail explicitly.

The important property is not the exact sequence. The important property is that every write is followed by verification before moving on.

## Phase 3: app entry

Only after all invariants are true should the user be redirected into the app.

This is how you avoid the state "logged in but unusable".

## Immediate Correctness Requirement

The app cannot depend on asynchronous projection to become usable after redirect.

That means one of two things must be true before app entry:

1. the projection is synchronously seeded during bootstrap
2. the app authorization path reads durable truth directly or can repair synchronously from durable truth

If neither is true, the system is still racey.

## Role of Queues and Durable Objects

Queues and Durable Objects are still useful, but only in the right place.

## Queue

Use queues for:

- projection
- fan-out
- retries of non-user-facing follow-up work

Do not use queues as the thing that makes first login succeed.

## Durable Objects

Use Durable Objects for:

- local authorization cache
- coordination
- session-adjacent app state

But if the Durable Object cache can be stale, then either:

- bootstrap must synchronously seed it before redirect
- or app entry must be able to repair from durable truth on first use

Otherwise the first request race remains.

## Background Repair, Reframed

Background repair is optional and secondary.

If it exists, its role is:

- recover from crashes after the auth boundary was crossed but before bootstrap completed
- fix rare lost projection updates
- improve operational safety

Its role is not:

- making first login work
- making the app usable after redirect

That distinction matters.

## Real Architectural Conclusion

The real problem is not just that the APIs are discrete.

The real problem is this:

> there is no single synchronous owner between "auth succeeded" and "user may enter app"

That is the thing that must be fixed.

## Recommendation

## Primary recommendation

Implement a single bootstrap owner at the auth boundary.

That owner should:

1. run synchronously before app entry
2. evaluate durable invariants
3. issue one Better Auth write at a time
4. re-read durable truth after every write or failure
5. only redirect when the account is actually usable

## Secondary recommendation

Make projection state non-authoritative for first app entry.

That means either:

1. seed the authorization projection synchronously before redirect
2. or allow first-use synchronous repair from durable truth

## Tertiary recommendation

If desired, add an on-demand or scheduled repair path as a safety net, but do not confuse that with the primary solution.

## Bottom Line

Given discrete Better Auth calls that may partially succeed, the viable first-principles design is:

> one synchronous bootstrap state machine, owned by the auth-to-app handoff, driven by durable invariants, with read-before-retry after every ambiguous failure.

Anything weaker still leaves a real window where the user is authenticated but the system is unusable.
