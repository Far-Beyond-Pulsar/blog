---
title: "EngineFS: Pulsar's Virtual Filesystem Layer"
date: "2026-06-26"
author: "Tristan Poland"
tags: ["rust", "game-engine", "architecture", "filesystem", "pulsar"]
description: "How Pulsar abstracts every file operation behind a swappable provider trait — making local disk, HTTP remote, and P2P collaborative sessions all look identical to every crate above them."
thumbnail: /post_thumb/engine_fs.png
---

## Why Not Just Use std::fs?

The obvious approach to file I/O in a Rust application is to call `std::fs` directly. Open a file, read it, write it, done. For a single-player editor that only ever works with local projects that's perfectly fine. The problem arrives when you want to let users open a project that lives on a `pulsar-studio` cloud host, or collaborate over a peer-to-peer session where both editors need to observe and modify the same project files in real time.

If you've scattered direct `std::fs` calls throughout the codebase, you now have to audit every single one and add a branching path for the remote case. That branch expands into network error handling, latency, authentication tokens, different API shapes. You end up with two codepaths for everything and the divergence grows over time. Worse, you can't easily test either path in isolation.

The alternative is to introduce an abstraction early and route everything through it. Pulsar does this with `engine_fs` — a crate that owns all filesystem I/O in the engine and routes calls through a global, swappable provider. Code above it calls `engine_fs::virtual_fs::read_file(path)` and receives bytes back. Whether those bytes came from `std::fs::read` on a local SSD, an HTTP GET to a studio server, or a P2P message exchange is entirely opaque to the caller.

---

## The `FsProvider` Trait

Every backend implements a single trait:

```rust
pub trait FsProvider: Send + Sync + 'static {
    fn read_file(&self, path: &Path) -> Result<Vec<u8>>;
    fn write_file(&self, path: &Path, content: &[u8]) -> Result<()>;
    fn create_file(&self, path: &Path, content: &[u8]) -> Result<()>;
    fn delete_path(&self, path: &Path) -> Result<()>;
    fn rename(&self, from: &Path, to: &Path) -> Result<()>;

    fn list_dir(&self, path: &Path) -> Result<Vec<FsEntry>>;
    fn create_dir_all(&self, path: &Path) -> Result<()>;

    fn exists(&self, path: &Path) -> Result<bool>;
    fn metadata(&self, path: &Path) -> Result<FsMetadata>;

    fn manifest(&self, path: &Path) -> Result<Vec<ManifestEntry>>;

    fn is_remote(&self) -> bool { false }
    fn label(&self) -> &str { "Local" }
}
```

All operations are synchronous. This is a deliberate choice: Pulsar uses GPUI's async primitives rather than raw Tokio, and making file I/O async would require an async runtime to be accessible from every call site, including proc macros and static initialisers that run before the runtime exists. Blocking I/O on a background thread stays simple and is fast enough for the file sizes involved — scene files, blueprint scripts, component definitions, and asset metadata are all small. Large binary assets like mesh geometry and textures are handled through a separate asset loader pipeline that explicitly manages threading.

The `manifest` method is the one that benefits most from a custom override. The default implementation recurses through `list_dir` — which is fine for local disk but brutal over a network where each directory read is a round trip. The `RemoteFsProvider` overrides it to hit a single `/api/v1/workspaces/:id/files/manifest` endpoint that returns the entire project tree in one response. Same return type, one round trip instead of hundreds. No calling code changes at all.

---

## The Global Virtual FS

The active provider lives in a process-global `OnceLock`:

```rust
static VIRTUAL_FS: OnceLock<Arc<RwLock<Arc<dyn FsProvider>>>> = OnceLock::new();

fn global() -> &'static Arc<RwLock<Arc<dyn FsProvider>>> {
    VIRTUAL_FS.get_or_init(|| Arc::new(RwLock::new(Arc::new(LocalFsProvider::new()))))
}
```

The default is `LocalFsProvider`, which is a thin wrapper over `std::fs`. You replace it by calling `virtual_fs::set_provider(your_provider)` before opening the project. From that point forward, every `virtual_fs::read_file` in every crate — including crates that don't know the virtual_fs module exists, because they use `EngineFs::operations()` which routes through it — will talk to the new backend.

The free functions in `virtual_fs` are the primary way to call into the filesystem:

```rust
pub fn read_file(path: &Path) -> Result<Vec<u8>> {
    global().read().read_file(path)
}

pub fn write_file(path: &Path, content: &[u8]) -> Result<()> {
    let result = global().read().write_file(path, content);
    if result.is_ok() {
        events::emit(path.to_path_buf(), FsChangeKind::Modified);
    }
    result
}
```

