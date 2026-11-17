Prepare the next story for the developer.

1. Read the latest story and the latest QA gate, if they are included. Update Progress: the last story is done if its gate passed or passed with concerns. If the gate failed, the run would not be here.
2. Pick the first story in PRD order that is not done.
3. If no story is left: fill Story with "None left", list every story as done under Progress, fill the other mandatory sections with "None", set the outcome to `none-left` and submit.
4. Otherwise copy the story's title, user line and acceptance criteria from the PRD, word for word. Number the criteria AC-1, AC-2, ...
5. Break the work into tasks T-1, T-2, ... each mapped to the criteria it serves.
6. In Dev notes, quote the parts of the architecture the developer needs, each with a `[Source: architecture#<section>]` reference. Add any learning from the last QA gate's concerns.
7. Set the outcome to `ready`, answer the checklist, then submit.

Done when: the developer could build the story from this artifact alone.
