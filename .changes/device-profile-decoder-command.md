---
"lissio": minor:removed
---

Device profiles now carry both directions of the graph. A Decoder canvas node
selects a saved profile/interface and exposes every declared channel as a live
named port: numeric channels are F32, string channels are String, and bytes
channels are uppercase HEX String. The runtime caches non-numeric samples from
`EngineOutput::Sample`, so structured fields update the value plane instead of
being preview-only.

The Command widget is no longer a manual frame/block assembler. It selects a
profile operation, carries a `StructuredValue` request, and binds scalar request
fields to F32 input ports; `encode_profile_operation` compiles the same profile
engine and returns the codec bytes for preview. Bytes enter the graph through
`inject_bytes` on the widget's `loopbackOut` route, so the encoder never writes a
device directly; a connected field takes the graph value and an unconnected field
keeps its form constant. The loopback comparison parses the same bytes with
`capture_bytes` instead of sending them a second time. Each command entry
has its own `sendMode` (`manual` / `onChange` / `timer`) and `timerMs`; automatic
entries are encoded by the background command ticker while the workspace runs,
and manual sending is enabled whenever its acquisition target is connected. The
old `CommandFrame`/`CommandBlock` vocabulary, block editor, local parser, and
checksum helpers are removed.

The Decoder selects only a profile: it consumes bytes from its graph input and
the compiler uses the interface the profile itself declares, so a graph decoder
never reads a device. A profile/decoder node with no selected profile is no
longer a graph-wide error: runtime state construction skips that node and node
descriptions report the missing parameter as an incomplete-node issue.
