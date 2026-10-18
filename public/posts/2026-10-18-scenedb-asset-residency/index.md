---
title: "Four Tiers for an Asset: Residency, Derived Data, Cooked Textures, and What SceneDB Gave the Engine"
date: "2026-10-18"
author: ["tristanpoland"]
tags: ["scenedb", "rust", "wgpu", "assets", "memory", "game-engine", "architecture", "pulsar"]
description: "SceneDB's asset layer held every decoded payload for as long as a component referenced it. Four additions fixed that without teaching the database anything about images: a budgeted rebuild-on-miss cache with single-flight rebuilds and prefetch, a derived-data cache on disk, a texture store that takes mip chains and block-compressed formats, and one that can adopt a texture another scene already uploaded. Here is how each works, why it lives where it lives, and what the engine did with them, with the cook that turns a 4K JPEG into 5.3 MiB of BC7 and a full mip chain."
thumbnail: /post_thumb/scenedb-asset-residency.png
---

## Part 0: Context

### 0.1 The gap we wrote down

The last SceneDB post ended its tour of the streaming grid with an admission. Cells move between Outer, Margin and Inner, and "there's no system-RAM tier sitting between fully unloaded and GPU-resident yet." That sentence was about geometry cells. The same hole existed one layer over, in the asset system, and it was easier to fall into there.

Here is how we fell in. We imported a model, the engine built a material graph from the texture files beside it, and a few minutes later the editor held several gigabytes of decoded images. The heap tracker we had built that week gave the owner in one line.

```
(frames abridged)
<image::metadata::cicp::CicpRgb>::cast_pixels_by_layout    78x   64.0 MiB each   4.88 GiB live
  0  DynamicImage::to_rgba8
  1  helio_component::texture_assets::decode_image_file
  2  helio_component::material_assets::load_material
  3  pulsar_scenedb::assets::run_load
```

Seventy-eight decodes of 4096 by 4096 RGBA8, each exactly 64 MiB, each held as an asset payload. Nothing leaked. SceneDB did what its asset layer said it would do, and what it said was the problem.

This post is about what went into SceneDB because of that, and what the engine above it did once it was there. Four pieces, in the order a value meets them. A budgeted cache in memory for data that can be rebuilt. A cache on disk for the expensive conversions that produce it. A texture store that takes a mip chain in a block-compressed format, and can share one texture between scenes. And, on the engine side, a cook step that turns a JPEG into something worth keeping in all of those places. The memory story is the occasion. The interesting part is what a database that owns the scene can now say about data it can rebuild, and how little of that has to know what the data is.

### 0.2 What the asset layer promised

SceneDB treats an asset as a reference with an identity. A component stores an `AssetId`, a 128-bit hash of a kind and a source string. The world finds the references, runs a loader on a worker thread, and binds the result into every component that asked. The public surface is three registration calls.

```rust
/// Loads one asset of a kind from its source: runs on a worker thread.
pub type LoadFn = Arc<dyn Fn(&str) -> Result<AssetPayload, String> + Send + Sync>;

/// A loaded asset's data, shared by every component that references it.
pub type AssetPayload = Arc<dyn Any + Send + Sync>;

pub fn register_loader(kind: &'static str, load: impl Fn(&str) -> Result<AssetPayload, String> + Send + Sync + 'static);
pub fn register_payload_size(kind: &'static str, size: SizeFn);
pub fn register_binding<T: Component>(kind: &'static str, bind: fn(&mut T, &AssetView));
```

Nothing in that list knows what an image is. A kind brings a loader, an optional size function and a binding. The world brings the rest: reference counting through the handle ledger, generation-checked completions so a stale load never lands on a component that moved on, reload when a source file changes. That separation is the reason the asset system could host meshes, materials and textures without a texture-shaped hole in the middle of it.

The retention rule is the part that mattered here. From the module documentation:

```text
- The world keeps each asset's payload (its CPU data) while components
  reference it, so a rebuild has something to rebuild from. Payloads no
  component references any more stay cached, up to a byte budget
  (World::set_asset_cache_budget): past it, World::pump_assets drops the
  ones referenced longest ago.
```

Read the two halves again. A payload that something references stays, always. A payload that nothing references is cached under a budget (256 MiB by default). The budget governs the data that is already dead weight, and the live data is unbounded. For a mesh, that was a reasonable trade. For a pile of 4K images it meant memory grew with the number of assets referenced, whatever the camera happened to be looking at.

The entry the world keeps shows the same assumption in its fields.

```rust
struct Entry {
    kind: &'static str,
    source: Arc<str>,
    state: AssetState,
    version: u64,
    /// The request a completion must carry to be applied.
    token: u64,
    payload: Option<AssetPayload>,
    /// The payload's size, when its kind reports one.
    bytes: usize,
    /// The last pump that saw a component reference it.
    last_used: u64,
}
```

`payload: Option<AssetPayload>` is an owning slot. There is no notion of data that is present when convenient and rebuilt on demand. Either the world has the bytes or the asset is unloaded.

## Part 1: Residency

### 1.1 The contract

Some data is derived. A decoded image comes from a file. A parsed mesh comes from a file. A cooked chunk comes from a file and some settings. The source stays on disk, so the derived form can be thrown away and made again. The code that knows how to make it again is already there, because it ran once to produce the data.

`Residency<T>` takes that code as an argument and manages the result.

```rust
pub struct Residency<T: Send + Sync + 'static> {
    inner: Arc<Inner<T>>,
}

impl<T: Send + Sync + 'static> Residency<T> {
    /// Data built on first `get()` by `rebuild`, whose resident size is `size`.
    pub fn lazy(
        size: impl Fn(&T) -> usize + Send + Sync + 'static,
        rebuild: impl Fn() -> Result<T, String> + Send + Sync + 'static,
    ) -> Self;

    /// Data that is already built, resident now, and rebuilt by `rebuild`
    /// if it is ever dropped to make room.
    pub fn with_value(
        value: T,
        size: impl Fn(&T) -> usize + Send + Sync + 'static,
        rebuild: impl Fn() -> Result<T, String> + Send + Sync + 'static,
    ) -> Self;

    /// The value, rebuilt from its source if it was dropped. Callers that
    /// arrive while a rebuild is in flight wait for it.
    pub fn get(&self) -> Result<Arc<T>, String>;

    /// Start rebuilding on the asset loader threads; collect it with `wait`.
    pub fn prefetch(&self) -> Prefetch<T>;

    pub fn is_resident(&self) -> bool;
}
```

Four behaviors define the core of it, and each one has a test with its own name. Two more arrived after the engine started using it, and they have their own section, 1.6.

The cache holds a strong reference to every resident value and counts its bytes against one process-wide budget. When an insertion pushes the total over budget, the least recently used values lose the cache's reference. A caller that already holds an `Arc<T>` keeps the value alive for as long as it uses it. Eviction removes the cache's claim and leaves everyone else's alone. A value larger than the entire budget stays while it is the most recently used, so one huge asset does not rebuild itself on every access. A failed rebuild returns its error and leaves nothing resident.

### 1.2 The state goes where the rules say

There is an obvious way to write this. A `static` mutex holding a map, a counter and a budget, initialized on first use. It would pass review in most codebases.

SceneDB has a rule against it, and a test that enforces the rule. The editor links the crate statically, and so does every plugin library it loads. Each `static` would exist once per binary, so a plugin's copy of the cache would count its own bytes against its own budget and the editor would never see them. The runtime module exists to prevent that. One copy owns the state and every other copy is attached to the owner's function table when its library loads.

The test reads every source file in the crate, classifies each line, and compares the count per file against an allowlist. A few statics are per-copy on purpose, and each one is listed with a count and a reason, such as the telemetry module's "per-copy query logs; each copy reports its own queries". Anything else fails the build.

```rust
fn is_state(line: &str) -> bool {
    let line = line.trim_start();
    if line.starts_with("//") {
        return false;
    }
    if ["thread_local!", "inventory::collect!", "lazy_static!"]
        .iter()
        .any(|needle| line.contains(needle))
    {
        return true;
    }
    let mut rest = line;
    if let Some(after) = rest.strip_prefix("pub") {
        rest = match after.strip_prefix('(') {
            Some(scoped) => scoped.split_once(')').map_or("", |(_, r)| r),
            None => after,
        }
        .trim_start();
    }
    let Some(rest) = rest.strip_prefix("static ") else {
        return false;
    };
    let rest = rest.trim_start();
    let rest = rest.strip_prefix("mut ").unwrap_or(rest);
    rest.starts_with(|c: char| c.is_ascii_uppercase() || c == '_')
}
```

So the cache cannot be a static. It can be a field of something that already is shared. The asset registries already are, reached through `runtime().asset_registries`, so the cache went there.

```rust
#[derive(Default)]
pub(crate) struct AssetRegistries {
    sources: RwLock<HashMap<AssetId, Declared>>,
    loaders: RwLock<HashMap<&'static str, LoadFn>>,
    bindings: RwLock<HashMap<&'static str, Vec<Binding>>>,
    sizes: RwLock<HashMap<&'static str, SizeFn>>,
    /// The residency cache (see [`crate::residency`]).
    pub(crate) residency: Mutex<crate::residency::State>,
    /// The derived-data cache (see [`crate::derived`]).
    pub(crate) derived: Mutex<crate::derived::State>,
}

pub(crate) fn registries() -> &'static AssetRegistries {
    (crate::runtime::runtime().asset_registries)()
}
```

Adding a field changes `size_of::<AssetRegistries>()`, and that size is folded into the runtime's ABI fingerprint. Part 2 adds a second field beside the first, and the snippet shows both.

```rust
pub const ABI_VERSION: u64 = 5;

const FINGERPRINT: u64 = {
    let parts = [
        ABI_VERSION as usize,
        size_of::<Runtime>(),
        size_of::<ComponentId>(),
        size_of::<TypeId>(),
        size_of::<ErasedComponentInfo>(),
        size_of::<crate::World>(),
        align_of::<crate::World>(),
        size_of::<Registrations>(),
        size_of::<crate::assets::AssetRegistries>(),
        cfg!(feature = "gpu") as usize,
    ];
    // ... FNV-1a over parts
};
```

A plugin built against the old layout now refuses to attach instead of reading a mutex at the wrong offset. We bumped `ABI_VERSION` anyway, twice: once for the residency cache and once for the derived-data cache, which joined it as a second field of the same struct. The fingerprint would have caught both, and the version number says why a load was refused when a person reads the log.

One cost deserves a sentence. Reaching the cache is a function-pointer call into the owner copy, then a mutex. It is on the path of every `get()` that touches the budget, which in practice means texture uploads and decodes, never a per-frame loop.

### 1.3 Three locks and an order

A cache like this has three kinds of lock. The cache has one, protecting the table of entries, the byte total and the clock. Each value has a slot lock, protecting the `Arc<T>` it holds. Each value also has a flight lock, protecting the rebuild in progress if there is one (1.6 covers flights). Eviction needs the first two: pick a victim under the cache lock, empty its slot under the victim's lock. A `get()` on that same value wants them too, in the other direction if you are careless.

The rule is that the cache lock is taken first and a slot lock is never held while taking it. `get()` locks the slot, clones the `Arc`, unlocks, and only then touches the cache to refresh the entry's clock. A rebuild never runs under any of them. A decode of a 4K JPEG takes long enough to matter, and doing it under the cache lock would stall every other texture lookup in the process for the duration.

