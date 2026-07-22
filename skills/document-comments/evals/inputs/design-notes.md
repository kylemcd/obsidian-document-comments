# Design notes: search service

## Overview

We are building a service that indexes documents and answers search queries. It
sits behind the existing API gateway and reads from the same document store the
rest of the app uses.

## Caching

To keep query latency low, we plan to <!--c:h4t1-->cache results in memory with a
five-minute expiry<!--/c:h4t1-->. Most queries repeat within a short window, so a
short-lived cache should absorb the bulk of the load without serving stale
results.
<!--co:h4t1 by:priya at:2026-02-10T09:00:00.000Z status:open quote:"cache results in memory with a five-minute expiry"
priya (2026-02-10T09:00:00.000Z): Do we have numbers on the hit rate to justify five minutes?
-->

## Naming

The service is currently called <!--c:m9k3-->QueryEngine<!--/c:m9k3--> in the
code, though the product name is still undecided.
<!--co:m9k3 by:dan at:2026-02-10T09:05:00.000Z status:open quote:"QueryEngine"
dan (2026-02-10T09:05:00.000Z): Can we align this with whatever marketing lands on before launch?
-->

## Open questions

- How do we handle documents the user is not allowed to see?
- What is the reindex strategy when a document changes?
