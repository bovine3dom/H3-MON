# TODO

## Loading Feedback

- [ ] Make loading feedback unobtrusive during interactive use.

Keep the map usable and the last result visible while a request runs. Use a small,
delayed indicator for interactive reloads rather than the prominent loading bar.
Reserve detailed progress for initial loads when it genuinely helps.

- Rapid clicks and pans do not cause flashing overlays or layout shifts.
- Loading feedback does not cover the data or compete with map interaction.
- Slow requests and failures remain discoverable, with useful, accessible status text.

## Settings Pane

- [ ] Restyle and rewrite the settings pane to match the other minimalist panes.

Follow the existing panes' typography, spacing, borders and controls rather than
introducing a separate dashboard-like design. Every element shown must help the
user; every word must be directly useful and meaningful to them.

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
- `onclick` and `onmove` URL templates reference shared parameter values instead of
  duplicating literal values in both URLs.
- Applying changes reruns the request for the last queried origin; no extra map
  click, JSON edit or page reload is required.
- Display travel time in user-friendly units and validate values before requesting.
- Coalesce edits or provide an explicit apply action to avoid flooding the backend.
- Keep overrides shareable in the page URL, consistent with existing settings.

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

- Keep the configured endpoint request active when default highlighting is disabled.
- Apply the option to both geographic-map and cartogram clicks.
- Resolve the request's origin from linked H3 data even when no highlight is drawn.
- Preserve existing default click behavior when the option is absent.