The second hazard is subtler. Eviction drops values, and dropping a value can run arbitrary code. Dropping the last handle to a `Residency`'s inner state runs `Drop for Inner`, and that locks the cache to remove the entry.

```rust
impl<T: Send + Sync + 'static> Drop for Inner<T> {
    fn drop(&mut self) {
        // The owner went away: stop counting its bytes. (Nothing holds the
        // cache's lock while dropping an `Inner`, see the module docs.)
        lock().remove(self.id);
    }
}
```

If eviction upgraded a `Weak` to the owner while holding the cache lock, and that upgrade turned out to be the last strong reference because the owner had just been dropped elsewhere, then letting the temporary go out of scope would call `Drop for Inner`, which would lock the cache again. `std::sync::Mutex` is not reentrant. The thread would deadlock against itself.

So eviction never lets anything drop while the lock is held. It collects the taken values and the upgraded owners into two vectors and releases them after the guard is gone.

```rust
fn install(&self, value: Arc<T>, rebuilt: bool) -> Arc<T> {
    // ... put `value` in this slot unless another thread already did ...
    let bytes = (self.inner.size)(&value);
    let slot: Arc<dyn Slot> = self.inner.clone();

    let mut dropped: Vec<Box<dyn std::any::Any + Send + Sync>> = Vec::new();
    let mut keep_alive: Vec<Arc<dyn Slot>> = Vec::new();
    {
        let mut state = lock();
        if rebuilt { state.rebuilds += 1; }
        state.insert_or_touch(self.inner.id, bytes, Arc::downgrade(&slot));
        // Evict least-recently-used others until within budget; the value
        // just used stays even if it alone exceeds the budget.
        while state.resident_bytes > state.budget {
            let Some(victim) = state.victim(self.inner.id) else { break };
            let entry = state.remove(victim).expect("victim is listed");
            state.evictions += 1;
            if let Some(slot) = entry.slot.upgrade() {
                if let Some(taken) = slot.take() {
                    dropped.push(taken);
                }
                // Dropping the last handle to an owner would re-enter the
                // cache; hold it until the lock is released.
                keep_alive.push(slot);
            }
        }
    }
    // Values and owners are released here, with no lock held.
    drop(dropped);
    drop(keep_alive);
    value
}
```

The `Slot` trait is the type-erasure seam. The cache stores `Weak<dyn Slot>` so one table can hold values of any `T`, and the only operation it needs on a victim is to empty it.

```rust
trait Slot: Send + Sync {
    /// Drop the cached value (if any); the value is returned so the caller can
    /// release it after unlocking.
    fn take(&self) -> Option<Box<dyn std::any::Any + Send + Sync>>;
}
```

`take` returns the value instead of dropping it for the same reason as the vectors above. The 16 MiB buffer is freed by the allocator after every lock is gone.

### 1.4 Recency as an ordered map

Recency is a counter. Every touch and insertion increments `state.tick` and stamps the entry. There is no wall-clock time to compare and no list to splice, only a `u64` per entry. The interesting question is how the least recently used entry gets found.

The first version chose a victim with a linear scan and `min_by_key`. At a few hundred entries that is nothing next to a decode. At a hundred thousand small residents it is the wrong shape, since every eviction would read every entry. So the index is ordered.

Ticks are unique, since the clock only moves forward. That makes the set of resident values totally ordered by recency, and an ordered map from tick to value id is that order. The least recently used value is the first key.

```rust
pub(crate) struct State {
    budget: usize,
    resident_bytes: usize,
    tick: u64,
    next_id: u64,
    entries: HashMap<u64, Resident>,
    /// `last_use` tick -> value id. Ticks are unique, so this is a total order
    /// over the resident values by recency; the first key is the victim.
    order: BTreeMap<u64, u64>,
    // ... counters ...
}

impl State {
    /// Mark `id` as just used. A value the cache no longer lists is left alone.
    fn touch(&mut self, id: u64) {
        let tick = self.next_tick();
        if let Some(entry) = self.entries.get_mut(&id) {
            self.order.remove(&entry.last_use);
            entry.last_use = tick;
            self.order.insert(tick, id);
        }
    }

    /// Stop listing `id`, returning what the cache knew of it.
    fn remove(&mut self, id: u64) -> Option<Resident> {
        let entry = self.entries.remove(&id)?;
        self.order.remove(&entry.last_use);
        self.resident_bytes = self.resident_bytes.saturating_sub(entry.bytes);
        Some(entry)
    }

    /// The least recently used value other than `except`.
    fn victim(&self, except: u64) -> Option<u64> {
        // At most one key is skipped, so this reads one or two map entries.
        self.order.values().copied().find(|id| *id != except)
    }
}
```

Touch, insert, remove and victim choice are each `O(log n)`. The `except` argument is the value that was just installed, which is always the newest tick and so sits at the far end of the map. The scan for a victim skips at most that one.

Two tests cover the change, and they fail in different ways. The first checks that the order is right.

```rust
#[test]
fn eviction_order_matches_a_reference_lru_over_random_accesses() {
    set_residency_budget(base + 1000);               // room for ten 100-byte values
    let values: Vec<Residency<Blob>> = (0..64).map(|_| blob(100, &builds)).collect();

    let mut model: Vec<usize> = Vec::new();          // least recent first
    let mut rng = Xorshift(0x9E37_79B9_7F4A_7C15);
    for step in 0..5000 {
        // Skewed so some values stay hot and the order is not trivial.
        let pick = (rng.next() % 64).min(rng.next() % 64) as usize;
        values[pick].get().unwrap();
        model.retain(|&v| v != pick);
        model.push(pick);
        while model.len() > 10 { model.remove(0); }

        let resident: Vec<usize> = (0..64).filter(|&v| values[v].is_resident()).collect();
        let mut expected = model.clone();
        expected.sort_unstable();
        assert_eq!(resident, expected, "resident set diverged from the model at step {step}");
    }
}
```

Five thousand random accesses over sixty-four values, with ten slots, and after every one the set of resident values has to equal what a four-line reference LRU says it should be. The skew matters. A uniform access pattern lets a wrong implementation survive by accident, because every value is equally likely to be the right one to drop.

The second checks the cost.

```rust
#[test]
fn choosing_a_victim_does_not_scan_every_resident_value() {
    set_residency_budget(base + 20_000);
    let values: Vec<Residency<Blob>> = (0..100_000).map(|_| blob(1, &builds)).collect();

    // Every access past the first 20,000 evicts. A scan of the resident set
    // per eviction would be about 1.6e9 comparisons here.
    let started = std::time::Instant::now();
    for value in &values { value.get().unwrap(); }
    assert!(started.elapsed() < std::time::Duration::from_secs(10));

    let resident = values.iter().filter(|v| v.is_resident()).count();
    assert_eq!(resident, 20_000);
    assert!(values[99_999].is_resident() && !values[0].is_resident());
}
```

A hundred thousand values, twenty thousand slots, eighty thousand evictions. The whole file of residency-order tests runs in about a third of a second.

### 1.5 What the tests pin

Eight tests live in `tests/residency.rs`. Seven check a single rule each. The eighth is the one that earns its keep.

```rust
#[test]
fn many_threads_sharing_a_small_budget_stay_consistent() {
    let _turn = SERIAL.lock().unwrap();
    set_residency_budget(8 * 1024);
    let builds = Arc::new(AtomicUsize::new(0));
    let values: Arc<Vec<Residency<Blob>>> =
        Arc::new((0..32).map(|_| blob(1024, &builds)).collect());

    let threads: Vec<_> = (0..8)
        .map(|t| {
            let values = values.clone();
            std::thread::spawn(move || {
                for round in 0..400usize {
                    let value = &values[(round * 7 + t * 3) % values.len()];
                    assert_eq!(value.get().unwrap().0.len(), 1024);
                }
            })
        })
        .collect();
    for thread in threads { thread.join().unwrap(); }

    let stats = residency_stats();
    assert!(stats.resident_bytes <= 8 * 1024, "within budget once idle: {stats:?}");
    let resident = values.iter().filter(|v| v.is_resident()).count();
    assert_eq!(
        resident * 1024,
        stats.resident_bytes,
        "the accounted bytes match what is actually resident"
    );
    assert!(builds.load(Ordering::SeqCst) > 32, "eviction forced rebuilds");
}
```

Eight threads, thirty-two values of 1 KiB, a budget of 8 KiB, so at most eight values fit and the other twenty-four fight for them. Three thousand two hundred `get()` calls later the assertion that matters compares two independently computed numbers: the bytes the cache believes it holds, and the number of values whose slot is occupied times their size. Accounting drift is the failure a cache like this is most likely to have and least likely to show. A leaked entry or a double subtraction would break the equality.

The in-use test is shorter and covers the promise callers rely on.

```rust
#[test]
fn a_value_in_use_survives_its_own_eviction() {
    set_residency_budget(500);
    let (a, b) = (blob(400, &builds), blob(400, &builds));
    let held = a.get().unwrap();
    b.get().unwrap();                    // evicts a from the cache
    assert!(!a.is_resident());
    assert_eq!(held.0.len(), 400, "the caller's Arc is untouched");
}
```

### 1.6 One rebuild at a time, and rebuilds ahead of need

Two properties of `get()` were missing from the first version, and each one showed up as a symptom in the engine before it had a name.

The first is single flight. When a value is not resident, every caller that asks for it rebuilds it. Two threads asking at the same moment decode the same JPEG twice, keep one result and drop the other. The extra decode is wasted work, and it shows up as exactly the kind of counter that is hard to explain later: a rebuild count higher than the number of evictions.

The second is that a caller sometimes knows it will want something soon. A material with four textures needs all four to upload. Asking for them one after another decodes them one after another, on the thread that is waiting. The caller has no way to say "start these now and I will collect them in a moment."

Both are the same mechanism, a flight. A flight is one rebuild in progress, shared by everyone who wants the value meanwhile.

```rust
enum FlightState<T> {
    /// Created by a prefetch and waiting in the loader queue: any caller may
    /// claim it.
    Queued,
    Running,
    Done(Result<Arc<T>, String>),
}

/// One rebuild in progress, shared by everyone who wants the value meanwhile.
struct Flight<T> {
    state: Mutex<FlightState<T>>,
    done: Condvar,
}
```

`get()` joins the flight if one exists, creates one if none does, and then runs the rebuild itself unless somebody already is. The `Join` step also re-checks the slot, because a builder installs the value before it clears the flight, and a caller arriving in that gap should find a value and not start a second rebuild.

```rust
pub fn get(&self) -> Result<Arc<T>, String> {
    if let Some(value) = self.resident_value() {
        lock().touch(self.inner.id);
        return Ok(value);
    }
    match self.join() {
        Join::Resident(value) => {
            lock().touch(self.inner.id);
            Ok(value)
        }
        Join::Flight(flight, created) => {
            if !created {
                lock().joined += 1;
            }
            // Builds it here unless somebody is already building it, in
            // which case this returns at once and `wait` waits.
            self.run_flight(&flight);
            flight.wait()
        }
    }
}

fn join(&self) -> Join<T> {
    let mut flight = self.inner.flight.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(existing) = flight.as_ref() {
        return Join::Flight(existing.clone(), false);
    }
    // A builder installs the value before it clears the flight, so a value
    // that is here now means there is nothing to rebuild.
    if let Some(value) = self.resident_value() {
        return Join::Resident(value);
    }
    let created = Flight::new(FlightState::Queued);
    *flight = Some(created.clone());
    Join::Flight(created, true)
}
```