Notice that `write_file`, `create_file`, `delete_path`, `rename`, and `create_dir_all` all emit an `FsEvent` on success. This is the event bus that the file manager UI, the asset index watcher, and any other subscriber uses to keep itself up to date. It fires regardless of which backend is active — a write to a remote file and a write to local disk both emit the same event type with the same path, and subscribers don't need to know the difference.

---

## The Remote Provider

`RemoteFsProvider` implements `FsProvider` against a `pulsar-studio` HTTP server. It uses `ureq` for blocking HTTP — consistent with the synchronous design of the trait — and serializes all file content as base64 to avoid binary transport issues over JSON.

The configuration carries just three things: the server URL, the workspace ID (a UUID), and an optional bearer token for password-protected servers. Cloud project paths use the `cloud+pulsar://` URI scheme, so the provider has a path-normalization helper that strips the scheme and workspace prefix to recover the bare relative path before building API URLs:

```rust
fn to_rel(&self, path: &Path) -> Result<String> {
    let s = path.to_string_lossy().replace('\\', "/");

    let rel = if let Some(tail) = s.strip_prefix("cloud+pulsar://") {
        let after_host = tail.find('/').map(|i| &tail[i + 1..]).unwrap_or("");
        let after_proj = after_host.find('/').map(|i| &after_host[i + 1..]).unwrap_or("");
        after_proj.to_string()
    } else {
        s
    };

    if rel.split('/').any(|seg| seg == "..") {
        bail!("Path traversal not allowed: {}", path.display());
    }

    Ok(rel)
}
```

Path traversal is rejected at the conversion step, not in the HTTP handler. Every operation goes through `to_rel`, so there is no path where a `..`-containing path can reach the network call. `read_file` then looks like this:

```rust
fn read_file(&self, path: &Path) -> Result<Vec<u8>> {
    let rel = self.to_rel(path)?;
    let url = format!("{}?path={}", self.files_base(), Self::encode(&rel));
    let mut resp = self.auth(self.agent.get(&url)).call()
        .context("RemoteFs read HTTP call failed")?;
    let body: ApiReadResponse = resp.body_mut().read_json()
        .context("RemoteFs read: JSON parse error")?;
    decode_b64(&body.content)
}
```

The `auth()` helper injects the `Authorization: Bearer` header when a token is configured. Every operation is otherwise identical in shape to a local `std::fs::read` call — take a path, return bytes or an error.

The `manifest` override hits a dedicated endpoint instead of recursing:

```rust
fn manifest(&self, path: &Path) -> Result<Vec<ManifestEntry>> {
    let rel = self.to_rel(path)?;
    let url = format!("{}/manifest?path={}", self.files_base(), Self::encode(&rel));
    let mut resp = self.auth(self.agent.get(&url)).call()
        .context("RemoteFs manifest HTTP call failed")?;
    let entries: Vec<ManifestEntry> = resp.body_mut().read_json()
        .context("RemoteFs manifest: JSON parse error")?;
    Ok(entries)
}
```

One HTTP call, full tree. This is the approach that makes cloud project loading feel fast — the initial scan that builds the asset index calls `manifest` once and never touches the network again during the scan pass itself.

---

## The P2P Provider

The third backend is `P2pFsProvider`, which routes file operations over a `SessionChannel` from the multiplayer subsystem. This is the backend used during collaborative editing sessions where two editors share a live project. It speaks in `SessionMessage` protocol messages over the channel rather than HTTP:

- `SessionMessage::RequestFile` → receive `SessionMessage::FileChunk` responses
- `SessionMessage::RequestFileManifest` → receive `SessionMessage::FileManifest`

Because `SessionChannel` is async and `FsProvider` is synchronous, `P2pFsProvider` uses `futures::executor::block_on` to drive each future to completion. It's not the most efficient approach for a hot path, but file I/O during collaborative editing is infrequent enough that the overhead is negligible.

The pattern here is the important thing: a third completely different storage backend — one that doesn't even involve disk or HTTP — plugs in through the same `FsProvider` trait with zero changes anywhere else. The multiplayer session just calls `virtual_fs::set_provider(Arc::new(P2pFsProvider::new(channel, project_id)))` when it starts and everything above it automatically goes through the peer.

---

## The Asset Index

