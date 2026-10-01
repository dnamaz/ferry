# ferry

A terminal API client for **gRPC and REST** in the spirit of Postman, built with [Ink](https://github.com/vadimdemedes/ink). Everything stays on your machine.

- **gRPC**: discover services via server reflection (v1 and v1alpha), `.proto` files or protosets; call unary, server-, client- and bidi-streaming methods with live output, headers, trailers, status and timing.
- **REST / HTTP**: any method, `:path` variables, query params, headers, JSON/text/XML/form/multipart/file/GraphQL bodies, bearer/basic/API-key/OAuth2-token auth, redirects, timeouts, live streaming (SSE) and binary downloads.
- **Collections**: folders, requests, variables, auth and header inheritance, environments, tabs, and request chaining (pick a value from one response and use it in another).
- **Import**: Postman v2.1 JSON, Postman v3 YAML, Bruno `.bru` and Bruno OpenCollection YAML (with gRPC). **Export**: Postman v3 YAML and v2.1 JSON.
- **Scriptable CLI** for listing, describing, calling, running saved requests and printing `curl`/`grpcurl` equivalents.

```
 ◆ ferry  env Local · Say hello  localhost:50051/demo.greeter.v1.Greeter/SayHello        ? help
╭──────────────────────────────╮╭───────────────────────────────────────────────────────────────╮
│ 1 Collections   2 Services   ││ Request Demo API › Greeter                                    │
│──────────────────────────────││   Name      Say hello                                         │
│▾ Demo API                    ││ › URL       {{host}}  → localhost:50051                       │
│  ▾ Greeter                   ││   Method    /demo.greeter.v1.Greeter/SayHello [unary]         │
│    ◆ Say hello               ││   Metadata  x-request-id                                      │
│    ◆ Stream greetings        ││   Auth      inherit → none                                    │
│    ◆ Collect names           ││   Settings  plaintext · reflection (collection)               │
│    ◆ Chat                    ││ ───────────────────────────────────────────────────────────── │
│  ▸ Inventory 4               ││   Message   HelloRequest ✓                                    │
│  ▸ REST health 1             ││   1 {                                                         │
│                              ││   2   "name": "{{user}}",                                     │
│                              ││   3   "language": "LANGUAGE_FRENCH"                           │
│                              ││   4 }                                                         │
│                              │╰───────────────────────────────────────────────────────────────╯
│                              │╭───────────────────────────────────────────────────────────────╮
│                              ││ Response Messages │ Metadata (3)                              │
│                              ││ ● OK (0) · 32 ms · 1 msg                                      │
│                              ││ {                                                             │
│                              ││   "message": "Bonjour, Ada!",                                 │
│                              ││   "sentAt": "2026-09-25T06:41:01.975Z"                        │
│                              ││ }                                                             │
╰──────────────────────────────╯╰───────────────────────────────────────────────────────────────╯
 tab: focus · enter: edit · t: template · o: $EDITOR · ctrl+r: send · ctrl+s: save · e: env
```

## Quick start

Requires Node 20+.

```bash
npm install
npm run build

# terminal 1: demo servers — gRPC with reflection on localhost:50051, REST on localhost:8089
npm run demo-server

# terminal 2: import the sample collection, pick the environment, open the UI
node dist/cli.js import examples
node dist/cli.js env Local
node dist/cli.js
```

Use `npm link` to put `ferry` (alias `fy`) on your PATH. `npm run dev` runs from source without building.

## The UI

Three panes: the **sidebar** (Collections / Services tabs), the **request** editor and the **response** viewer. Tab cycles focus, and `?` shows every shortcut.

| Key | Action |
| --- | --- |
| `ctrl+r` | send the request (works while editing) |
| `ctrl+s` | save; scratch requests ask which collection or folder to save into |
| `ctrl+c` | cancel a running call, close a modal, or quit |
| `1` / `2` | Collections / Services tab |
| `e` | environments: switch, create, edit variables, mark secrets |
| `N` | new scratch request |
| `R` | re-run discovery for the current target |
| `i` | import Postman v3 YAML |
| `L` | toggle layout: request above response, or side by side (remembered) |
| `B` | hide/show the sidebar for more room (remembered) |
| `C` | show the request as a runnable `curl` / `grpcurl` command; `y` copies it |
| `p` | preview what will be sent: every header/metadata entry with its source, TLS material, target (`v` reveals secrets) |
| `P` | per-host certificates (client certs and CAs for mTLS) |

**Tabs.** Opening a request from the sidebar (or `N` for a scratch request) opens it in a tab. Each tab keeps its own unsaved draft, response and scroll position, and a call can keep running in a background tab while you work in another; the tab shows a spinner, then a green or red dot. Open tabs are restored the next time you start (scratch tabs aren't).

| Key | Action |
| --- | --- |
| `[` / `]` | previous / next tab |
| `T` | fuzzy-searchable list of open tabs |
| `{` / `}` | move the current tab left / right |
| `alt+1`…`alt+9` | jump to tab N (terminals that send Alt as Meta) |
| `w` / `W` | close the tab / close all other tabs (asks if there are unsaved changes) |

**Collections tab**: `n` new request · `f` folder · `c` collection · `r` rename · `d` delete · `y` duplicate · `K`/`J` reorder · `v` variables · `s` collection settings (schema source, TLS files) · `a` collection auth · `x` export.

**Services tab** lists what the current request's target exposes. `enter` puts the method on the current request and fills in an example message. `d` shows the proto definition, and `a` adds the method to a collection as a new request.

**Request pane**: arrow keys pick a field and `enter` edits it. Name and URL edit inline. Method opens a fuzzy picker. Metadata opens a table editor, and Auth and Settings open forms. Message opens an inline JSON editor: `esc` to finish, `ctrl+f` to format, auto-indent. You can also press `o` to edit the message in `$VISUAL`/`$EDITOR`, `t` to generate a template from the schema, or `f` to format.

**Response pane**: scroll with arrows, `pgup`/`pgdn` and `g`/`G`. `m` toggles between messages and headers/trailers, and `y` copies to the clipboard.

In modals, `esc` saves and closes; `ctrl+c` discards.

### Requests

| Field | Notes |
| --- | --- |
| URL | `host:port`, `grpc://host:port`, or `grpcs://host` (TLS, port 443 by default). Supports `{{variables}}`. |
| Method | `/pkg.Service/Method`; `pkg.Service/Method` and `pkg.Service.Method` are also accepted. |
| Message | Proto3 canonical JSON: camelCase or original field names, enums by name or number, int64 as strings, `Timestamp`/`Duration`/`FieldMask`/wrappers/`Struct`/`Any` in their JSON forms. Unknown fields are rejected before sending. For **client and bidi streaming**, use a JSON array: each element is sent as one message, then the stream is half-closed. |
| Metadata | Key/value pairs. Keys ending in `-bin` take base64 values. |
| Auth | `inherit` (nearest folder/collection), `noauth`, `bearer`, `basic`, `apikey`. Converted to metadata; explicit metadata wins. |
| Settings | TLS on/off, certificate verification, CA/client cert/key files, schema source, emit default fields, connect timeout, max response size. |

### HTTP requests

| Field | Notes |
| --- | --- |
| Method | `enter` picks GET, POST, PUT, PATCH, DELETE, HEAD or OPTIONS. |
| URL | `{{vars}}` and `:name` path segments. Typing `?a=1&b=2` moves those into **Params**; a missing scheme means `http://`. |
| Params / Path vars | Query parameters (URL-encoded on send, can be disabled) and values for `:name` segments. |
| Headers | Merged with collection and folder headers (Bruno); auth adds `Authorization` unless you set it yourself. |
| Auth | `inherit`, `noauth`, `bearer`, `basic`, `apikey` (header or query parameter), `oauth2` (sends the access token). |
| Body | `none`, JSON, text, XML, HTML, JavaScript, form-urlencoded, multipart (a value starting with `@` sends that file), binary file, GraphQL (query + variables). `enter` on **Content** edits text bodies; `o` opens `$EDITOR`. |
| Settings | Follow redirects (and max), verify TLS certificates, timeout. |

Responses show status, time, size and content type, a **Body** tab (JSON with selectable values, text, or a binary notice) and a **Headers** tab. Streamed bodies such as `text/event-stream` appear as they arrive. In the response pane, `s` saves the body to a file (named from `Content-Disposition` when present) and `C` in any pane shows the request as `curl`.

### Chaining requests (List → Get)

Press `enter` in the response pane to **select a value**: `↑↓` moves between values, and the status line shows the path, e.g. `[0].addressId = 01a0…`. Then:

| Key | Action |
| --- | --- |
| `u` (or `enter` → *Use in another request*) | write the value into a field of another open tab. The best-matching field is preselected (`addressId` → `address_id`), then it switches to that tab so you can `ctrl+r`. |
| `v` (or `enter` → *Save as {{var}}*) | store it as a variable in the active environment (or the collection if no environment is active), then use `"address_id": "{{addressId}}"` anywhere |
| `enter` → *Capture* | same, and refresh it after every successful call. It's stored on the request's **Captures** field as `{{addressId}} ← [0].addressId`; edit it there. |
| `y` | copy the value |

Paths are `[message index].field.path`, e.g. `[0].items[2].sku`; streaming responses have one index per message. `ferry run` applies captures too, so `run ".../ListAddresses"` followed by `run ".../GetAddress"` chains from scripts. Captures are exported as Postman after-response scripts (`pm.environment.set("addressId", pm.response.messages.idx(0).data.addressId);`) and scripts of that exact shape are imported back as captures.

### Scripts (e.g. log in once, then every call is authorized)

Requests have a **Scripts** field: pre-request and post-response scripts in **JavaScript or TypeScript** (types are stripped by Node's built-in type stripping, Node 22.13+). `enter` on Scripts picks one to edit in `$VISUAL`/`$EDITOR` (a `.ts` file, with a commented example); emptying it deletes it. Collection and folder scripts run too (collection → folders → request), as in Postman.

A typical token request stores the token, and every gRPC call sends it through metadata `authorization: Bearer {{accessToken}}`:

```js
// "Get token" → post-response. Bruno style:
const body = res.getBody();
if (!body?.access_token) throw new Error('No token: ' + JSON.stringify(body));
bru.setEnvVar('accessToken', body.access_token);

// or Postman style:
pm.environment.set('accessToken', pm.response.json().access_token);
```

Send it (`ctrl+r`, or `ferry run "My API/Auth/Get token"`) and `{{accessToken}}` is saved to the active environment (else the collection), keeping its **secret** flag. It's written to the environment file, so it survives restarts and later `ferry run`s.

| API | Available |
| --- | --- |
| Postman | `pm.environment` / `pm.collectionVariables` / `pm.globals` (`get`, `set`, `unset`, `has`, `replaceIn`), `pm.variables` (values for this send only, e.g. from a pre-request script), `pm.response.json()` / `.text()` / `.code` / `.status` / `.headers.get()` / `.responseTime` / `.to.have.status()`, gRPC `pm.response.messages.idx(n).data` / `.count()` / `.metadata` / `.trailers`, `pm.request`, `pm.info`, `pm.test`, `pm.expect` |
| Bruno | `bru.setEnvVar` / `getEnvVar` / `setVar` / `getVar` / `deleteVar` / `getCollectionVar` / `getEnvName` / `getProcessEnv` / `interpolate` / `sleep`, `res.getBody()` / `res.body` / `res.getStatus()` / `res.getHeader()` / `res.getResponseTime()` / `res('path.to.value')`, `req.getUrl()` / `getMethod()` / `getHeader()`, `test`, `expect` |
| Also | `console.log` (shown under **Metadata**/**Headers** in the response pane, `m`), `await`, `crypto`, `Buffer`, `atob`/`btoa`, `URL`, and `require()` of `crypto`, `buffer`, `url`, `querystring`, `util`, `path` |

For gRPC, `res.getBody()` / `pm.response.json()` return the response message (an array for streams). Bruno's session-only `bru.setVar` is stored in the environment so chaining works across runs. Not supported: `pm.sendRequest`, changing the request's headers from a script (use `{{vars}}` in headers instead), and chai's full `expect` (the common assertions are there: `equal`, `eql`, `include`, `property`, `a`/`an`, `ok`, `above`/`below`, `lengthOf`, `match`, `not`, …).

A failing pre-request script stops the request. Post-response scripts run for every response that has a status (including HTTP 4xx/5xx and non-OK gRPC statuses); errors and failed tests show at the top of the response and in the status line. Scripts get a 10-second timeout per script.

> **Scripts are code.** They run in a separate V8 context, which isn't a security sandbox: a script can do what you can. Imported collections' scripts now run on send, so only send requests from collections you trust. `ferry run --no-scripts` skips them.

### TLS, auth and headers

**TLS.** gRPC turns TLS on with `grpcs://` or Settings → TLS; HTTP uses it for `https://`. For both you can set a **CA certificate** (to trust a private CA), a **client certificate + key** (PEM) or a **PKCS#12 bundle** (`.p12`/`.pfx`) for mTLS, and a **passphrase** (`{{var}}` works). Certificate verification can be turned off per request. gRPC also has a **server name** override that sets the TLS name and `:authority` independently of the address — for tunnels, port-forwards and proxies (e.g. connect to `localhost:9443` but verify `svc.internal`).

TLS material layers: **per-host rule** (`P`, or `ferry cert add`) < **collection** (`s` on a collection) < **request** (Settings). Host rules match `host`, `host:port` or `*.domain`; the most specific wins. TLS failures are explained ("the server's certificate isn't trusted: set a CA…", "the certificate is for a different name: set a server name override", "the server wants a client certificate").

**Authorization** (per request, or inherited from folders/collections with `a` in the sidebar):

| Type | Sent as |
| --- | --- |
| bearer | `Authorization: Bearer <token>`; a token saved with the `Bearer ` prefix isn't doubled, and an empty token sends nothing (with a warning) |
| basic | `Authorization: Basic …` |
| API key | a header (gRPC metadata) or, for HTTP, a query parameter |
| OAuth 2.0, client credentials | ferry POSTs `grant_type=client_credentials` (client id/secret in the body or as Basic, optional scope and audience) to the token URL, **caches the token until it expires** (`~/.ferry/tokens.json`, mode 600) and sends `Authorization: Bearer <token>` — for HTTP and gRPC. `ferry token clear` forces a new one. |
| OAuth 2.0, access token | a token you paste (or `{{accessToken}}`) |

OAuth2 settings use Postman's names, so they import from and export to Postman v2.1/v3, and Bruno's `auth:oauth2` blocks import too.

**Headers.** `H` on a collection or folder edits headers that every request inside inherits — as HTTP headers and as gRPC metadata (keys lowercased); a request's own header with the same name wins, and an explicit `Authorization` header wins over auth. `p` shows the final list with where each entry comes from (request, folder, collection, auth — including which level it's inherited from — or defaults like `User-Agent`, `Content-Type`, `:authority`).

### Variables

`{{name}}` works in the URL, method, metadata, auth, message and proto paths. Resolution order is **environment > folder > collection**, and the nearest scope wins. Dynamic values: `{{$guid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`. Unresolved names are flagged when you send.

### Schema sources

By default the schema comes from **server reflection** at the request URL. To use `.proto` files instead, set Settings → Schema source (per request) or `s` on a collection (collection default):

- **.proto files**: comma-separated files plus import paths. Relative paths resolve against the imported collection's folder, else the current directory.
- **protoset**: a `FileDescriptorSet` from `buf build -o api.binpb` or `protoc --include_imports -o api.binpb`.

Descriptors from protobufjs-based servers (e.g. `@grpc/reflection`) are repaired automatically. Those servers emit relative type names, per-package synthetic files with no imports, and missing well-known types, which stricter tools reject. For example, `grpcurl` fails against the bundled demo server, but this client works.

## Import and export

`import` (or `i` in the UI) detects the format:

| Format | Point it at |
| --- | --- |
| Postman v3 YAML | a repo with `postman/collections/`, a collection folder, `*.request.yaml`, `*.environment.yaml` |
| Postman v2.1 / v2.0 JSON | `*.postman_collection.json`, `*.postman_environment.json` |
| Bruno `.bru` | a folder with `bruno.json` (environments from `environments/*.bru`) |
| Bruno OpenCollection YAML | a folder with `opencollection.yml` (HTTP and gRPC requests; environments from `environments/*.yml`) |
| Bruno environment JSON | `{ "name", "variables": [...] }` |
| Any other folder | scanned up to three levels deep and everything above is imported |

When one folder holds the same collection in several formats (e.g. Postman JSON plus a Bruno copy), the duplicates are labelled `(Postman v2)`, `(Bruno)`, …; identical environments are imported once. After an import, the environment that defines the collection's `{{variables}}` is activated.

Post-response scripts that just store a response value become **captures**: `pm.environment.set("t", pm.response.json().access_token)`, the `var t = pm.response.json()…; pm.environment.set("t", t)` idiom, Bruno's `bru.setEnvVar("t", res.body.x)` and `vars:post-response { t: res.body.access_token }`. Other scripts are kept, exported and **run** (see [Scripts](#scripts-eg-log-in-once-then-every-call-is-authorized)).

```bash
ferry import ./my-repo                          # postman/collections + postman/environments
ferry import ./postman/My.postman_collection.json
ferry import ./bruno/Project-Picnic             # Bruno .bru
ferry import "./docs/bruno/STF gRPC"            # Bruno YAML

ferry export "My API" ./my-repo --with-environments [--replace] [--include-secrets]     # Postman v3 YAML
ferry export "My API" ./out --format postman-v2 --with-environments                     # Postman v2.1 JSON (HTTP only)
```

### Postman v3 details

- `grpc-request` files map directly: `url`, `methodPath`, `methodDescriptor` (kept as-is), `message.content`, `metadata`, `auth`, `settings`, `scripts` and `order`. Folder and collection `definition.yaml` files provide names, descriptions, `variables`, `auth` and ordering.
- `http-request` files map to HTTP requests (`method`, `url`, `headers`, `queryParams`, `pathVariables`, `body`, `auth`, `settings`, `scripts`).
- **Other request kinds** (GraphQL, WebSocket, MQTT, …) are shown greyed out and written back unchanged on export, so a mixed collection round-trips.
- **Re-importing** replaces collections and environments with the same name, keeping their local ids and schema settings. Importing a git checkout again updates it in place.
- **Export** follows the v3 file rules: single-quoted `{{vars}}` and special characters, `|-` blocks for multi-line JSON, sanitized unique filenames, and `name:` written only when it differs from the filename.
- **`--replace`** removes an existing export of that collection first, so deleted requests don't linger (the UI asks first).
- **Secret environment values** (`type: secret`) are written as empty strings unless you pass `--include-secrets`, because exports usually get committed to git.
- **Not exported:** gRPC schema source, TLS file paths and HTTP timeouts are local-only; they aren't part of the Postman format.
- **v2.1 export** writes HTTP requests only (v2.1 has no gRPC type; skipped requests are listed), including saved examples that came from a v2.1 import.

## Scriptable CLI

```bash
ferry list localhost:50051                                     # services and methods
ferry describe localhost:50051 demo.greeter.v1.Greeter/SayHello
ferry describe localhost:50051 demo.greeter.v1.Greeter/SayHello --template
ferry call localhost:50051 demo.greeter.v1.Greeter/SayHello -d '{"name":"Ada"}' -v
ferry call localhost:50051 demo.greeter.v1.Greeter/Chat -d @messages.json
ferry call api.example.com:443 pkg.Svc/Method --tls -H 'authorization: Bearer ...' -d -
ferry call localhost:50051 pkg.Svc/Method --proto api.proto -I ./protos

ferry ls                                    # collections, requests, environments
ferry env Staging                           # set the active environment ("none" to clear)
ferry env ./postman/environments/Staging    # or import an *.environment.yaml and activate it
ferry run "Demo API/Inventory/Get item" -e Local -v
ferry run "Demo API/Notes (REST)/Get token"                      # HTTP; runs scripts and captures ({{token}})
ferry run "Demo API/Notes (REST)/Get token" --no-scripts         # skip pre-request / post-response scripts
ferry run "Demo API/Notes (REST)/Download report" -o report.pdf  # write the body to a file
ferry curl "Demo API/Notes (REST)/Echo form"                     # equivalent curl (grpcurl for gRPC)
ferry preview "Demo API/Notes (REST)/List notes" [--reveal]      # final headers/metadata with sources, TLS, target

ferry cert add "*.symmetrydev.com" --ca ./ca.pem --cert ./me.pem --key ./me.key   # or --pfx me.p12 --passphrase '{{p12pass}}'
ferry cert ls
ferry cert rm "*.symmetrydev.com"
ferry token clear                                                # drop cached OAuth2 tokens
```

Responses print as JSON to stdout (streamed gRPC messages print as they arrive; HTTP JSON bodies are pretty-printed, text is printed as-is), and diagnostics go to stderr. The exit code is the gRPC status code on a non-OK gRPC status, and 1 for HTTP 4xx/5xx or when a script throws or a test fails. Script output (`console.log`, variables set, tests) goes to stderr.

## Data

Collections and environments are stored as JSON under `~/.ferry/` (override with `--home` or `FERRY_HOME`). Data from the app's earlier name, `~/.grpc-client/`, is moved there automatically the first time you run `ferry`. This is plain local storage: environment values, certificate passphrases (`settings.json`) and cached OAuth2 tokens (`tokens.json`, mode 600) are not encrypted, so prefer `{{variables}}` over hard-coding secrets in collections you export.

## Development

```bash
npm run dev          # run the UI from source (tsx)
npm run typecheck
npm test             # vitest: core, Postman v3 round-trip, and gRPC integration tests against the demo server
npm run demo-server  # PORT=6000 npm run demo-server to change the port
```

```
src/
  cli.tsx               commander entry: UI (default) + subcommands
  core/
    model.ts            collection/request/environment model (mirrors v3 grpc-request)
    postman-v3.ts       v3 YAML import/export
    workspace.ts        on-disk store + mutations
    resolve.ts          variables, auth inheritance, effective settings
    vars.ts             {{var}} resolution
    scripts.ts          pre-request / post-response scripts (pm.*, bru.*, JS or TS)
  grpc/
    reflection.ts       server reflection client (v1 → v1alpha fallback)
    proto-files.ts      .proto and protoset loading
    schema.ts           descriptor repair, registry, templates, describe
    discovery.ts        cached schema loading per target
    invoke.ts           unary/streaming calls with proto3 JSON mapping
    connection.ts       URL parsing, credentials, metadata
  ui/
    App.tsx             state, key routing, modals
    components/         Sidebar, RequestPanel, ResponsePanel, TextEditor, TextField, Modals, EnvManager
examples/
  protos/               demo service definitions
  server/server.ts      demo server (reflection enabled; Inventory needs "Bearer demo-token")
  postman/              sample v3 collection + environment
```