`run_flight` is where the claim happens. The first caller to find the flight `Queued` flips it to `Running` and does the work. Anyone who finds it `Running` or `Done` returns at once and waits.

```rust
fn run_flight(&self, flight: &Arc<Flight<T>>) {
    {
        let mut state = flight.state.lock().unwrap_or_else(|p| p.into_inner());
        match *state {
            FlightState::Queued => *state = FlightState::Running,
            _ => return,
        }
    }
    let guard = FlightGuard { inner: &self.inner, flight, finished: false };
    // Rebuild with no lock held: it can take a while (a decode).
    match (self.inner.rebuild)() {
        Ok(rebuilt) => {
            let value = self.install(Arc::new(rebuilt), true);
            guard.finish(Ok(value));
        }
        Err(error) => guard.finish(Err(error)),
    }
}
```

`FlightGuard` exists for one reason. A rebuild is arbitrary user code, and arbitrary user code panics. If the builder dies with the flight still `Running`, every waiter sleeps on a condition variable nobody will signal. The guard's `Drop` publishes `Err("rebuild panicked")` and clears the flight if the builder never got to.

```rust
impl<T: Send + Sync + 'static> Drop for FlightGuard<'_, T> {
    fn drop(&mut self) {
        if !self.finished {
            self.publish(Err("rebuild panicked".into()));
        }
    }
}
```

A failed rebuild reaches every waiter with the same message, and the flight is cleared, so the next call starts a fresh attempt. A failure is never cached.

`prefetch` is a flight started from the outside. It creates the flight, queues a job that runs it, and hands back a handle.

```rust
pub fn prefetch(&self) -> Prefetch<T> {
    if self.is_resident() {
        return Prefetch { residency: self.clone(), flight: None };
    }
    match self.join() {
        Join::Resident(_) => Prefetch { residency: self.clone(), flight: None },
        Join::Flight(flight, created) => {
            if created {
                lock().prefetches += 1;
                let this = self.clone();
                let queued = flight.clone();
                crate::assets::run_load(Box::new(move || this.run_flight(&queued)));
            }
            Prefetch { residency: self.clone(), flight: Some(flight) }
        }
    }
}
```

The job goes to `run_load`, the same bounded queue of loader threads the asset layer already uses for loaders, so a hundred prefetches do not become a hundred threads. The queue is the reason the claim rule matters. Suppose every loader thread is busy and the one in front is blocked waiting for a prefetch that sits behind it. A queue that only the workers drain would never make progress. Instead `Prefetch::wait` runs the flight itself if it finds it still `Queued`, and the job that arrives later finds it `Running` or `Done` and returns.

```rust
pub fn wait(self) -> Result<Arc<T>, String> {
    match self.flight {
        Some(flight) => {
            self.residency.run_flight(&flight);
            flight.wait()
        }
        None => self.residency.get(),
    }
}
```

The test that pins this is the one worth reading. It saturates the loader threads with rebuilds that block on a gate, queues a prefetch behind them, and waits for it with every worker busy.

```rust
#[test]
fn waiting_on_a_queued_prefetch_runs_it_instead_of_deadlocking_behind_busy_workers() {
    let workers = pulsar_scenedb::asset_load_workers();
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let started = Arc::new(AtomicUsize::new(0));

    // Occupy every loader thread with a rebuild that blocks until released.
    let blockers: Vec<Residency<Blob>> = (0..workers)
        .map(|_| {
            let (gate, started) = (gate.clone(), started.clone());
            Residency::lazy(size, move || {
                started.fetch_add(1, Ordering::SeqCst);
                let (open, signal) = &*gate;
                let mut open = open.lock().unwrap();
                while !*open { open = signal.wait(open).unwrap(); }
                Ok(Blob(vec![0; 1]))
            })
        })
        .collect();
    let pending: Vec<_> = blockers.iter().map(|b| b.prefetch()).collect();
    while started.load(Ordering::SeqCst) < workers {
        std::thread::sleep(Duration::from_millis(5));
    }

    // Every loader thread is busy, so this prefetch sits in the queue. Waiting
    // for it must run it here.
    let target: Residency<Blob> = Residency::lazy(size, || Ok(Blob(vec![5; 4])));
    let queued = target.prefetch();
    let began = Instant::now();
    assert_eq!(queued.wait().unwrap().0.len(), 4);
    assert!(began.elapsed() < Duration::from_secs(2), "did not wait for a free worker");

    *gate.0.lock().unwrap() = true;
    gate.1.notify_all();
    for prefetch in pending { prefetch.wait().unwrap(); }
}
```

Without the claim rule this test hangs, and it hangs reliably. The other tests in that file are shorter. Sixteen threads calling `get()` at a barrier produce one rebuild and one shared `Arc`. Six threads waiting on a rebuild that fails all see the same error, and a seventh call afterwards retries and succeeds. A builder that panics leaves its waiter with `"rebuild panicked"` and no hang. Eight prefetches of 150 ms rebuilds finish in well under the 1.2 seconds that running them one after another would take, because the loader threads run them side by side.

## Part 2: The Disk tier

### 2.1 What a rebuild costs

Residency answers what to do when memory runs short. It does not make the rebuild cheap. A texture that falls out of the cache and comes back is decoded from its JPEG again, scaled again and, now that textures are cooked, given a mip chain and block-compressed again. All of that is pure function of the source file and a few settings. The result of the first run is exactly what the second run will compute.

That is a cache with a different shape from Residency. It outlives the process, it is keyed by content, and it lives on disk. It also has nothing to do with images. Any kind with an expensive conversion from a source file wants the same thing: a model's parsed geometry, a compiled shader, a baked lightmap tile. So it went into SceneDB with an opaque payload and a kind-owned format.

```rust
/// What to derive: the kind, the source, and everything else the result
/// depends on.
pub struct DerivedRequest<'a> {
    /// The asset kind; also the folder the file goes in.
    pub kind: &'a str,
    pub source: &'a Path,
    /// Every setting the result depends on, as a string (a size cap, a target
    /// format). A change makes a new key.
    pub settings: &'a str,
    /// The kind's format version: bump it when `build` changes what it returns.
    pub version: u32,
}

pub fn derive_cached(
    request: &DerivedRequest,
    build: impl FnOnce() -> Result<Vec<u8>, String>,
) -> Result<Vec<u8>, String>;
```

A caller hands over the request and a closure that does the expensive thing. It gets bytes back, from a file if the file is good and from the closure if it is not. With no cache directory configured, `derive_cached` is just `build()`. The cache is a layer a project turns on, and nothing above it changes shape when it is off.

### 2.2 The key

A key has to change when the result would change, and it has to be cheap to compute, because a hit should cost less than the thing it avoids. Hashing a 2 MB JPEG to find out whether it changed is fast, but doing it for every request adds up, and build systems commonly settle on file metadata for this.

```rust
/// The key of `request` for a source with the given length and mtime.
pub(crate) fn key_of(request: &DerivedRequest, length: u64, modified: u128) -> u128 {
    let mut hash: u128 = 0x6c62_272e_07bb_0142_62b8_2175_6295_c58d;
    let prime: u128 = 0x0000_0000_0100_0000_0000_0000_0000_013b;
    let mut feed = |bytes: &[u8]| {
        for &byte in bytes {
            hash ^= u128::from(byte);
            hash = hash.wrapping_mul(prime);
        }
    };
    feed(request.kind.as_bytes());
    feed(&[0]);
    feed(request.source.to_string_lossy().as_bytes());
    feed(&[0]);
    feed(&length.to_le_bytes());
    feed(&modified.to_le_bytes());
    feed(request.settings.as_bytes());
    feed(&[0]);
    feed(&request.version.to_le_bytes());
    hash
}
```

It is the same 128-bit FNV-1a that `AssetId::of` uses, over the kind, the source path, the source's length and modification time, the settings string and the format version. A hit costs one `stat` and one read. It does not read the source. A file whose length and modification time are unchanged is assumed unchanged, which is the usual trade and has the usual failure: an edit that preserves both. We chose it knowingly. The failure leaves a stale derived file, and `forget_derived` exists for the caller that finds one it cannot use.

### 2.3 Files

A derived file is a 32-byte header and the payload.

```rust
const MAGIC: [u8; 4] = *b"PDD1";
const HEADER_LEN: usize = 32;

fn read_cached(path: &Path, key: u128, version: u32) -> Option<Vec<u8>> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() < HEADER_LEN || bytes[..4] != MAGIC {
        return None;
    }
    let stored_version = u32::from_le_bytes(bytes[4..8].try_into().ok()?);
    let length = u64::from_le_bytes(bytes[8..16].try_into().ok()?) as usize;
    let stored_key = u64::from_le_bytes(bytes[16..24].try_into().ok()?);
    if stored_version != version
        || stored_key != key as u64
        || bytes.len() != HEADER_LEN + length
    {
        return None;
    }
    Some(bytes[HEADER_LEN..].to_vec())
}
```

Magic, format version, payload length and the low half of the key. A file that fails any check is a miss, and the miss rebuilds and replaces it. The length check is what catches a truncated file, the usual result of a crash mid-copy. The payload itself is not checksummed. We considered it and priced it: at about 5 MiB per cooked texture a checksum adds a pass over every read for protection against bit rot, which is not the failure we see.

Writing is the half that has to be right, because a reader must never see a partial file.

```rust
fn write_cached(path: &Path, key: u128, version: u32, payload: &[u8], unique: u64) -> std::io::Result<()> {
    let dir = path.parent().expect("cache files have a folder");
    std::fs::create_dir_all(dir)?;
    let mut bytes = Vec::with_capacity(HEADER_LEN + payload.len());
    bytes.extend_from_slice(&MAGIC);
    bytes.extend_from_slice(&version.to_le_bytes());
    bytes.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&(key as u64).to_le_bytes());
    bytes.extend_from_slice(&[0; 8]);
    bytes.extend_from_slice(payload);
    let temp = dir.join(format!(".{:032x}.{}.{}.tmp", key, std::process::id(), unique));
    std::fs::write(&temp, &bytes)?;
    std::fs::rename(&temp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}
```

The file is written under a temporary name and renamed into place. Two threads cooking the same texture both succeed, the second rename replaces the first with identical bytes, and no reader sees either one half-written. The `unique` number comes from a counter held in the cache state. A `static` counter would have been the obvious choice, and it is exactly what the world-state test in 1.2 is written to refuse. The counter lives with the rest of the state.

A failed write never fails the request. The caller asked for the derived bytes and has them. The error is counted in `DerivedStats::errors` and the next request tries again.

### 2.4 Pruning

A cache that never forgets becomes a disk problem. `prune_derived_cache(max_bytes)` deletes the least recently used files until the total fits, and recency is the file's modification time, which every hit refreshes.

```rust
if let Some(payload) = read_cached(&path, key, request.version) {
    // Recently used files are the last to be pruned.
    if let Ok(file) = std::fs::OpenOptions::new().write(true).open(&path) {
        let _ = file.set_modified(SystemTime::now());
    }
    // ...
    return Ok(payload);
}
```

The test builds four files, spaced thirty milliseconds apart, then hits the oldest one so it becomes the newest. It prunes to room for two and checks which two survive.

