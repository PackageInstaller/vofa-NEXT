---
"lissio": minor:added
---

Structured samples now carry the exact decoded value before channel scaling whenever a binding applies a non-identity scale or offset, so a consumer can recover the raw measurement the scaled value came from.
