---
section: Fixed
audience: internal
---

- The backstop grace-retry cases own their follow-up sweep instead of racing its wall-clock timer (#4488, recurrence of #2669). A `graceRetryScheduler` seam hands a case the retry options production composed, so a loaded runner can no longer fail "grace retry did not complete" and leak a 5 ms sweep into the next case. The `onComplete` seam now fires after the sweep's `finally` released the backstop lock, so a case that awaits it no longer ends with the release still in flight (#4581 review, thread 4303835287).