```rust
// A hit refreshes a file: source 0 becomes the most recently used.
derive_counting(&request(&sources[0], "", 1), &builds, b"unused").unwrap();

let each = 1000 + 32;
let report = prune_derived_cache(2 * each).unwrap();
assert_eq!(report.removed_files, 2);

// Sources 1 and 2 were the oldest; 0 (refreshed) and 3 survive.
derive_counting(&request(&sources[0], "", 1), &builds, b"unused").unwrap();
derive_counting(&request(&sources[3], "", 1), &builds, b"unused").unwrap();
assert_eq!(builds.load(Ordering::SeqCst), 4, "the survivors are still hits");
derive_counting(&request(&sources[1], "", 1), &builds, &vec![1; 1000]).unwrap();
assert_eq!(builds.load(Ordering::SeqCst), 5, "a pruned file is rebuilt on demand");
```

The engine points the cache at `<project>/.pulsar/cache/derived`, reads a budget from the `streaming.derived_cache_mb` project setting (4096 by default), and prunes once per process on a background thread so startup never waits on a directory walk.

### 2.5 The ladder

With this in place an asset has four forms, and each tier is somebody's job.

| Tier | Where | Owner |
|---|---|---|
| Cold | the source file | the project |
| Disk | the derived file under `.pulsar/cache/derived` | `derive_cached` |
| RAM | the cooked bytes in the residency cache | `Residency<T>` |
| VRAM | a `wgpu::Texture` in a scene's `TextureStore` | the texture store |

A value evicted from RAM comes back by reading the Disk tier. A value missing from the Disk tier comes back by building from Cold, and then it is in the Disk tier for good. Nothing in the chain knows what the bytes mean. The kind supplies the closure at the bottom and the format of the payload, and the tiers handle where it lives.

## Part 3: A texture belongs to a device

### 3.1 What a store could do

Residency governs CPU memory. The same assets also occupy GPU memory, and that side had its own version of the one-owner assumption.

`TextureStore` is SceneDB's bindless texture table. It holds `wgpu::Texture` objects, so they survive a renderer teardown, and Helio builds views from them. Its fields tell the story.

```rust
pub struct TextureStore {
    textures: Vec<Option<wgpu::Texture>>,
    free: Vec<u32>,
    next: u32,
    max_slots: u32,
    upload_count: u64,
}
```

The only way to put a texture in was `register`, which allocates a slot, creates the texture from a descriptor, and uploads the pixels.

```rust
pub fn register(
    &mut self,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    desc: &wgpu::TextureDescriptor<'_>,
    data: &[u8],
) -> Result<u32, TextureError> {
    let slot = self.allocate_slot()?;
    let texture = device.create_texture(desc);
    // ... block_dimensions guard, bytes_per_row ...
    queue.write_texture(texture.as_image_copy(), data, /* layout */, desc.size);
    self.upload_count += 1;
    // ... store at slot ...
    Ok(slot)
}
```

There is one store per scene, attached to the scene's GPU mirror. A level open in two viewports has two scenes, two mirrors, two stores. The same image shown in both was uploaded twice, as two separate allocations on one device. The store had no way to say "this texture already exists, use it."

### 3.2 Adopting a texture

The addition is one method and one refactor. Slot allocation moved out of `register` into a private helper so both paths share it.

```rust
/// The next free slot (LIFO reuse, else a fresh index), or `SlotsExhausted`.
fn allocate_slot(&mut self) -> Result<u32, TextureError> {
    match self.free.pop() {
        Some(slot) => Ok(slot),
        None => {
            if self.next >= self.max_slots {
                return Err(TextureError::SlotsExhausted);
            }
            let slot = self.next;
            self.next += 1;
            Ok(slot)
        }
    }
}

/// Gives an *existing* texture a slot in this store, with no upload.
pub fn register_shared(&mut self, texture: wgpu::Texture) -> Result<u32, TextureError> {
    let slot = self.allocate_slot()?;
    let index = slot as usize;
    if index >= self.textures.len() {
        self.textures.resize_with(index + 1, || None);
    }
    self.textures[index] = Some(texture);
    Ok(slot)
}
```

That is the whole feature. `wgpu::Texture` is reference counted, and cloning one clones a handle to the same GPU allocation. Two stores holding clones hold one texture. When the last clone drops, the allocation goes.

SceneDB's Ownership Law says the database owns all scene data on the GPU side. Sharing fits under it. The store still owns every texture it holds, with a refcount of at least one, and it does not care who else holds a handle. The method does not check that the texture belongs to the store's device or carries `TEXTURE_BINDING` usage. That check is the caller's, and the doc comment says so.

The slot behaves like any other afterward. It recycles through the same LIFO free list, `unregister` drops this store's handle only, and `upload_count` does not move on adoption, which is what the test asserts.

```rust
#[test]
fn a_texture_can_be_shared_between_stores_without_a_second_upload() {
    let ctx = test_context();
    let mut first = TextureStore::new(16);
    let mut second = TextureStore::new(16);
    let slot_a = first
        .register(ctx.device(), ctx.queue(), &rgba_desc(1, 1), &[1u8, 2, 3, 4])
        .expect("first register uploads");
    let shared = first.texture(slot_a).expect("resident").clone();

    let slot_b = second.register_shared(shared).expect("adopt");
    assert_eq!(first.upload_count(), 1);
    assert_eq!(second.upload_count(), 0, "adopting a texture uploads nothing");
    assert_eq!(first.texture(slot_a), second.texture(slot_b), "same GPU texture");

    second.unregister(slot_b).expect("unregister");
    assert!(second.texture(slot_b).is_none());
    assert!(first.texture(slot_a).is_some());
    let reused = second.register_shared(first.texture(slot_a).unwrap().clone()).unwrap();
    assert_eq!(reused, slot_b, "the freed slot is reused");
}
```

`wgpu::Texture` implements `PartialEq` and a clone compares equal to its source, so the equality assertion checks that both stores hold the same texture. A second test checks the failure edge: adopting into a full store returns `SlotsExhausted` instead of growing past `max_slots`.

### 3.3 Mips and blocks

`register` is single-level and uncompressed by construction. It asserts a 1 by 1 block and derives `bytes_per_row` as one texel's size times the width. The doc comment was honest about it: mip chains ride with the asset pipeline, and block-compressed formats need block-aware row arithmetic that was out of scope.

Block-compressed formats are the point of the cook in Part 4. A BC7 texture is a quarter the size of its RGBA8 form, and the GPU samples it directly. So the store grew a second registration path, `register_mips`, that takes a whole chain and understands blocks.

The data contract is the layout wgpu expects for the format: each level is tightly packed rows of blocks, `ceil(width / block_width)` blocks per row, `ceil(height / block_height)` rows, each block `block_copy_size` bytes. For an uncompressed format a block is one texel and the arithmetic reduces to what `register` did. For BC7 a block is 4 by 4 texels in 16 bytes.

Levels smaller than a block round up. A BC7 texture 8 texels wide has levels of 8, 4, 2 and 1 texels. The last two still occupy one whole 4 by 4 block each, so the data for level 2 is one block, the same as level 1.

```rust
pub fn register_mips(
    &mut self,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    desc: &wgpu::TextureDescriptor<'_>,
    mips: &[&[u8]],
) -> Result<u32, TextureError> {
    assert_eq!(
        (desc.dimension, desc.size.depth_or_array_layers, desc.sample_count),
        (wgpu::TextureDimension::D2, 1, 1),
        "TextureStore::register_mips takes a single-layer, single-sample 2D texture"
    );
    if mips.len() != desc.mip_level_count as usize {
        return Err(TextureError::MipCountMismatch);
    }
    let (block_width, block_height) = desc.format.block_dimensions();
    let block_size = desc.format.block_copy_size(None)
        .expect("depth-stencil and multi-planar formats have no single block_copy_size");
    let layouts: Vec<(wgpu::Extent3d, u32, u32)> = (0..desc.mip_level_count)
        .map(|level| {
            let logical = desc.mip_level_size(level).expect("level is within the mip count");
            let physical = logical.physical_size(desc.format);
            let blocks_wide = physical.width / block_width;
            let blocks_high = physical.height / block_height;
            (physical, blocks_wide * block_size, blocks_high)
        })
        .collect();
    for (data, (_, bytes_per_row, rows)) in mips.iter().zip(&layouts) {
        if data.len() != (*bytes_per_row as usize) * (*rows as usize) {
            return Err(TextureError::MipSizeMismatch);
        }
    }

    let slot = self.allocate_slot()?;
    let texture = device.create_texture(desc);
    for (level, (data, (physical, bytes_per_row, rows))) in mips.iter().zip(&layouts).enumerate() {
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: level as u32,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(*bytes_per_row),
                rows_per_image: Some(*rows),
            },
            *physical,
        );
    }
    self.upload_count += 1;
    // ... store at slot ...
    Ok(slot)
}
```

Everything that can be wrong with the caller's data is checked before `allocate_slot`. A chain with the wrong number of levels, or a level whose length is not blocks times block size, returns an error and has taken nothing. A rejected upload that had already claimed a slot would leave a hole in the table until something noticed. The test for that asserts the store's slot count is still zero after both failures and that the next valid chain gets slot zero.

```rust
let two: Vec<&[u8]> = good.iter().take(2).map(Vec::as_slice).collect();
assert_eq!(
    store.register_mips(&gpu.device, &gpu.queue, &desc, &two),
    Err(TextureError::MipCountMismatch)
);

let mut wrong = good.clone();
wrong[1] = vec![0; 15];
let wrong: Vec<&[u8]> = wrong.iter().map(Vec::as_slice).collect();
assert_eq!(
    store.register_mips(&gpu.device, &gpu.queue, &desc, &wrong),
    Err(TextureError::MipSizeMismatch)
);

assert_eq!(store.slot_count(), 0, "neither failure took a slot");
```

Two checks that wgpu itself performs stay wgpu's. A compressed format needs the device feature that goes with it, and level zero must be a whole number of blocks. The doc comment says so, and the cook refuses to produce a BC7 texture for a size that violates the second rule.

The test that matters uploads a chain and reads every level back. It writes recognisable bytes, copies each level into a staging buffer with `copy_texture_to_buffer`, strips the row padding the copy requires, and compares with what went in. For an uncompressed 8 by 4 chain that is four levels. For BC7 it is an 8 by 8 chain whose levels are 4, 1, 1 and 1 blocks.

```rust
// 8x8 BC7: levels 8x8 (2x2 blocks), 4x4 (1), 2x2 (1, padded to 4x4), 1x1 (1).
let desc = descriptor(8, 8, 4, wgpu::TextureFormat::Bc7RgbaUnorm);
let levels: Vec<Vec<u8>> = [4usize, 1, 1, 1]
    .iter()
    .enumerate()
    .map(|(level, blocks)| pattern(level as u32, blocks * 16))
    .collect();
let slices: Vec<&[u8]> = levels.iter().map(Vec::as_slice).collect();

let mut store = TextureStore::new(4);
let slot = store.register_mips(&gpu.device, &gpu.queue, &desc, &slices).unwrap();
let texture = store.texture(slot).unwrap();
for (level, expected) in levels.iter().enumerate() {
    assert_eq!(&read_level(&gpu, texture, level as u32), expected, "level {level}");
}
```

The BC test is skipped on an adapter without `TEXTURE_COMPRESSION_BC`, with a message saying so. On the machine we develop on it runs, and passes, including the level that pads out to a full block.

