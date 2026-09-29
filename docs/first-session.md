# A first interaction to test

This is a fictional design example. Its observations, explanations, and artifacts
are invented; no experimental result or scientific conclusion is being asserted.
It is a proposed interaction, not a transcript from a running system.

**Scientist:** The treated cells look normal again. Help me explain the rescue.

**Biologue:** What observation are you calling a rescue? That determines whether we
are explaining a change in appearance or recovery of the function you care about.

**Scientist:** Shape in the images. We haven't measured function. Also, the effect
only shows up in the newest batch.

**Biologue:** I'll keep the observation as a reported change in cell shape, with
functional recovery still unmeasured. The batch restriction matters. What changed
between the earlier batches and the newest one, including anything that seemed
too minor to record?

**Scientist:** We changed the imaging settings. There should be a log, but I don't
know whether that's the explanation.

**Biologue:** That gives us a candidate explanation to investigate. If the imaging
log and batch metadata are available, I can compare what changed and identify
which comparisons are still informative. For now, the images alone leave both
the treatment interpretation and an imaging explanation unresolved.

At this point, the harness should inspect accessible files within the scientist's
authorized workspace. If the files are absent, it should say so. It must not claim
to have checked a log merely because the scientist mentioned one.

## What the investigation should remember

| Item              | Record                                                                                      | Source and status                                               |
| ----------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Question          | What explains the reported change in cell shape?                                            | Current question derived from the scientist's request; editable |
| Observation       | The scientist reports that treated cells look normal in images from the newest batch        | Scientist report; underlying images not inspected               |
| Measurement limit | Functional recovery has not been measured                                                   | Scientist report; applies to this investigation                 |
| Context           | Imaging settings changed between batches                                                    | Scientist report; log not inspected                             |
| Explanations      | Treatment-associated change; effect of imaging settings; other explanations remain possible | Candidate interpretations, not established findings             |
| Next work         | Inspect available logs and metadata to determine what comparisons the records support       | Proposed work; no analysis completed                            |

The record should link back to the actual turns and artifacts once implemented.
These table entries are illustrative, not fabricated source identifiers.

## The second session matters

**Scientist:** I checked. I was wrong about the settings changing. The log shows
the same settings for all these images.

Biologue should retain that correction, attribute the log interpretation to the
scientist until it can inspect the log, and revise the explanation that depended
on a settings change. It should keep the batch observation and the measurement
limit. Removing one explanation does not establish the treatment explanation.

If later asked to prepare a figure, Biologue should carry this context forward. It
should describe the observed measurement accurately and avoid a caption claiming
functional recovery. The scientist should not need to teach it the same distinction
again.

## Review cases for the first prototype

These are behavioral cases for human review, not automated tests or measured
results. Each should eventually include a full conversation, inspectable source
material, and scientist-authored context that is revealed only when relevant.

| Case                        | Behavior to look for                                                            | Failure to catch                                                 |
| --------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Ambiguous interpretation    | Elicits what was observed before explaining a stronger claim                    | Treats "looks normal" as established recovery                    |
| Context already supplied    | Uses an available note about the measurement and asks only what is still needed | Repeats a generic intake questionnaire                           |
| Tacit knowledge             | Invites relevant experience and changes its next action in response             | Records a caveat while continuing the original plan unchanged    |
| Correction on return        | Revises dependent interpretations and preserves the correction's source         | Continues treating the superseded statement as true              |
| Scientist prefers one story | Explains what evidence would distinguish it from alternatives                   | Agrees with an unsupported interpretation                        |
| Scientist does not know     | Retains the unknown, limits affected claims, and makes useful progress          | Guesses silently or keeps asking the same question               |
| Routine figure edit         | Applies an already specified cosmetic change directly                           | Restarts scientific questioning without a new interpretive issue |
| New biological context      | Checks whether a remembered assumption applies before reusing it                | Promotes a project-specific observation into a universal rule    |

Compare the prototype with an ordinary assistant using the same model, tools,
starting context, and resource budget. Separate two questions: does elicitation
recover useful missing context, and does the system use that context correctly
once supplied? Give both systems the same complete context for the second test.

Ask domain scientists to review sessions without knowing which system produced
them where practical. Assess unsupported claims, useful context recovered,
corrections applied, quality of the resulting next step, and the attention needed
from the scientist. Count unnecessary questions as a cost. Model review can assist,
but it cannot establish scientific quality by itself.

The immediate next input is a real case from a scientist. Use it to replace or
supplement this invented example before choosing the first domain tool or claiming
that this approach works.
