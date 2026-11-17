Implement the story in the repository.

1. Read the story. It is your only source of truth.
2. If a QA gate for this same story is included, it failed: fix each of its findings first, and record them under "QA findings addressed".
3. For each task, in order: write the test for its acceptance criteria, then the code that makes it pass.
4. Run the full test suite. Fix anything you broke.
5. Commit the code with a message that starts with the story ID.
6. Write the dev record: tasks (done or not, with reasons), every file changed, the test command and result, the commit.
7. Answer the checklist, then submit.

Stop and ask with a `[NEEDS CLARIFICATION: ...]` marker instead of guessing when the story is contradictory or needs work outside its scope.

Done when: every task is done or explained, the full suite passes, and the code is committed.