A texture registered this way is shareable like any other. The last test in that file uploads a two-level chain, adopts it into a second store with `register_shared`, and reads level one back from the second store's handle.

## Part 4: What the engine did with it

SceneDB gained a RAM tier, a Disk tier, a block-aware upload and a way to share a texture between stores, and none of it knows what an image is. Everything texture-specific stayed in Helio, which is where it belongs under the rule that component types and their logic live next to the renderer.

### 4.1 A texture is a recipe and a set of cooked forms

`LoadedTexture` is the payload of the texture asset kind. It used to own a `Vec<u8>` of decoded texels. Then it owned a `Residency` around the same vector. It now owns neither. It holds a recipe, the source path and the size cap, and one lazily created `Residency` per cook format.

```rust
pub struct LoadedTexture {
    /// Dimensions after the [`max_texture_size`] cap.
    pub width: u32,
    pub height: u32,
    source: std::path::PathBuf,
    cap: u32,
    /// One residency per cook format, made the first time a format is asked
    /// for (a device wants one format; a second device may want the other).
    cooked: [std::sync::OnceLock<pulsar_scenedb::Residency<CookedTexture>>; 2],
}

impl LoadedTexture {
    fn residency(&self, format: CookFormat) -> &pulsar_scenedb::Residency<CookedTexture> {
        let format = self.effective_format(format);
        let index = match format {
            CookFormat::Rgba8 => 0,
            CookFormat::Bc7 => 1,
        };
        self.cooked[index].get_or_init(|| {
            let (path, cap) = (self.source.clone(), self.cap);
            pulsar_scenedb::Residency::lazy(
                |cooked: &CookedTexture| cooked.byte_size(),
                move || cook_from_source(&path, cap, format),
            )
        })
    }

    /// The cooked texture in `format` (or the closest this size allows).
    pub fn cooked(&self, format: CookFormat) -> Result<Arc<CookedTexture>, String> {
        self.residency(format).get()
    }

    /// Start producing the cooked texture on the asset loader threads.
    pub fn prefetch(&self, format: CookFormat) -> pulsar_scenedb::Prefetch<CookedTexture> {
        self.residency(format).prefetch()
    }
}
```

The format is per device, and the payload is per asset. A level open on a machine with BC support asks for BC7. A second device on an adapter without it asks for RGBA8. Both can exist in one process, so the payload cannot decide, and one residency per format lets each device get what it wants without either evicting the other's.

The rebuild closure is where the two caches meet. It asks SceneDB for the derived file and only cooks when there is none.

```rust
fn cook_from_source(path: &Path, cap: u32, format: CookFormat) -> Result<CookedTexture, String> {
    let settings = format!("cap={cap};format={}", format.label());
    let request = pulsar_scenedb::DerivedRequest {
        kind: TEXTURE_ASSET_KIND,
        source: path,
        settings: &settings,
        version: COOK_VERSION,
    };
    let cook_now = || -> Result<CookedTexture, String> {
        let (width, height, rgba) = decode_rgba(path, cap)?;
        cook(&rgba, width, height, format)
    };
    let bytes = pulsar_scenedb::derive_cached(&request, || cook_now().map(|c| c.to_bytes()))?;
    match CookedTexture::from_bytes(&bytes) {
        Ok(cooked) => Ok(cooked),
        Err(error) => {
            tracing::warn!("derived texture for '{}' is unusable ({error}); cooking it again", path.display());
            // Replace the entry through the cache, so the repair is stored and
            // the next load is a read.
            pulsar_scenedb::forget_derived(&request);
            let bytes = pulsar_scenedb::derive_cached(&request, || cook_now().map(|c| c.to_bytes()))?;
            CookedTexture::from_bytes(&bytes)
        }
    }
}
```

The cache's own header checks cannot judge the payload, because the cache does not know what the payload is. `CookedTexture::from_bytes` can, and it validates every level length against what the format and size require. A file that passes the first check and fails the second is forgotten and rebuilt through the same path, so the repair is stored. The first version of this function repaired the entry in memory and did not store it, which meant the next load paid again. A test found that. It is the last assertion block in the cook-cache test.

The loader no longer keeps a decode. It reads the image's size from its header, which costs a few hundred bytes of I/O, builds the `LoadedTexture`, and cooks once in the engine's preferred format so a file that cannot be decoded still fails the load and the derived file is warm before any scene asks.

```rust
pub(crate) fn decode_image_file(path: &Path) -> Result<LoadedTexture, String> {
    let shown = path.display();
    let cap = max_texture_size();
    let (source_width, source_height) = image::ImageReader::open(path)
        .map_err(|error| format!("could not read '{shown}': {error}"))?
        .with_guessed_format()
        .map_err(|error| format!("could not read '{shown}': {error}"))?
        .into_dimensions()
        .map_err(|error| format!("could not decode '{shown}': {error}"))?;
    let (width, height) = capped_dimensions(source_width, source_height, cap);
    let texture = LoadedTexture { width, height, source: path.to_path_buf(), cap, cooked: Default::default() };
    // Cook now, on this loader thread: a file that cannot be decoded fails
    // the load here, and the derived-data cache is warm for later.
    texture.cooked(preferred_cook_format())?;
    Ok(texture)
}
```

### 4.2 The cap, applied early

Memory was the thing we had measured, and a 4096 by 4096 source decoded at full size is 64 MiB. A project setting, `streaming.max_texture_size`, clamps the larger side at 2048 by default, with zero meaning no cap. A cap alone is easy. Applying it at the right moment takes one decision.

```rust
fn decode_rgba(path: &std::path::Path, cap: u32) -> Result<(u32, u32, Vec<u8>), String> {
    let shown = path.display();
    let bytes = std::fs::read(path).map_err(|e| format!("could not read '{shown}': {e}"))?;
    let mut decoded = image::load_from_memory(&bytes)
        .map_err(|e| format!("could not decode '{shown}': {e}"))?;
    drop(bytes);
    let (width, height) = (decoded.width(), decoded.height());
    if width == 0 || height == 0 {
        return Err(format!("'{shown}' has empty dimensions"));
    }
    let (scaled_width, scaled_height) = capped_dimensions(width, height, cap);
    if (scaled_width, scaled_height) != (width, height) {
        decoded = decoded.resize_exact(
            scaled_width,
            scaled_height,
            image::imageops::FilterType::Triangle,
        );
    }
    let rgba = decoded.to_rgba8();
    Ok((rgba.width(), rgba.height(), rgba.into_raw()))
}
```

The resize runs on the `DynamicImage` before `to_rgba8()`. A 4K JPEG decodes as RGB8, 48 MiB. Converting first would build the 64 MiB RGBA buffer and then shrink it to 16 MiB. Shrinking first resizes the 48 MiB image and converts the 12 MiB result, so the transient peak on the worker drops from 112 MiB to about 60 MiB, and several workers decoding at once stop being a spike. The compressed file bytes are dropped as soon as the decoder has them.

```rust
pub(crate) fn capped_dimensions(width: u32, height: u32, cap: u32) -> (u32, u32) {
    let longest = width.max(height);
    if cap == 0 || longest <= cap {
        return (width, height);
    }
    let scale = f64::from(cap) / f64::from(longest);
    (
        ((f64::from(width) * scale).round() as u32).max(1),
        ((f64::from(height) * scale).round() as u32).max(1),
    )
}
```

Triangle filtering is fast and adequate for a halving. It filters in sRGB space, which is not strictly correct for color. We noted it and left it.

### 4.3 Cooking

The cook takes straight-alpha sRGB RGBA8 at the capped size and returns one blob: a full mip chain, in the format the device wants. Three decisions shape it.

Mips are averaged in linear light. A mip level is the average of 2 by 2 texels of the level above. The average of an sRGB-encoded black and white texel is not a mid-grey in sRGB. Half the light is about 188 as an sRGB byte, where a naive byte average gives 127 and darkens every distant surface. So each tap goes through a 256-entry table to linear, the four are summed, and the result goes back through a table fine enough that its quantisation sits under one output step.

```rust
fn downsample(source: &[u8], width: u32, height: u32,
              to_linear: &[f32; 256], to_srgb: &LinearToSrgb) -> (u32, u32, Vec<u8>) {
    let (new_width, new_height) = ((width / 2).max(1), (height / 2).max(1));
    let mut out = Vec::with_capacity(new_width as usize * new_height as usize * 4);
    for y in 0..new_height {
        let (y0, y1) = ((2 * y).min(height - 1), (2 * y + 1).min(height - 1));
        for x in 0..new_width {
            let (x0, x1) = ((2 * x).min(width - 1), (2 * x + 1).min(width - 1));
            let taps = [(x0, y0), (x1, y0), (x0, y1), (x1, y1)];
            let mut sum = [0.0f32; 4];
            for (tx, ty) in taps {
                let at = (ty as usize * width as usize + tx as usize) * 4;
                for channel in 0..3 {
                    sum[channel] += to_linear[source[at + channel] as usize];
                }
                sum[3] += f32::from(source[at + 3]) / 255.0;
            }
            for channel in 0..3 {
                out.push(to_srgb.encode(sum[channel] * 0.25));
            }
            out.push((sum[3] * 0.25 * 255.0 + 0.5).clamp(0.0, 255.0) as u8);
        }
    }
    (new_width, new_height, out)
}
```

Alpha is stored linear already, so it averages as it is. An odd edge reuses its last row or column through the `min` clamps, which is the cheapest rule that keeps a flat image flat. A test cooks a 5 by 3 solid colour, which has three levels, and checks that the last one is still that colour.

BC7 needs whole blocks, so levels pad up and the base must already be whole. A level whose size is not a multiple of 4 is padded by repeating its last row and column before it goes to the encoder, so a partial block encodes as a clean one. The base level cannot be padded without changing the texture's size, and wgpu requires level zero of a compressed texture to be a multiple of the block size, so `cook` refuses BC7 for a width or height that is not divisible by 4 and `CookFormat::best_for` does not choose it.

```rust
pub fn best_for(features: wgpu::Features, width: u32, height: u32) -> Self {
    if features.contains(wgpu::Features::TEXTURE_COMPRESSION_BC)
        && width % 4 == 0
        && height % 4 == 0
    {
        CookFormat::Bc7
    } else {
        CookFormat::Rgba8
    }
}
```

An image of 30 by 18 is cooked uncompressed, with its chain, and the test for it checks the format that comes back.

The encoder is Intel's ISPC texture compressor through `intel_tex_2`, from Traverse Research, who also wrote `gpu-allocator`. It ships prebuilt kernels, so it needs no ISPC toolchain. Opaque images use the opaque settings and anything with an alpha below 255 uses the alpha settings, both at the "fast" profile. The profile is a constant in the code. Changing it means bumping `COOK_VERSION`, which is part of the derived key, so every cooked file made under the old profile becomes a miss.

```rust
fn compress_bc7(rgba: &[u8], width: u32, height: u32, opaque: bool) -> Vec<u8> {
    let (padded_width, padded_height, padded) = pad_to_blocks(rgba, width, height);
    let surface = RgbaSurface {
        data: &padded,
        width: padded_width,
        height: padded_height,
        stride: padded_width * 4,
    };
    let settings = if opaque { bc7::opaque_fast_settings() } else { bc7::alpha_fast_settings() };
    bc7::compress_blocks(&settings, &surface)
}
```

