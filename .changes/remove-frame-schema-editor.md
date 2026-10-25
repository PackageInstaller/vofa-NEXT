---
"lissio": minor:removed
---

A protocol node no longer carries a frame schema. The canvas protocol node keeps only its protocol selection and optional conversion target — the same shape the device tree already persisted — so the frame-schema editor, the decoder/encoder block vocabulary that fed it, and the two crates that defined those blocks are gone.

Practically: custom block protocols are no longer selectable on a canvas protocol node, since custom decoding lives in device profiles. The generated contract drops eleven block types, `ProtocolSchema` leaves the protocol node config, and the protocol config/identity types are now exported from the crates that own them instead of a duplicate definition.