`EngineFs` owns an `AssetIndex` alongside the virtual FS. The index is an in-memory, thread-safe map of everything discovered in the project during the initial scan and maintained as files change. It supports several lookup strategies simultaneously using multiple `DashMap` indices:

```rust
pub struct AssetIndex {
    assets: DashMap<u64, AssetInfo>,
    name_index: DashMap<String, Vec<u64>>,
    category_index: DashMap<String, Vec<u64>>,
    file_path_index: DashMap<PathBuf, u64>,
    next_id: AtomicU64,
}
```

Every asset gets a numeric ID assigned atomically at registration time. The name and category indices are case-insensitive string→ID maps so lookups are O(1). The file path index enables path→asset translation for the watcher — when `notify` reports that a file was deleted, the watcher can remove the entry in one `file_path_index` lookup rather than scanning all assets.

`AssetInfo` carries the file type ID from the plugin registry alongside the path, name, and metadata:

```rust
pub struct AssetInfo {
    pub id: u64,
    pub name: String,
    pub category: Option<String>,
    pub description: Option<String>,
    pub file_path: Option<PathBuf>,
    pub file_type_id: FileTypeId,
    pub display_name: String,
    pub last_modified: Option<SystemTime>,
}
```

The `file_type_id` is not a hardcoded enum — it comes from whatever plugins are loaded. A plugin that teaches the engine about `.my_format` files registers a `FileTypeDefinition` with the plugin manager, and the scanner calls `pm.file_type_registry().get_file_type_for_path(&path)` to categorize each file. This means the asset index handles plugin-defined file types transparently, and the editor's file browser shows them correctly without any changes to `engine_fs` itself.

The index also has fuzzy search built in:

```rust
pub fn search_fuzzy(&self, query: &str) -> Vec<AssetInfo> {
    let query_lower = query.to_lowercase();
    let query_chars: Vec<char> = query_lower.chars().collect();

    let mut results: Vec<(AssetInfo, i32)> = self.assets.iter()
        .filter_map(|t| {
            let score = fuzzy_match(&query_chars, &t.name.to_lowercase());
            if score > 0 { Some((t.clone(), score)) } else { None }
        })
        .collect();

    results.sort_by(|a, b| b.1.cmp(&a.1));
    results.into_iter().map(|(t, _)| t).collect()
}
```

The scoring gives bonuses for consecutive character matches and for matches at word boundaries (after `_`, ` `, or `-`). This is what powers the quick-open command palette — type a partial name and get results ranked by how well the query aligns to the asset name.

---

## The Event Bus

Every write operation in `virtual_fs` fires on a global broadcast channel:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsChangeKind { Created, Modified, Deleted }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsEvent {
    pub path: PathBuf,
    pub kind: FsChangeKind,
    pub source: FsEventSource,  // Local or Remote
}

pub fn subscribe() -> broadcast::Receiver<FsEvent> { ... }
pub fn emit(path: impl Into<PathBuf>, kind: FsChangeKind) { ... }
```

Subscribers receive every event regardless of which backend generated it. The `source` discriminant lets a subscriber that knows it issued the write skip its own echo — for example, the remote provider fires `emit_remote` when it propagates a change from the peer, which allows the local editor's write handler to distinguish "I made this change" from "the peer made this change" and avoid a feedback loop.

---

## Path Utilities

The `cloud+pulsar://HOST/WORKSPACE_ID/path/to/file` scheme requires its own join and check helpers rather than using `PathBuf`, which on Windows would insert backslashes and break the URI parsing:

```rust
pub fn is_cloud_path(path: &Path) -> bool {
    path.to_string_lossy().replace('\\', "/").starts_with("cloud+pulsar://")
}

pub fn cloud_join(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    if base.is_empty() { return path.to_string(); }
    if path.is_empty() { return base.to_string(); }
    format!("{}/{}", base, path)
}
```

Code that needs to build cloud paths uses `cloud_join` instead of `PathBuf::join`. Everything else uses normal `Path` and `PathBuf` — the virtual FS functions accept `&Path` uniformly, and the `RemoteFsProvider` strips the cloud scheme internally. The calling code never needs to know which kind of path it holds when issuing a read or write.

---

## The Result

From the perspective of any crate that imports `engine_fs`, there is just a filesystem. It reads files, writes files, lists directories, and emits events when things change. The question of *where* those files live — local disk, cloud server, or peer editor — is answered once at project-open time and never asked again. Adding a new backend means implementing `FsProvider` and calling `set_provider`. The rest of the engine doesn't move.