The result is one container. A magic, a format code, the size, the level count and each level's byte length, then the levels. The reader is the part worth showing, because it is the reason a damaged or outdated file is refused instead of uploaded.

```rust
pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
    // ... read magic, format, width, height, count ...
    if width == 0 || height == 0 || count != mip_level_count(width, height) {
        return Err("cooked texture has an impossible size".into());
    }
    let mut offset = 20 + 4 * count as usize;
    let mut levels = Vec::with_capacity(count as usize);
    for level in 0..count {
        let length = word(20 + 4 * level as usize)? as usize;
        let (lw, lh) = level_extent(width, height, level);
        if length != level_bytes(format, lw, lh) {
            return Err(format!("cooked texture level {level} has the wrong length"));
        }
        // ...
        offset += length;
    }
    if bytes.len() != offset {
        return Err("cooked texture has the wrong total length".into());
    }
    // ...
}
```

Every level's recorded length has to equal what its format and extent require, and the total has to be exact. That is the same arithmetic `register_mips` checks again at upload, so a blob that gets this far cannot be a size the store refuses.

What the cook buys, for a 2048 by 2048 image:

| Form | Bytes |
|---|---:|
| RGBA8, one level, what we uploaded before the cook | 16.0 MiB |
| RGBA8 with a full chain | 21.3 MiB |
| BC7 with a full chain | 5.3 MiB |

Seven unit tests check sizes, the linear-light average, odd sizes, the block rounding and the container's refusals. Sizes do not prove the blocks decode to the right colours, though, and the only honest check of that is to put a cooked texture on the GPU and look at what a shader reads.

```rust
@compute @workgroup_size(1)
fn main() {
    let levels = i32(textureNumLevels(tex));
    for (var level = 0; level < levels; level = level + 1) {
        out[level] = textureLoad(tex, vec2<i32>(0, 0), level);
    }
}
```

The test cooks an 8 by 8 solid colour, uploads it through `register_mips`, runs that shader, and compares texel zero of every level with the colour that went in, converted from sRGB to linear light because the format decodes that way on read.

```rust
fn check_solid_colour(gpu: &Gpu, format: CookFormat, tolerance: f32) {
    let texel = [200u8, 100, 50, 255];
    let cooked = cook(&solid(8, 8, texel), 8, 8, format).unwrap();
    let expected = [
        srgb_to_linear(texel[0]),
        srgb_to_linear(texel[1]),
        srgb_to_linear(texel[2]),
        1.0,
    ];
    let levels = sample_levels(gpu, &cooked);
    assert_eq!(levels.len(), 4);
    for (level, sampled) in levels.iter().enumerate() {
        assert!(
            close(*sampled, expected, tolerance),
            "{} level {level}: shader read {sampled:?}, expected about {expected:?}",
            format.label()
        );
    }
}
```

The uncompressed form has to match within 0.003, which is rounding. BC7 has to match within 0.02, a couple of output steps, and does, at every level down to the 1 by 1. A second BC7 test cooks a black and white checkerboard and reads the top level, which must be half the light: 0.5 within 0.06. That one covers the mip filter and the encoder together, since a gamma-space average would land near 0.21 and fail it.

### 4.4 One upload per device

This is where `register_shared` earns its place. Helio keeps a process-wide table of textures it has already uploaded, keyed by the device and the texture's asset identity.

```rust
struct SharedTexture {
    version: u64,
    texture: wgpu::Texture,
    /// The stores holding a clone; the entry goes when none is left.
    users: Vec<std::sync::Weak<std::sync::RwLock<pulsar_scenedb::gpu::TextureStore>>>,
}

type SharedTextures = std::collections::HashMap<(usize, AssetId), SharedTexture>;

fn shared_texture(
    key: (usize, AssetId),
    version: u64,
    store: &Arc<std::sync::RwLock<pulsar_scenedb::gpu::TextureStore>>,
) -> Option<wgpu::Texture> {
    let mut shared = shared_textures().lock().ok()?;
    // Forget textures no store holds any more, so a dropped scene's images
    // can be freed.
    shared.retain(|_, entry| {
        entry.users.retain(|user| user.strong_count() != 0);
        !entry.users.is_empty()
    });
    let entry = shared.get_mut(&key)?;
    if entry.version != version {
        return None;
    }
    let me = Arc::downgrade(store);
    if !entry.users.iter().any(|user| user.ptr_eq(&me)) {
        entry.users.push(me);
    }
    Some(entry.texture.clone())
}
```

The device key is the address of the `Arc<wgpu::Device>`. Two scenes on one device resolve to one key and two scenes on two devices do not collide. The version is the material's content version, so a reloaded texture breaks the share and the next scene to ask uploads the new bytes.

`resident_slot` does the work. It checks the per-store table first, then asks whether another scene on the device has the texture, and only fetches the cooked texture when neither does. The format it asks for comes from the device: BC7 where the device has the feature and the size allows it, RGBA8 otherwise.

```rust
pub(crate) fn resident_slot(
    id: AssetId, version: u64, image: &LoadedTexture,
    mirror: &pulsar_scenedb::gpu::GpuMirrorHandle,
) -> Result<u32, String> {
    let texture_store = mirror.texture_store()
        .ok_or_else(|| "SceneDB has no texture store".to_string())?;
    let key = (Arc::as_ptr(&texture_store) as usize, id);
    { /* per-store hit at this version: return the slot */ }

    // Not in this store yet. Another scene on the same device may have
    // uploaded it; otherwise the cooked texture may have to be read from the
    // derived file or cooked again, which takes a while. Either way, no lock
    // is held while finding out.
    let device = mirror.store().device_arc();
    let device_key = (Arc::as_ptr(&device) as usize, id);
    let shared = shared_texture(device_key, version, &texture_store);
    let cooked = match shared {
        Some(_) => None,
        None => Some(image.cooked(CookFormat::best_for(
            device.features(), image.width, image.height))?),
    };

    // ... take the residency map and the store's write lock ...
    let (slot, uploaded) = match (shared, cooked) {
        (Some(texture), _) => (
            store.register_shared(texture)
                .map_err(|e| format!("could not share a texture: {e:?}"))?,
            None,
        ),
        (None, Some(cooked)) => {
            let slot = crate::material_textures::upload_cooked(&mut store, mirror, &cooked)?;
            (slot, store.texture(slot).cloned())
        }
        (None, None) => unreachable!("the cooked texture is fetched whenever nothing is shared"),
    };
    // ... record the slot; publish a fresh upload to the shared table ...
    Ok(slot)
}
```

Look at what the shared branch skips. It does not call `image.cooked()`, so the second scene never asks the residency cache for the texture. If the first scene's upload pushed it out under budget pressure, the second scene does not bring it back, and the read of the derived file that would have followed never happens.

The lock order here matches the one in Residency. The fetch of the cooked texture runs with no lock held, and the table locks are taken afterward in a fixed sequence, with the shared table touched in short separate sections that never nest inside the others.

A material with four images has four of these to do, one after another, on the thread that is about to draw it. That is the case `prefetch` was built for. Before `compiled_graph` loops over a material's textures, it asks which of them this store would actually have to upload, and starts those cooking side by side on the loader threads.

```rust
pub(crate) fn prefetch_missing<'a>(
    images: impl IntoIterator<Item = (AssetId, &'a LoadedTexture)>,
    version: u64,
    mirror: &pulsar_scenedb::gpu::GpuMirrorHandle,
) {
    let Some(texture_store) = mirror.texture_store() else { return };
    let device = mirror.store().device_arc();
    let features = device.features();
    for (id, image) in images {
        let key = (Arc::as_ptr(&texture_store) as usize, id);
        let held = resident().lock().ok()
            .and_then(|r| r.get(&key).map(|entry| entry.version == version))
            .unwrap_or(false);
        let shared = shared_textures().lock().ok()
            .and_then(|s| s.get(&(Arc::as_ptr(&device) as usize, id)).map(|e| e.version == version))
            .unwrap_or(false);
        if !held && !shared {
            drop(image.prefetch(CookFormat::best_for(features, image.width, image.height)));
        }
    }
}
```

A texture the store already holds, or that another scene on the device has uploaded, is skipped, because nothing about it would be used. Cooking it anyway would spend a decode to produce bytes nobody reads. The handles are dropped on purpose. The flights keep running, and the `resident_slot` calls that follow join them.

### 4.5 The life of a shared entry

The lookup in 4.4 is the easy half. The table has a life of its own, and four things about it took more thought than the code suggests.

Publishing. Only a scene that actually uploaded a texture adds an entry, and it does so after releasing the store and residency locks, using the clone it took right after the upload.

```rust
    drop(store);
    drop(resident);
    if let (Some(texture), Ok(mut shared)) = (uploaded, shared_textures().lock()) {
        shared.insert(
            device_key,
            SharedTexture {
                version,
                texture,
                users: vec![Arc::downgrade(&texture_store)],
            },
        );
    }
    Ok(slot)
```

`insert` replaces whatever entry the key held, which is how versions move forward. Suppose two scenes show a texture at version 1 and the file changes. The first scene to resolve version 2 misses the shared lookup because the entry says 1. It fetches the cooked texture, reading it from the derived file or cooking it again if neither cache has it, uploads, and publishes version 2 over the old entry. The second scene arrives, fails its own per-store check because its slot still holds version 1, and finds the new entry. It adopts it with `register_shared`. N scenes follow one reload with one upload. Each scene gives its old slot back before taking the new one, so the version 1 texture is freed when the last scene stops pointing at it.

Retention. The entry holds a clone of the texture, so the table itself keeps a GPU allocation alive. Every `shared_texture` call starts by pruning, and an entry whose `users` list has no live store left is removed.

```rust
shared.retain(|_, entry| {
    entry.users.retain(|user| user.strong_count() != 0);
    !entry.users.is_empty()
});
```

Users are `Weak` references to the `Arc<RwLock<TextureStore>>`, so the table never extends a scene's life. The pruning is lazy, which means a scene that closes leaves its textures allocated until the next lookup anywhere runs the sweep. That window is as long as the gap between texture resolutions, usually short and in principle unbounded. A drop hook on the store would close it, and the store lives in SceneDB, so that belongs to a later change there.

Identity. The key uses the address of the device's `Arc` as its device half. Addresses get reused, so a key built from one needs an argument for why a new device cannot land on a dead one's key and be handed its textures. The argument we can make today is about lifetimes. A scene's texture store lives with its mirror, the mirror's `SceneGpuStore` holds the device `Arc`, and an entry is only returned to a store that is asking on a live device. While any store that used the entry is alive, so is the `Arc` its key points at. We have not proven that for a store that outlives its mirror, which SceneDB allows, because the store holds textures and not the wrapper `Arc`. A process-unique id minted when the GPU context is created would replace the address and remove the question, and we would rather have the id than the argument.

Races. Two scenes on two threads can both miss the shared lookup for the same texture at the same moment, and both decode and upload. The second publish replaces the first. The loser's texture then lives only in the store that uploaded it, a duplicate until that scene lets go. As far as we can tell each scene resolves its materials on its own derivation thread, the window is small, and we left it. Closing it would mean holding the shared lock across a decode, and the lock that guards every texture lookup in the process is the wrong place to wait for a JPEG.

What stays per scene. Sharing covers textures. The exported GPU report shows what it does not cover.

