---
"lissio": major:removed
---

The `lissio-schema` block-schema engine and the `lissio-frame-decoder` state
machine are removed from the workspace. Device profiles replaced both: a profile
document compiles to a `FrameLayout` that the profile engine interprets, so the
separate schema engine and the standalone decoder that mirrored the frontend
block list have no remaining caller.

Custom decoding and encoding that used the block protocol must be expressed as a
device profile. No reader for a stored block schema is provided.
