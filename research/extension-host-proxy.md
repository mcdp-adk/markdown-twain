# How `fetch` from the VS Code extension host handles proxies

Research for [#4](https://github.com/mcdp-adk/markdown-twain/issues/4), part of [#1](https://github.com/mcdp-adk/markdown-twain/issues/1).

Checked on 2026-09-27 against VS Code 1.139.1 (latest stable), which bundles `@vscode/proxy-agent` 0.45.0, `undici` 7.29.0, Electron 43.6.0 and Node 24.18.0. Source links are pinned to those versions.

## Answer

In the desktop (Electron) extension host, VS Code replaces `globalThis.fetch` before any extension activates. Since **VS Code 1.96** (November 2024) the replacement routes every request through the proxy VS Code resolves, including the OS proxy on Windows (with PAC/WPAD), and adds OS root certificates. Plain global `fetch` therefore works behind the system proxy with **no extension code**.

The extension must:

1. Declare `"engines": { "vscode": "^1.96.0" }` or later. Older hosts send plain `fetch` directly and ignore every proxy.
2. Call the **global** `fetch`. Do not bundle `undici` or `node-fetch`, and do not pass a custom `dispatcher`.
3. Nothing else: no `ProxyAgent`, no `https-proxy-agent`, and no reading of `HTTP(S)_PROXY`.

## How the patch is installed

- `ExtHostExtensionService` awaits `connectProxyResolver(...)`. The source comment says this runs "when extension service exists, but extensions are not being activated yet" ([extHostExtensionService.ts#L178-L181](https://github.com/microsoft/vscode/blob/1.139.1/src/vs/workbench/api/node/extHostExtensionService.ts#L178-L181)).
- `connectProxyResolver` calls `patchGlobalFetch`, which saves the original as `globalThis.__vscodeOriginalFetch`. It then sets `globalThis.fetch` to a wrapper around `proxyAgent.createFetchPatch(...)` ([proxyResolver.ts#L164-L230](https://github.com/microsoft/vscode/blob/1.139.1/src/vs/workbench/api/node/proxyResolver.ts#L164-L230)). The same function also patches `http`, `https`, `net` and `tls`, and `WebSocket`. It also intercepts `require('undici')` through `Module._load` ([proxyResolver.ts#L428-L465](https://github.com/microsoft/vscode/blob/1.139.1/src/vs/workbench/api/node/proxyResolver.ts#L428-L465)).
- `createFetchPatch` ([vscode-proxy-agent index.ts#L758-L811](https://github.com/microsoft/vscode-proxy-agent/blob/v0.45.0/src/index.ts#L758-L811)) handles each call:
  - If `http.fetchAdditionalSupport` is false, or the request uses a `socketPath`, it calls the original `fetch` unchanged.
  - Otherwise it resolves a proxy for the URL. If a proxy is found, it calls the original `fetch` with `dispatcher: new undici.ProxyAgent({ uri: proxyURL, requestTls: { ca }, proxyTls: { ca } })`.
  - If there is no proxy but system certificates are on, it passes a plain `undici.Agent` whose CA list is the system CAs.

## Version history

| VS Code | Global `fetch` behavior in the extension host | Source |
| --- | --- | --- |
| ≤ 1.93 | Not patched. It is Node's built-in `fetch`, which ignores the proxy (only `http`/`https` were patched). | [proxyResolver.ts @1.93.0](https://github.com/microsoft/vscode/blob/1.93.0/src/vs/workbench/api/node/proxyResolver.ts) |
| 1.94–1.95 | Wrapped, but the default path still calls the original `fetch` with no proxy. Only the opt-in `http.electronFetch` (default `false`) routes through Electron `net.fetch`. | [proxyResolver.ts @1.95.0](https://github.com/microsoft/vscode/blob/1.95.0/src/vs/workbench/api/node/proxyResolver.ts) |
| **1.96+** | Proxy and system certificate support is on by default through `http.fetchAdditionalSupport` (default `true`). | [1.96 release notes, "Proxy support for Node.js fetch API"](https://code.visualstudio.com/updates/v1_96#_proxy-support-for-nodejs-fetch-api); [request.ts @1.96.0](https://github.com/microsoft/vscode/blob/1.96.0/src/vs/platform/request/common/request.ts) |

In the 1.96 release notes, the change reads: "The global `fetch` function now comes with proxy support enabled".

## Which proxy is used, and in what order

`useProxySettings` in [vscode-proxy-agent index.ts#L312-L398](https://github.com/microsoft/vscode-proxy-agent/blob/v0.45.0/src/index.ts#L312-L398) decides the proxy per URL, first match wins:

1. **Localhost** (`localhost`, `127.0.0.1`, `::1`) always connects directly.
2. **`http.noProxy`**: if the list is non-empty, it is used and `NO_PROXY` is ignored. Otherwise `no_proxy`/`NO_PROXY` from the environment applies.
3. **`http.proxy`** setting.
4. **Environment**: `https_proxy || HTTPS_PROXY || http_proxy || HTTP_PROXY`. This single value is used for both `http:` and `https:` targets, so the scheme split is not honored. It is read **once** when the extension host starts (L218-L220), so changing the variable requires a restart.
5. **Remote** extension host with `http.useLocalProxyConfiguration` turned off connects directly.
6. **System proxy**, cached per `scheme://host:port`. VS Code resolves it with `extHostWorkspace.resolveProxy`. In the renderer this goes to `mainThreadWorkspace.$resolveProxy`, then `NativeRequestService.resolveProxy`, then the main process `session.resolveProxy(url)` ([nativeHostMainService.ts](https://github.com/microsoft/vscode/blob/1.139.1/src/vs/platform/native/electron-main/nativeHostMainService.ts), [Electron `ses.resolveProxy`](https://www.electronjs.org/docs/latest/api/session#sesresolveproxyurl)). This is Chromium's resolver, which uses the OS settings. On Windows that covers manual proxy, PAC URL and WPAD auto-detect. The `--proxy-server` / `--proxy-pac-url` / `--proxy-bypass-list` launch flags also apply here ([VS Code network docs](https://code.visualstudio.com/docs/setup/network#_proxy-server-support)). The cache is flushed when network interfaces change, checked every 300 s by default (`http.experimental.networkInterfaceCheckInterval`).
7. If system resolution throws, the resolver falls back to any cached proxy.

A PAC result such as `PROXY a:8080; DIRECT` becomes a URL through [`getProxyURLFromResolverResult`](https://github.com/microsoft/vscode-proxy-agent/blob/v0.45.0/src/agent.ts#L156-L192). The **first** entry is taken (`PROXY`/`HTTP` becomes `http://`, `HTTPS` becomes `https://`, `SOCKS`/`SOCKS5` becomes `socks://`, `SOCKS4` becomes `socks4a://`), and there is no failover to later entries.

### Settings that gate fetch

All of these are defined in [request.ts @1.139.1](https://github.com/microsoft/vscode/blob/1.139.1/src/vs/platform/request/common/request.ts#L246-L350).

| Setting | Default | Effect on `fetch` |
| --- | --- | --- |
| `http.fetchAdditionalSupport` | `true` | `false` turns off both proxy and certificate additions for `fetch`. |
| `http.proxySupport` | `override` | `off` means no proxy. `on` means the proxy is resolved only if the caller passed no `dispatcher`. `fallback` and `override` always resolve. |
| `http.proxy` | empty | Explicit proxy URL. It wins over the environment and the system proxy. |
| `http.noProxy` | `[]` | Bypass list. It replaces `NO_PROXY` when non-empty. |
| `http.systemCertificates` | `true` | Adds `tls.rootCertificates` plus OS certificates (on Windows, loaded from the main process) as the undici CA. |
| `http.electronFetch` | `false` | Opt-in: serve global `fetch` with Electron `net.fetch` (Chromium network stack). Local extension host only. |
| `http.useLocalProxyConfiguration` | `true` | Remote extension host: resolve the proxy on the local machine. |

In a local extension host, these values are read through `inspect().globalLocalValue ?? defaultValue`, so only **user** settings count, never workspace settings ([proxyResolver.ts#L493-L501](https://github.com/microsoft/vscode/blob/1.139.1/src/vs/workbench/api/node/proxyResolver.ts#L493-L501)). Everything except the environment variables is read per request, so changes take effect live.

## Authentication, certificates and SOCKS

- **Proxy authentication** ([`createProxyAuthorizationLookup`](https://github.com/microsoft/vscode-proxy-agent/blob/v0.45.0/src/index.ts#L114-L180), and the undici 407 handler in [`createProxyAgent`](https://github.com/microsoft/vscode-proxy-agent/blob/v0.45.0/src/index.ts#L883-L965)):
  - **Kerberos/Negotiate** uses the machine's Kerberos, overridable with `http.proxyKerberosServicePrincipal` ([1.81 notes](https://code.visualstudio.com/updates/v1_81#_kerberos-authentication-for-network-proxy)).
  - **Basic** shows VS Code's credentials prompt and caches the result.
  - No other scheme is handled. An **NTLM-only or Digest-only** proxy returns 407 and the request fails. The docs list Basic, Digest, NTLM and Negotiate, but that list describes Chromium, i.e. the workbench, not the extension host.
- **Corporate TLS-inspecting CA**: covered by default through `http.systemCertificates`. The OS store supplies the CA for both the target (`requestTls.ca`) and an HTTPS proxy (`proxyTls.ca`).
- **SOCKS**: a `SOCKS5` system or PAC result is handed to `undici.ProxyAgent` as `socks://`. undici added SOCKS5 support to `ProxyAgent` in **7.23.0** ([proxy-agent.js @v7.29.0](https://github.com/nodejs/undici/blob/v7.29.0/lib/dispatcher/proxy-agent.js)), and VS Code 1.139.1 ships 7.29.0. VS Code builds with older undici could not use SOCKS for `fetch`. `SOCKS4` (`socks4a://`) is not supported by undici `ProxyAgent`. SOCKS5 auth is not implemented, according to the [network docs](https://code.visualstudio.com/docs/setup/network#_authenticated-proxies).

## Streaming

The patch only swaps `init.dispatcher` and calls the original Node `fetch`. The `Response` it returns is Node's own, so `response.body` is the normal streaming `ReadableStream`. `init.signal` is spread through unchanged, so `AbortController` keeps working. The wrapper only redefines the `url` and `type` getters on the response ([proxyResolver.ts `monitorResponseProperties`](https://github.com/microsoft/vscode/blob/1.139.1/src/vs/workbench/api/node/proxyResolver.ts#L242-L257)). HTTPS through an HTTP proxy uses a CONNECT tunnel via undici `ProxyAgent`, which is end-to-end TLS, so SSE chunks are not re-framed by the patch. This conclusion comes from reading the source; no runtime test was done. A TLS-inspecting proxy that buffers responses could still delay SSE, but that is proxy behavior and outside the extension's control.

## Doing it yourself conflicts with VS Code's patch

- **A custom `dispatcher`** (for example `new ProxyAgent(...)` or `EnvHttpProxyAgent`) is **silently replaced** under the default `http.proxySupport: override`.
  - `createFetchPatch` reads `allowH2` and the CA options from your dispatcher and then passes its own `ProxyAgent`, or a plain `Agent` when no proxy is resolved but system certificates are on.
  - Your proxy URI is discarded.
  - `require('undici')` is intercepted and `patchUndici` wraps `Agent`/`ProxyAgent` constructors just to recover those options ([index.ts#L1204-L1228](https://github.com/microsoft/vscode-proxy-agent/blob/v0.45.0/src/index.ts#L1204-L1228)).
  - Your dispatcher is honored only when the user sets `proxySupport` to `on`/`off`, or when the resolved route is DIRECT and system certificates are off.
- **A bundled `undici`** (esbuild/webpack inlines it) is not seen by the `Module._load` interceptor. Its own `fetch`, and any `Agent` created from it, bypass the proxy entirely. The same applies to any HTTP client that does not ultimately use global `fetch` or Node's `http`/`https` builtins. Builtins stay external in bundles, so `node-fetch` and `axios` remain covered by the `http`/`https` patch.
- **Libraries that accept a custom `fetch`** (such as the OpenAI SDK) are covered only while they use `globalThis.fetch`. Custom `fetch` or `dispatcher` options should not be passed.
- **Node's own env proxy** (`NODE_USE_ENV_PROXY`, added in Node v24.0.0 and v22.21.0, [Node CLI docs](https://nodejs.org/api/cli.html#node_use_env_proxy1)) is opt-in at process start and is irrelevant here, because VS Code already honors `HTTP(S)_PROXY` itself (step 4).

## Cases where plain `fetch` fails

1. The VS Code version is below 1.96, and the user is behind any proxy.
2. The user has set `http.fetchAdditionalSupport: false` or `http.proxySupport: off`.
3. The proxy needs **NTLM or Digest** authentication, which the extension host does not support. Workaround: set `http.proxy` to a local authenticating relay such as Cntlm or Px, or try the opt-in `http.electronFetch: true`, which uses Chromium's network stack. Whether Chromium's NTLM prompt works from the extension host was not verified.
4. The system or PAC result is `SOCKS4`, or `SOCKS5` with authentication.
5. A PAC returns a failing first proxy with later fallbacks. Only the first entry is tried.
6. A stale `HTTPS_PROXY`/`HTTP_PROXY` is set in the environment VS Code was launched with. It overrides the Windows system proxy for every request, including `https:` targets when only `HTTP_PROXY` is set, and it is only re-read after VS Code restarts.
7. The extension bundles its own `undici`/`fetch`, or passes a custom `dispatcher` and expects it to be used.
8. Web extension host (vscode.dev): none of this applies, because `fetch` is the browser's and the browser handles proxies. CORS restrictions apply instead.

## Documentation caveat

The [VS Code network docs](https://code.visualstudio.com/docs/setup/network#_legacy-proxy-server-support) section "Legacy proxy server support" still says extensions "don't benefit yet from the same proxy support". The source and the 1.96 release notes show that this is out of date for the extension host: `http.proxy`, the environment variables and the system proxy are all applied to `fetch`, `http`, `https` and `WebSocket`.
