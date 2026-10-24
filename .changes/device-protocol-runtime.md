---
"lissio": major:removed
---

Persisted graph documents and the runtime now speak one protocol vocabulary: a
protocol node carries `{ protocol, params }` and an optional conversion target,
and engines are built from the protocol registry instead of the node's stored
schema. Workspace files in the previous shape are rejected rather than migrated.

The inline `FrameDecoder` node and its manual decode command are removed;
custom decoding is expressed as device profiles, which the preview path serves.
Command-frame preview, manual command-frame sending, and background automatic
sending are removed with them: a command widget now writes a supported encoded
frame through the ordinary raw-byte send path, and profile operations will carry
device commands when they land.
