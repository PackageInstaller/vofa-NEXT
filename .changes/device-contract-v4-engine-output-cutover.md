---
"lissio": minor:changed
---

Every protocol engine now returns one ordered event stream carrying frames, CAN frames, logic samples, decoded events, structured samples, operation outcomes, and diagnostics. Previews and the data plane consume that stream by event kind, and operation decoding reports a structured outcome.
