# Biologue: eight product directions

These are visual mockups for comparison, not implemented interfaces. The current
workbench is unchanged. Each image preserves conversation left, script and console
center, and research context and results right. The concepts vary the pane
surfaces, type hierarchy, navigation, and placement of actions.

[Open the comparison gallery](index.html). Click an image to enlarge it; use the
arrow keys to compare neighboring concepts. PNGs can also be opened directly.

| Direction                          | Pane and navigation treatment                          | Placement of actions                           | Design intent and tradeoff                                                                              |
| ---------------------------------- | ------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [01 Journal](01-journal.png)       | Top text navigation; borderless columns                | Run below the code; inline Save and Inspect    | Makes discussion and interpretation feel like the main work. Serif-heavy; needs careful density tuning. |
| [02 Instrument](02-instrument.png) | Numbered work areas; precise square frames             | One prominent control strip beneath the script | Practical and precise. Strongest utility direction, though more conventional than the others.           |
| [03 Atelier](03-atelier.png)       | Large in-content headings; no global toolbar           | Vertical action shelf beside the script        | Quiet creative-tool identity. Side actions need testing at compact sizes.                               |
| [04 Commons](04-commons.png)       | Independent work cards; bottom navigation dock         | Actions live inside the relevant card          | Emphasizes working together. Cards and the bottom dock use more space.                                  |
| [05 Prism](05-prism.png)           | Tinted surfaces; central workspace switcher            | Attached action capsule below the script       | Contemporary and approachable. Needs restrained color to remain a serious scientific tool.              |
| [06 Ledger](06-ledger.png)         | Continuous ruled grid; strong type and section numbers | Flat text actions and a single red Run control | Very distinct and information-focused. Strong visual rules may feel severe over long sessions.          |
| [07 Fieldbook](07-fieldbook.png)   | Aligned sheets; labeled tabs at the right edge         | Actions in document footers and list captions  | Connects the workspace to research notes. Keep the paper metaphor subtle.                               |
| [08 Nocturne](08-nocturne.png)     | Borderless dark regions; central text navigation       | Amber action shelf beneath the script          | An evening-mode experiment. The first seven better match the preference for light backgrounds.          |

Generated using the built-in image-generation tool, with one independent prompt per
concept. The exact [prompt set](prompts.json) is retained. Text, code, data, version
numbers, and controls inside the images are illustrative. Pixel-level UI behavior
and scientific correctness cannot be inferred from these static concepts.

Images are saved alongside this file as `01-journal.png` through `08-nocturne.png`.
