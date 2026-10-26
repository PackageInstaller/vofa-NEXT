---
"lissio": minor:added
---

Added a device-profile workspace that lists, edits, validates, previews, and
saves custom frame and message profiles. Frame profiles support length-prefixed
byte payloads end to end, and length-normalized layouts now reject ambiguous
conditional, bitfield, prepended-checksum, and non-sequential shapes instead of
decoding them incorrectly. Preview reports numeric frames and structured
samples, and the protocol node can select a saved profile and its interface.
