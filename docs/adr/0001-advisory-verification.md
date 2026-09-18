# Verification is advisory; submission is authoritative

Warehouse inventory may change between verification and submission. Verification therefore returns an estimate without reserving stock, and submission recalculates using current inventory while accepting the order and consuming stock atomically, matching the challenge's requirement for submission-time amounts without introducing a reservation lifecycle. A previously valid estimate can consequently become more expensive or invalid at submission.
