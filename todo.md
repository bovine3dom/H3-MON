# TODO

## Loading Feedback

- [ ] Make loading feedback unobtrusive during interactive use.

Keep the map usable and the last result visible while a request runs. Use a small,
delayed corner spinner for interactive reloads, without percentages or stage narration.
Reserve detailed progress for initial loads when it genuinely helps.

- Rapid clicks and pans do not cause flashing overlays or layout shifts.
- Loading feedback does not cover the data or compete with map interaction.
- On failure, show a small persistent inline error near the spinner with Retry.
  Make clear that the previous result is still displayed; put technical details
  behind a disclosure. Keep status feedback accessible.

## Settings Pane

- [ ] Restyle and rewrite the settings pane to match the other minimalist panes.

Follow the existing panes' typography, spacing, borders and controls rather than
introducing a separate dashboard-like design. Every element shown must help the
user; every word must be directly useful and meaningful to them.

- Use compact groups with short, useful headings and label/control rows, not cards.
- Remove redundant labels, repeated descriptions and self-referential explanations.
- Remove generic copy such as "Enabled" when the labelled control already conveys it.
- Keep labels, units, constraints and error messages needed to make a decision.
- Put genuinely optional explanations behind contextual help rather than repeating
  them throughout the pane.
- Preserve keyboard access, accessible names and usable mobile controls. Minimalism
  must not make controls ambiguous or harder to use.

## Metadata-Defined Controls

- [ ] Let datasets declare editable request parameters in JSON metadata.

Render these controls in the settings pane without hardcoding routing-specific
settings into H3-MON. Start with maximum travel time and departure time.

- Metadata declares each parameter's label, type, default, units and bounds.
- Keep controls generic: declare a numeric minutes field for travel time and an inline
  JavaScript conversion callback such as `value => value * 60` in metadata.
- Treat metadata callbacks as trusted executable code and update the documentation
  accordingly. Never evaluate control values or URL parameters as code.
- Validate inputs and conversion outputs before requesting; report conversion errors
  and URL-encode the resulting parameter values.
- `onclick` and `onmove` URL templates reference shared parameter values instead of
  duplicating literal values in both URLs.
- Valid edits automatically rerun the request after a short debounce; no Apply button
  for request parameters. Coalesce edits and cancel obsolete requests.
- Reuse the last queried origin. Before the first query, use the current map centre.
  No extra map click, JSON edit or page reload is required.

## Shareable Query State

- [ ] Restore the full query, including the click/origin, from the URL alone.

- Encode the dataset, control input values, queried origin and any click context
  needed for replay. Preserve the resolved H3 chosen for a cartogram click.
- Opening or reloading the URL automatically reruns that query without relying on
  local storage, prior clicks or any other browser-local state.
- Restore the selection and highlights when enabled, but preserve the URL's saved
  camera view. Do not replay click-focusing animations or issue duplicate requests.

## Cartogram Click Requests

- [ ] Trigger metadata-defined `onclick` requests from cartogram clicks too.

- Use a central H3 from the clicked cartogram cell's linked/highlighted H3 set as
  the origin, not coordinates derived from the cartogram's screen position.
- Pick one deterministically when ambiguous; no picker is needed.
- Honor the configured request resolution and reuse the same URL templates,
  parameter values and request cancellation as geographic-map clicks.
- Do not let linked highlighting or camera synchronization duplicate the request.

## Optional Default Click Behavior

- [ ] Let `onclick` metadata disable H3-MON's built-in click-to-highlight/focus actions.

- Use one switch for all default click effects, covering highlighting and camera
  focusing together. Do not add separate switches or a replacement origin marker.
- Keep the configured endpoint request active when default highlighting is disabled.
- Apply the option to both geographic-map and cartogram clicks.
- Resolve the request's origin from linked H3 data even when no highlight is drawn.
- Preserve existing default click behavior when the option is absent.