```text
| scenedb-var-len-pool-"builtin_mesh_vertex" | 2 | 80.1 MiB | 160.1 MiB |
| Dynamic shadow atlas                       | 2 | 64.0 MiB | 128.0 MiB |
| gbuffer_normal                             | 2 | 17.6 MiB |  35.1 MiB |
```

Render targets and shadow atlases belong to a renderer, and two viewports want two sets. The mesh vertex pool is different. It shows up once per scene, which suggests it belongs to each scene's `SceneGpuStore`, so two scenes showing the same mesh would hold the geometry twice. Sharing it is a SceneDB question about pool ownership and not a renderer one, and section 6.4 says why it stays out of this work.

### 4.6 Policy stays in the engine

SceneDB exposes the budget as a setter and Helio exposes the cap as a function. The numbers belong to the engine and to the project, so they are read where the engine already reads its streaming settings, next to the existing VRAM tier budget.

```rust
// engine_backend/src/scene/helio_bridge.rs
let cpu_cache_bytes = int_of(streaming("cpu_cache_mb"))
    .unwrap_or(1024)
    .clamp(64, 65_536) as usize
    * 1024
    * 1024;
pulsar_scenedb::set_residency_budget(cpu_cache_bytes);
```

| Project setting (`streaming`) | Default | Governs |
|---|---|---|
| `max_texture_size` | 2048 | Largest decoded side. Zero disables. |
| `cpu_cache_mb` | 1024 | Residency budget for rebuildable data |
| `derived_cache_mb` | 4096 | Disk budget for derived files, pruned least recently used first |
| `texture_stream_pool_mb` | 512 | The existing SceneDB VRAM tier budget |

SceneDB's own default budget stays at 512 MiB. A database with no engine around it should be conservative, and the engine sets what suits its workload.

Two other settings are not project settings, because the device decides them. The editor asks the adapter for `TEXTURE_COMPRESSION_BC` as an optional feature, so a GPU without it still starts, and the bridge reads the device's features once and tells the texture loader which format to cook first.

```rust
helio_component::texture_assets::set_preferred_cook_format(
    if device.features().contains(wgpu::Features::TEXTURE_COMPRESSION_BC) {
        helio_component::cooked_texture::CookFormat::Bc7
    } else {
        helio_component::cooked_texture::CookFormat::Rgba8
    },
);
install_derived_cache();
```

`install_derived_cache` points SceneDB at `<project>/.pulsar/cache/derived`, once per process, and prunes it on a background thread. A texture loaded before the preference is set cooks as RGBA8 and cooks a BC7 form on first use. It costs one extra cook that the derived cache then remembers.

### 4.7 The test that checks the second scene did nothing

The unit test builds two scenes on one real device and checks the claims above in order.

```rust
let slot_a = resident_slot(id, 1, &image, &scene_a).unwrap();

// Drop the CPU copy: if the second scene needed the cooked texture it
// would have to read or cook it again.
pulsar_scenedb::set_residency_budget(1);
let filler = decode_image_file(&path).unwrap();
assert!(!image.is_resident() && filler.is_resident());

let slot_b = resident_slot(id, 1, &image, &scene_b).unwrap();
assert!(!image.is_resident(), "the second scene shared the upload and never needed the texture");
// What reached the GPU is the cooked form: BC7 where the device can sample
// it, uncompressed otherwise, and either way the full chain.
let uploaded = a.texture(slot_a).unwrap();
assert_eq!(uploaded.format(), expected);
assert_eq!(uploaded.mip_level_count(), 4, "an 8x8 image has four levels");
assert_eq!(a.upload_count(), 1);
assert_eq!(b.upload_count(), 0, "the second store uploaded nothing");

// A new content version is a new upload, not a stale share.
let slot_b2 = resident_slot(id, 2, &image, &scene_b).unwrap();
assert_eq!(b.upload_count(), 1, "version 2 uploaded afresh");
assert_ne!(textures_a.texture(slot_a), b.texture(slot_b2));
```

A budget of one byte forces the first image out as soon as a second one arrives. The assertion that `image.is_resident()` is still false after the second scene resolves its slot is the proof that nothing was read or cooked. A hit on the shared table and a rebuild would otherwise look the same from outside. The device in that test requests block compression where the adapter has it, as the editor does, so on a machine with BC support the same test also checks that the texture on the GPU is BC7 with its full four-level chain.

## Part 5: What changed in the engine

### 5.1 How we saw it

None of the numbers below were guesses, and getting them took an instrument we did not have the week before. Mission Control gained a Memory Explorer tab, off by default behind a tracking switch, with three views. The heap view lists live allocations above a threshold with 48-frame stacks. The process view walks the address space with `VirtualQuery`. The GPU view calls `Device::generate_allocator_report()` on the engine's devices and groups wgpu's allocations by name.

The GPU view is what showed the second problem. After the residency change and the cap, the Resources panel read about 3.5 GB of memory and 6 GB of VRAM. A 2048 cap leaves each texture a quarter of its former size, and 6 GB was harder to explain than it should have been. The exported report said where it went.

| Allocation | Count | Each | Total |
|---|---:|---:|---:|
| Scene Texture | 156 | 16.0 MiB | 2.44 GiB |
| graph material texture | 3 | 64.0 MiB | 192.0 MiB |

One hundred fifty-six is twice seventy-eight. The engine log had two `Initializing Helio renderer...` lines and two `SceneDB GPU mirror attached` lines, because the level was open in two viewports, and each scene's store had uploaded the whole set. The cache statistics in the same report carried a second symptom of the same cause.

```text
## Rebuildable-data cache (SceneDB residency)
| budget    | 1.00 GiB                  |
| resident  | 1.00 GiB in 64 values     |
| evictions | 203                       |
| rebuilds  | 111                       |
```

A budget of 1 GiB holds sixty-four 16 MiB images. Seventy-eight textures do not fit. The likely source of the 111 rebuilds is a second scene asking for texels the first had pushed out, though the counters do not say which scene asked. After `register_shared`, a second scene on the device no longer asks the cache for texels at all.

The other row in the table, `graph material texture` at 64 MiB each, came from the shader editor's preview renderer, which decoded at full resolution to draw a sphere a few hundred pixels across. It got its own cap of 1024.

### 5.2 The numbers

Three instruments appear here and they do not measure the same thing, so the table names the source of each figure.

| Stage | Figure | Source |
|---|---|---|
| Before | 78 decodes, 4.88 GiB live on the heap | Heap tracker, 64 MiB each |
| Before | 14.4 GB private, 7.2 GB dedicated GPU | `VirtualQuery`, Windows GPU counters |
| After residency and cap | 3,473 MB memory, 6,038 MB VRAM | Resources panel |
| After shared uploads | 2,784 MB memory, 3,729 MB VRAM | Resources panel |

Between the last two rows, which use the same instrument, memory fell by 689 MB and VRAM by 2,309 MB, which is 20 and 38 percent. The change in that step was `register_shared` plus the preview cap. Our arithmetic expected about 1.4 GB of the VRAM drop from those two. The observed figure is larger, and we have not accounted for the difference. A fresh exported report of the new build will split it by allocation name, and until then the extra gigabyte stays unexplained.

### 5.3 What a miss costs

Residency turns a standing cost into a variable one. A texture that is resident costs nothing. A texture that was evicted has to come back, and before the Disk tier existed that meant a decode, a resize and, once we cooked, an encode, on whichever thread asked. We read the 111 rebuilds in the report from before the cook as that cost: a 1 GiB budget against a 1.25 GiB working set, with two scenes asking.

A miss is now a file read. The cooked form of a 2048 by 2048 texture is 5.3 MiB, and reading it back and checking it is a few milliseconds. The measurements are in 5.4. What is left of the old concern is the first time a project is ever opened, when nothing is cooked yet. That cost is real, it is about a second per texture, and it lands on the loader threads, where `prefetch` lets a material's textures cook side by side. It is paid once per texture per project, not once per session.

Shared uploads cut the multiplier from scenes. They did nothing about the working set, and they were not meant to. The cooked form changes the arithmetic of the working set itself. Seventy-eight textures at 5.3 MiB are about 416 MiB, which fits inside the 1 GiB default with room for several times as many. That is arithmetic from the sizes above and not a measurement of the editor, which we have not run on this build.

### 5.4 The cook, measured

The numbers in 5.2 come from the editor. These come from a test that loads real files. It is ignored by default and takes a list of images in an environment variable, so anyone can run it on their own project: `real_texture_cook.rs` in `helio-component/tests`. We ran it in a release build on four of the 4096 by 4096 JPEGs from the project that started this, with the size cap at its default of 2048 and BC7 as the preferred format.

| Image (4096 x 4096 JPEG) | Source | First load | Reload | Rebuild after eviction | BC7 with chain |
|---|---:|---:|---:|---:|---:|
| riiveayqx_4K_BaseColor | 1.8 MiB | 1022 ms | 7.4 ms | 4.0 ms | 5.33 MiB |
| rlctbdhqx_4K_BaseColor | 1.6 MiB | 4 ms (cooked earlier in the run) | 4.0 ms | 3.6 ms | 5.33 MiB |
| tgmsdc0fa_4K_BaseColor | 1.3 MiB | 1026 ms | 7.5 ms | 3.0 ms | 5.33 MiB |
| phhibtp2_4K_Albedo | 0.4 MiB | 904 ms | 7.7 ms | 2.9 ms | 5.33 MiB |

First load decodes the JPEG, scales it to 2048, builds the mip chain, encodes BC7 and writes the derived file. Reload is a second `LoadedTexture::load` of the same file, which reads that derived file. Rebuild after eviction is what the residency cache does when it dropped the value and something asks again. The second row's first load is a hit because the test used that image as the filler that forces the eviction of the first, so it had been cooked a moment earlier.

Three cooks took 0.9 to 1.0 seconds each. A reload took 4 to 8 milliseconds, and a rebuild after eviction 3 to 4. Against a first load of about a second, a reload is roughly 120 to 140 times faster and a rebuild after eviction 225 to 350 times. The files were in the operating system's page cache during the run, so a cold read from a slow disk would cost more, and those ratios are upper bounds.

| Form of one 2048 x 2048 texture | Size |
|---|---:|
| RGBA8, one level, what the GPU got before | 16.00 MiB |
| RGBA8 with a full mip chain | 21.33 MiB |
| BC7 with a full mip chain | 5.33 MiB |

The four test images came to 21.3 MiB as BC7 and 85.3 MiB as RGBA8 with chains. Before the size cap each was a 64 MiB RGBA8 decode, so the same four were 256 MiB. The derived cache finished the run with 8 cooked results written, 106.7 MiB, which is two formats for each of four images, and 12 hits.

What this does not show is the editor's memory with the cook in it. Those figures need a run on the new build, and the Memory Explorer now reports the derived-data cache and the residency cache's prefetch and join counters, so the next exported report will carry them.

## Part 6: What SceneDB can do now

### 6.1 Any kind can ask for this

Nothing in `Residency<T>` or `derive_cached` mentions images. A mesh kind could use both the same way. This is a sketch against the API above, and none of it exists in the engine yet.

