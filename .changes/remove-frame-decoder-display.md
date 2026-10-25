---
"lissio": minor:removed
---

The frame-decoder display panel and its canvas widget are gone. Custom decoding is served only by device profiles, so the panel, its manual parse surface, the widget registration, the panel catalog entry, and the raw-data node-bypass channel that only that widget used were all removed. Logic-analyzer decoded events still reach the UI through the logic analyzer subscription, and the MCP tool keeps the combined samples-plus-events read.
