Review the story the developer just finished.

1. Read the story, the dev record and the architecture.
2. For each acceptance criterion, check it against a test or the running code. Record met or not met, with the evidence.
3. Read every changed file the dev record lists. Check it against the architecture's interfaces, data shapes and decisions.
4. Record each finding with a severity (high, medium, low), a file reference and the fix.
5. Decide the verdict: `fail` if any criterion is not met or any finding is high; `concerns` if only medium or low findings remain; `pass` otherwise.
6. Set the outcome to the verdict, answer the checklist, then submit.

Do not change the code yourself.

Done when: every criterion has evidence and the verdict follows from the findings.
