# GoogleSketch live rooms

`worker.mjs` runs as the `googlesketch-collab` Cloudflare Worker. Each room uses its own SQLite Durable Object and hibernating WebSockets. `dist/collaboration.js` connects the existing static whiteboard to the service.

Start a session through **Share workspace → Start session**, then copy the student invitation. The creator's teacher credential stays in that browser's local storage; only the student credential goes in the invitation URL fragment. Tokens are sent in the first WebSocket message, rather than query strings, and stored as SHA-256 digests by the service. Room state expires after 24 hours. Ending a session closes its connections and revokes access; local board copies remain available.

Edits use stable object IDs and per-object put/delete operations, so independent teacher and student drawings merge instead of replacing the entire board. Edits to the same object use server arrival order. Remote updates wait until the current drawing gesture finishes. The service enforces student permissions; guests cannot rename a session or add pages. Only completed gestures sync in this first version. Shared PDF, uploaded media, and live cursors are outside this version.

The client reconstructs remote SVG through an element/attribute allowlist. Only allowlisted site origins can call the service. Limits apply to message, object, board and connection sizes. A session link is a bearer invitation; share it only with intended participants.

## Validation

Run `npm install` and `npm test` in the repository root. Integration tests use Miniflare and cover bidirectional changes, concurrent independent objects, permission enforcement, reconnection snapshots, origin rejection, page permissions and ending a session. The pinned local runtime uses its supported 2026-08-06 compatibility date for tests; deployed configuration uses 2026-10-22.

Deploy backend changes with `wrangler deploy --config collaboration/wrangler.jsonc` using the existing Cloudflare account. Publishing `dist/` through the GitHub-backed Cloudflare Pages project updates the public app. The Sites project carries the same frontend assets. Keep their copies in sync.
