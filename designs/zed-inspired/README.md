# Biologue, inspired by Zed

[Open the full-size mockup](biologue-zed-light.png).

A light-mode visual direction that retains the existing conversation, editor,
console, research context, objects, and figure arrangement. The generated concept
has now been translated into the workbench, using Zed itself as the reference.
The [implemented workbench screenshot](implemented-workbench.png) shows the actual
browser UI with real Python output from the synthetic example project. See the
[implementation and visual review](../../docs/ui-review.md) for coverage.

## Concept design choices

- Continuous warm-gray surfaces and fine dividers make the panes feel like one
  workspace. Pane headers, tabs, and typography stay compact.
- Conversation uses a readable transcript with the composer anchored below it.
  Research context keeps observations and assumptions explicitly labeled.
- Run and Save sit beside the document tabs. File and history navigation move to
  the bottom edge, leaving more horizontal room for the actual work.
- Restrained green indicates actions and selection. The neutral background
  follows the preference established in earlier UI reviews.

The implementation retains visible keyboard focus, labeled navigation, resizable
panes, and existing execution and review behavior. Panel navigation lives in the
bottom bar; Arrange temporarily reveals top tabs for dragging and regrouping.
Usability with scientists still needs human evaluation; scripted UI checks cover
interaction and accessibility.

## Reference and generation

Studied Zed's [official interface imagery](https://zed.dev/img/agentic/posters/explore-poster.webp)
and [visual customization documentation](https://zed.dev/docs/visual-customization).
The mockup is an interpretation of the compact styling and pane treatment.

Generated with the built-in image-generation tool. The complete
[generation prompt](prompt.txt) is retained. Image text, controls, code, and data
are illustrative; this does not demonstrate functioning interactions or validate
a scientific conclusion.

The [earlier eight directions](../ui-directions/index.html) remain available for
comparison.