```rust
// How a mesh kind could hold baked geometry.
struct LoadedMesh {
    bounds: Aabb,
    geometry: pulsar_scenedb::Residency<MeshGeometry>,
}

fn load_mesh(source: &str) -> Result<AssetPayload, String> {
    let path = std::path::PathBuf::from(source);
    // Parse and bake once, keep the baked form on disk, and rebuild it from
    // there whenever the residency cache drops it.
    let build = move || -> Result<MeshGeometry, String> {
        let request = pulsar_scenedb::DerivedRequest {
            kind: "mesh",
            source: &path,
            settings: "lods=on",
            version: 1,
        };
        let bytes = pulsar_scenedb::derive_cached(&request, || parse_and_bake(&path))?;
        MeshGeometry::from_bytes(&bytes)
    };
    let geometry = build()?;
    Ok(Arc::new(LoadedMesh {
        bounds: geometry.bounds(),
        geometry: pulsar_scenedb::Residency::with_value(
            geometry,
            |g: &MeshGeometry| g.byte_size(),
            build,
        ),
    }))
}
```

The part of a payload a binding needs on every frame, the bounds here, stays in the struct. The bulk that is needed when something is built or rebuilt sits behind `get()`, and a miss reads a baked file and skips the parse.

### 6.2 Where it sits among the tiers

SceneDB already has a tier engine for fields. It moves data between Disk, RAM and VRAM under budgets with LRU eviction and generation-guarded handles, and the editor configures its VRAM budget at startup with an empty list of textures to materialize. The tier engine manages fields and pool payloads that live inside the database. Residency and the derived-data cache manage the payloads that assets carry, which until now had no tier at all. In the vocabulary of the last post, this is the system-RAM tier for assets, with a disk tier underneath it and the source file under that.

The two meet at one more seam. `TextureStore::register_key` already reserves the bindless array's name in the keyed `GpuBufferRegistry`, so the texture table is a resident of the same registry as every row buffer. The VRAM budget for texture detail in section 6.3 measures that registry's per-device table, and the sharing added here is what makes it count the right thing: one allocation per texture and device, however many scenes show it.

### 6.3 The list we wrote down, and what happened to it

When the cook first worked there was a list of things it did not do yet. Most of that list is done now. Four items are finished, one is finished in a smaller form than we first planned, and one stops at a boundary that section 6.4 explains. They are in the order they were fixed.

**What a texture is used for decides how it is stored.** Before this, every cooked texture was sRGB. A roughness map is a grid of numbers, and an sRGB format makes the GPU apply a gamma curve to those numbers on read, so a roughness of 0.5 arrived as 0.21. The cook now takes a second argument.

```rust
pub enum TextureUse {
    /// Colour the eye sees: base colour, emissive. sRGB on read.
    Color,
    /// Numbers in the channels: roughness, metallic, occlusion, opacity.
    /// Stored linear, mips averaged as plain numbers.
    Data,
    /// A tangent-space normal map. Stored linear; each mip level is
    /// renormalised after averaging.
    Normal,
}

pub fn wgpu_format(format: CookFormat, usage: TextureUse) -> wgpu::TextureFormat {
    match (format, usage.is_srgb()) {
        (CookFormat::Rgba8, true) => wgpu::TextureFormat::Rgba8UnormSrgb,
        (CookFormat::Rgba8, false) => wgpu::TextureFormat::Rgba8Unorm,
        (CookFormat::Bc7, true) => wgpu::TextureFormat::Bc7RgbaUnormSrgb,
        (CookFormat::Bc7, false) => wgpu::TextureFormat::Bc7RgbaUnorm,
    }
}
```

The information lives in the material graph, as we guessed, and the graph already knows it. `texture_uses` walks back from each pin of the fragment output through the nodes feeding it, and a sampler that reaches `roughness` is data, one that reaches `normal` is a normal map, and everything else is colour. A texture that feeds several pins takes the strongest use, with colour winning, which is how every texture behaved before uses existed, so no existing material changes meaning by accident.

The use is part of the identity of a cooked texture. The derived-data key includes it, `LoadedTexture` keeps one residency per format and use, and the per-device sharing table from section 4.4 is keyed by asset and use, so one image sampled as colour in one material and as data in another becomes two GPU textures and neither is wrong. The test for it asks the GPU. It cooks a texel of (200, 100, 50), uploads it as data, and reads it back through a compute shader. The shader must see 200/255, 100/255 and 50/255, and the test also asserts the values are not the gamma-decoded ones. The same check runs for BC7 and for a unit-length normal, whose mips must stay unit length after the averaging.

BC5 was the other half of that item, and we did not use it. BC5 stores two channels and rebuilds the third in the shader, which means the material compiler has to emit a different sampling expression for every normal map. BC7 in a linear format keeps all four channels and keeps the existing shader code as it is, at the same sixteen bytes per block. The cost is the memory BC5 would have saved on normals, half of each normal texture. We think that is the right order for now, and it is a change that can be made later without touching anything but the cook and the shader snippet.

**The sampler is trilinear, anisotropic and repeating.** The editor was reading every material texture through wgpu's default sampler, nearest filtering and clamp-to-edge. That default undoes much of what mips are for, and it stops a texture from tiling past the unit square. The engine now builds the sampler from three project settings and installs it right after the renderer is built.

```rust
// engine_backend/src/subsystems/render/helio_renderer/material_sampler.rs
pub fn descriptor(&self) -> wgpu::SamplerDescriptor<'static> {
    let (texel, mip, anisotropy) = match self.filter {
        Filter::Trilinear => (
            wgpu::FilterMode::Linear,
            wgpu::MipmapFilterMode::Linear,
            self.anisotropy.max(1),
        ),
        Filter::Bilinear => (wgpu::FilterMode::Linear, wgpu::MipmapFilterMode::Nearest, 1),
        Filter::Nearest => (wgpu::FilterMode::Nearest, wgpu::MipmapFilterMode::Nearest, 1),
    };
    // ...address mode from the wrap setting...
}
```

wgpu refuses an anisotropy above one unless all three filters are linear, so the descriptor only applies it for trilinear filtering. A pixel-art project sets the filter to nearest and gets a valid sampler with no anisotropy. The defaults are trilinear, 8x and repeat. The settings are `texture_filter`, `texture_anisotropy` and `texture_wrap` under `streaming`, and unknown values fall back to the defaults. One test builds a sampler for every combination on a real device, inside a validation error scope, because wgpu reports an invalid descriptor by panicking in some configurations, and a default that panics would stop the editor at startup.

**Prefetch reaches every caller that binds a material.** The earlier text said `compiled_graph` prefetched and nobody else did. `bind_mesh_material` now calls a `warm` step before it binds, which starts the cook of every texture the material will upload and does not wait for any of them. By the time the first `resident_slot` runs, the other three are already cooking on the loader threads. A test makes a material with several textures, drops the CPU copies, calls `warm`, and checks that all of them are resident again before anything has asked for them.

**A budget for detail.** This is the item we thought would be the hardest, and the version we built is smaller than the one we described. It does not stream levels in and out per frame. It decides how many of the top levels every texture is allowed to upload, from the total size of what the scenes show.

```rust
// helio-component/src/texture_detail.rs
pub fn bias_for_budget(native_bytes: u64, budget_bytes: u64) -> u32 {
    if budget_bytes == 0 {
        return 0;
    }
    let mut bias = 0;
    while bias < MAX_BIAS && (native_bytes >> (2 * bias)) > budget_bytes {
        bias += 1;
    }
    bias
}
```

Each dropped level divides a texture's bytes by about four, so the bias is the smallest shift that fits the total under `streaming.texture_vram_budget_mb`, which defaults to 3072. The cooked texture learned to cut its own top off.

```rust
pub fn without_top_mips(&self, drop: u32) -> CookedTexture {
    let mut drop = drop.min(self.mip_count().saturating_sub(1));
    if self.format == CookFormat::Bc7 {
        while drop > 0 && ((self.width >> drop) < 4 || (self.height >> drop) < 4) {
            drop -= 1;
        }
    }
    // ...the remaining levels, unchanged, from the new base size...
}
```

It keeps at least one level, and a block-compressed texture keeps a base whose sides are whole blocks, which the GPU requires. The upload path in `resident_slot` takes the bias that is current when a texture is bound, and records it with the slot and with the shared entry. A slot found at a different bias counts as stale, the same way a slot at a different content version does, so a bind after the bias changed uploads again. The total is recomputed from the native sizes in the per-device table every time a texture is uploaded. When a scene closes and the total shrinks, the next bind finds the old bias in its slot, uploads at the new one, and the detail comes back. A GPU test walks through exactly that: a 16 by 16 texture uploads at 16 texels and five levels, at bias one it uploads again at 8 texels and four levels, and at bias zero it returns to 16.

There are limits, and we would rather list them than have them found. The bias is one number for the whole process, so one over-budget scene softens every texture and not just the large ones. It takes effect when a material is next bound, which is when a scene loads or a material changes, and not in the middle of a frame. And nothing picks which textures matter most by distance or screen size, which is what a streaming system proper does. The part that exists is the part SceneDB was missing, a way to hold a texture at fewer levels and to change its mind, with a budget that is measured and tested. Choosing levels per texture by screen footprint is a later change that sits on top of it.

**The hang had a cause.** SceneDB's `gpu_assets` test binary hung intermittently when its tests ran in parallel, in three of five runs on a clean checkout. The tests have no shared state of their own. What they share is the driver, and each of them creates a wgpu device. Fifty-four tests on a default thread count meant several devices being created at the same moment, and on this machine that stalls. A mutex around device creation in the test helpers fixes it, and it is the same mutex pattern in each of the thirty-odd test files that make a device.

```rust
/// Serialises GPU device creation across this file's parallel tests.
static DEVICE_CREATION: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn gpu() -> Option<Gpu> {
    // Creating devices from many tests at once stalls some drivers; take turns.
    let _device_creation = DEVICE_CREATION.lock().unwrap_or_else(|p| p.into_inner());
    // ...instance, adapter, request_device...
}
```

With it, eight parallel runs of `gpu_assets` passed, fifty-four tests each in about a minute, where the unpatched checkout hung. The Helio GPU tests got the same guard. The lock is held only while the device is made and not while the test runs, so it costs nothing once the devices exist. It is a fix in the tests, and a user who creates many devices at once in a real application would hit the same stall. We did not find the driver-level reason and we are not claiming to have.

### 6.4 Where the sharing stops

Sharing covers textures and does not cover meshes. The exported GPU report shows `scenedb-var-len-pool-"builtin_mesh_vertex"` once per scene, so two scenes showing the same mesh hold the geometry twice. That boundary follows from how SceneDB owns buffers, and it is worth seeing why it sits where it does.

A texture is a self-contained device object. Once uploaded, anything on the device can hold a clone of it, which is all `register_shared` needed. A vertex pool is different, because it is wired into the store that owns it. Its buffer is registered in that store's keyed buffer registry, which tracks an epoch so that bind groups rebuild when the buffer is replaced by a larger one. Its allocations are counted by the store's tier engine, and the rows of that scene's components hold offsets into it. If two stores shared one pool, a growth caused by one scene would replace a buffer the other scene's registry still points at, and the tier engine of each store would be making decisions about allocations the other one also uses. Making that safe is a change to how a store owns its buffers, with a consequence for every render pass that binds them, and it is a different piece of work from the one this post describes. Until it is done, geometry costs one copy per scene, and the cooked-texture savings are unaffected by it.

The numbers in this post come from the cook itself, the caches and the GPU tests, and from the Resources panel measurements in section 5.2 taken before the cook. The cooked build's whole-editor figures on the 12 GB project are not in the post. The Memory Explorer reports the derived-data cache and the residency counters, so an exported report from that build will carry them.
