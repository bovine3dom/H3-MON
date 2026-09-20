# Control Animation

Add `animate` to a number or time control in metadata. These values supply the
defaults in Settings. They do not start playback.

```json
{
  "controls": {
    "distance": {
      "label": "Distance", "type": "number", "default": 1,
      "animate": {"start": 1, "end": 5, "step": 0.5, "step_rate": 2}
    },
    "departure": {
      "label": "Departure", "type": "time", "default": "23:00",
      "animate": {"start": "23:00", "end": "02:00", "step": 900, "step_rate": 2}
    }
  }
}
```

Use an `onclick` or `onmove` query URL with the control tokens. In Settings,
open Animate to change Start, End, Step, or FPS. Time steps are integer seconds.
Enable the Animation timeline setting to show a labelled, draggable timeline above
the map. Dragging a marker requests and displays that frame. The timeline Play
and Pause buttons control the same player as the buttons in Settings. The setting
is off by default and can be set in metadata or with the `animate` URL parameter.
FPS (`step_rate`) is frames per second. A number step must point toward the end.

Time endpoints use `HH:MM` or `HH:MM:SS`. An earlier end is on the next day.
Extended hours are permitted: `26:00` means 02:00 on the next day. Request values
use hours 00 through 23. Equal endpoints give one frame; use `00:00` to `24:00`
for a full day. Playback includes the exact end and always loops.

Only one control plays at a time. Pause keeps the displayed frame. Active
controls stay visible even if their `showIf` rule is false. If a frame is late,
the map holds the current frame. It does not skip frames to catch up.

The client fetches about two seconds ahead and uses CPU estimates to allow extra time.
Request budgets still apply. Movement stays enabled; changes to query inputs discard old buffered results.

Shared URLs store configuration as `a.<id>` with a JSON object that contains
`start`, `end`, `step`, and `step_rate`. For example, `a.distance` can contain
`{"start":1,"end":5,"step":0.5,"step_rate":2}`. URL-encode the JSON value.
`animation=distance` starts playback when the URL opens. Without `animation`,
playback does not start. `p.<id>` retains the raw displayed value. Playback starts
at the corresponding frame, or at the start if the value is outside the range.
